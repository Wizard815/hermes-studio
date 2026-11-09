<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import AgentStatusIcon from '@/components/common/AgentStatusIcon.vue'
import type { HerdrPaneView, HerdrStatusValue, HerdrWorkspace } from '@/api/coding-agents/herdr'
import { rollupStatus } from './useMission'
import type { MissionFolder, TreeChat } from './useFolders'

/**
 * The Spaces tree: Studio's chat folders (same names and nesting as Studio's
 * sidebar) with herdr-space-folders' colors, holding herdr workspaces, each
 * with its agents as leaves. Drag a space onto a folder to file it (its chats
 * move there in Studio too), onto a space to join its folder, a folder onto a
 * folder to nest it, or either onto the bottom zone to take it out.
 */
const props = defineProps<{
  workspaces: HerdrWorkspace[]
  panes: HerdrPaneView[]
  folders: MissionFolder[]
  placeOf: (spaceId: string) => string
  selectedSpace: string
  selectedPane: string
  /**
   * Studio chats that are not running in herdr, listed in their folders (herdr
   * mode passes them; Mission does not). Picking one opens it.
   */
  chats?: TreeChat[]
  selectedChat?: string
}>()

const emit = defineEmits<{
  'select-space': [id: string]
  'select-pane': [id: string]
  'new-space': [folder: MissionFolder | null]
  'new-folder': [parentId: string]
  'edit-folder': [folder: MissionFolder]
  'toggle-folder': [id: string]
  'place-space': [spaceId: string, folderId: string]
  'move-folder': [folderId: string, parentId: string]
  'select-chat': [chat: TreeChat]
}>()

const { t } = useI18n()
const search = ref('')
const expandedSpaces = ref(new Set<string>())
const dragging = ref<{ kind: 'space' | 'folder'; id: string } | null>(null)
const dropTarget = ref('')

type Row =
  | { kind: 'folder'; key: string; depth: number; folder: MissionFolder; count: number; status: HerdrStatusValue }
  | { kind: 'space'; key: string; depth: number; space: HerdrWorkspace }
  | { kind: 'pane'; key: string; depth: number; pane: HerdrPaneView }
  | { kind: 'chat'; key: string; depth: number; chat: TreeChat }
  | { kind: 'chats-group'; key: string; depth: number; count: number }

function panesOf(workspaceId: string): HerdrPaneView[] {
  return props.panes.filter(p => p.workspace_id === workspaceId && p.agent)
}

function label(workspace: HerdrWorkspace): string {
  return workspace.label || workspace.workspace_id
}

function paneName(pane: HerdrPaneView): string {
  return pane.label || pane.terminal_title_stripped || pane.agent || pane.pane_id
}

const matches = computed(() => {
  const q = search.value.trim().toLowerCase()
  return new Set(props.workspaces.filter(w => !q || label(w).toLowerCase().includes(q)
    || panesOf(w.workspace_id).some(p => `${p.label || ''} ${p.terminal_title_stripped || ''} ${p.agent || ''}`.toLowerCase().includes(q)))
    .map(w => w.workspace_id))
})

const knownFolders = computed(() => new Set(props.folders.map(folder => folder.id)))
/** Chats per folder ('' = not in a folder), filtered by the search. */
const chatsByFolder = computed(() => {
  const q = search.value.trim().toLowerCase()
  const map = new Map<string, TreeChat[]>()
  for (const chat of props.chats || []) {
    if (q && !`${chat.title} ${chat.agent}`.toLowerCase().includes(q)) continue
    const folder = knownFolders.value.has(chat.folderId) ? chat.folderId : ''
    map.set(folder, [...(map.get(folder) || []), chat])
  }
  return map
})
/** Chats not in a folder sit in one foldable group at the end. */
const looseChatsOpen = ref(true)

const placement = computed(() => new Map(props.workspaces.map(w => [w.workspace_id, props.placeOf(w.workspace_id)])))

const rows = computed<Row[]>(() => {
  const q = search.value.trim().toLowerCase()
  const children = new Map<string, MissionFolder[]>()
  for (const folder of props.folders) children.set(folder.parentId, [...(children.get(folder.parentId) || []), folder])
  const spacesIn = (folderId: string) => props.workspaces.filter(w => placement.value.get(w.workspace_id) === folderId && matches.value.has(w.workspace_id))
  const subtree = (folder: MissionFolder): HerdrWorkspace[] => [...spacesIn(folder.id), ...(children.get(folder.id) || []).flatMap(subtree)]
  const chatsIn = (folderId: string) => chatsByFolder.value.get(folderId) || []
  const subtreeChats = (folder: MissionFolder): number => chatsIn(folder.id).length + (children.get(folder.id) || []).reduce((n, child) => n + subtreeChats(child), 0)
  const out: Row[] = []
  const pushSpace = (space: HerdrWorkspace, depth: number) => {
    out.push({ kind: 'space', key: `s:${space.workspace_id}`, depth, space })
    if (expandedSpaces.value.has(space.workspace_id)) {
      for (const pane of panesOf(space.workspace_id)) out.push({ kind: 'pane', key: `p:${pane.pane_id}`, depth: depth + 1, pane })
    }
  }
  const walk = (parentId: string, depth: number) => {
    for (const folder of children.get(parentId) || []) {
      const inside = subtree(folder)
      const chatCount = subtreeChats(folder)
      if (q && !inside.length && !chatCount && !folder.name.toLowerCase().includes(q)) continue
      out.push({ kind: 'folder', key: `f:${folder.id}`, depth, folder, count: inside.length + chatCount, status: rollupStatus(inside.map(w => w.agent_status)) })
      if (folder.folded) continue
      walk(folder.id, depth + 1)
      for (const space of spacesIn(folder.id)) pushSpace(space, depth + 1)
      for (const chat of chatsIn(folder.id)) out.push({ kind: 'chat', key: `c:${chat.id}`, depth: depth + 1, chat })
    }
  }
  walk('', 0)
  for (const space of spacesIn('')) pushSpace(space, 0)
  const loose = chatsIn('')
  if (loose.length) {
    out.push({ kind: 'chats-group', key: 'g:chats', depth: 0, count: loose.length })
    if (looseChatsOpen.value) for (const chat of loose) out.push({ kind: 'chat', key: `c:${chat.id}`, depth: 1, chat })
  }
  return out
})

function toggleSpace(id: string) {
  const next = new Set(expandedSpaces.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  expandedSpaces.value = next
}

function selectSpace(id: string) {
  emit('select-space', id)
  if (!expandedSpaces.value.has(id)) toggleSpace(id)
}

function onDragStart(event: DragEvent, kind: 'space' | 'folder', id: string) {
  dragging.value = { kind, id }
  event.dataTransfer?.setData('text/plain', `${kind}:${id}`)
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
}

function onDragEnd() {
  dragging.value = null
  dropTarget.value = ''
}

function onDragOver(event: DragEvent, target: string) {
  if (!dragging.value) return
  event.preventDefault()
  dropTarget.value = target
}

/** A folder cannot go inside itself or its own subfolders. */
function isWithin(folderId: string, ancestorId: string): boolean {
  let current: string | undefined = folderId
  for (let i = 0; current && i < 20; i += 1) {
    if (current === ancestorId) return true
    current = props.folders.find(f => f.id === current)?.parentId
  }
  return false
}

function dropOnFolder(folder: MissionFolder) {
  const drag = dragging.value
  if (!drag) return
  if (drag.kind === 'space') emit('place-space', drag.id, folder.id)
  else if (!isWithin(folder.id, drag.id)) emit('move-folder', drag.id, folder.id)
  onDragEnd()
}

function dropOnSpace(spaceId: string) {
  const drag = dragging.value
  if (drag?.kind === 'space' && drag.id !== spaceId) emit('place-space', drag.id, placement.value.get(spaceId) || '')
  onDragEnd()
}

function dropOut() {
  const drag = dragging.value
  if (drag?.kind === 'space') emit('place-space', drag.id, '')
  else if (drag?.kind === 'folder') emit('move-folder', drag.id, '')
  onDragEnd()
}

const indent = (depth: number) => ({ paddingLeft: `${8 + depth * 18}px` })
</script>

<template>
  <section class="space-tree" data-testid="mission-space-tree">
    <header class="space-tree-head">
      <span>{{ t('mission.spaces') }}</span>
      <span class="space-tree-spacer" />
      <button type="button" class="space-tree-icon" :title="t('mission.newFolder')" data-testid="mission-new-folder" @click="emit('new-folder', '')">
        <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM12 11v6M9 14h6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" /></svg>
      </button>
      <button type="button" class="space-tree-icon" :title="t('mission.newSpace')" @click="emit('new-space', null)">
        <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" /></svg>
      </button>
    </header>
    <input v-model="search" class="space-tree-search" data-theme-surface="input" :placeholder="t('mission.searchSpaces')" />

    <div class="space-tree-body" role="tree">
      <template v-for="row in rows" :key="row.key">
        <div
          v-if="row.kind === 'folder'"
          class="tree-row tree-folder"
          :class="{ 'is-drop': dropTarget === `folder:${row.folder.id}` }"
          :style="indent(row.depth)"
          role="treeitem"
          :aria-level="row.depth + 1"
          :aria-expanded="!row.folder.folded"
          draggable="true"
          data-testid="mission-folder-row"
          @click="emit('toggle-folder', row.folder.id)"
          @dragstart="onDragStart($event, 'folder', row.folder.id)"
          @dragend="onDragEnd"
          @dragover="onDragOver($event, `folder:${row.folder.id}`)"
          @drop.prevent="dropOnFolder(row.folder)"
          @contextmenu.prevent="emit('edit-folder', row.folder)"
        >
          <span class="tree-chevron" :class="{ open: !row.folder.folded }" aria-hidden="true">›</span>
          <span class="folder-tile" :data-color="row.folder.color || 'none'" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="12" height="12"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" fill="currentColor" /></svg>
          </span>
          <span class="tree-name">{{ row.folder.name }}</span>
          <AgentStatusIcon v-if="row.folder.folded && ['blocked', 'done', 'working'].includes(row.status)" :status="row.status" live :size="11" />
          <button type="button" class="tree-action" :title="t('mission.newSubfolder')" @click.stop="emit('new-folder', row.folder.id)">⊞</button>
          <button type="button" class="tree-action" :title="t('mission.newSpaceHere')" @click.stop="emit('new-space', row.folder)">+</button>
          <button type="button" class="tree-action" :title="t('mission.editFolder')" @click.stop="emit('edit-folder', row.folder)">⋯</button>
          <span class="tree-count">{{ row.count }}</span>
        </div>
        <div
          v-else-if="row.kind === 'space'"
          class="tree-row tree-space"
          :class="{ active: row.space.workspace_id === selectedSpace, 'is-drop': dropTarget === `space:${row.space.workspace_id}` }"
          :style="indent(row.depth)"
          role="treeitem"
          :aria-level="row.depth + 1"
          draggable="true"
          data-testid="mission-space-row"
          @click="selectSpace(row.space.workspace_id)"
          @dragstart="onDragStart($event, 'space', row.space.workspace_id)"
          @dragend="onDragEnd"
          @dragover="onDragOver($event, `space:${row.space.workspace_id}`)"
          @drop.prevent="dropOnSpace(row.space.workspace_id)"
        >
          <span class="tree-chevron" :class="{ open: expandedSpaces.has(row.space.workspace_id) }" aria-hidden="true" @click.stop="toggleSpace(row.space.workspace_id)">›</span>
          <AgentStatusIcon :status="row.space.agent_status || 'unknown'" :live="!!row.space.agent_status && row.space.agent_status !== 'unknown'" :size="11" />
          <span class="tree-name">{{ label(row.space) }}</span>
        </div>
        <div
          v-else-if="row.kind === 'chats-group'"
          class="tree-row tree-folder tree-chats-group"
          :style="indent(row.depth)"
          role="treeitem"
          :aria-level="row.depth + 1"
          :aria-expanded="looseChatsOpen"
          data-testid="mission-chats-group"
          @click="looseChatsOpen = !looseChatsOpen"
        >
          <span class="tree-chevron" :class="{ open: looseChatsOpen }" aria-hidden="true">›</span>
          <span class="tree-name">{{ t('mission.otherChats') }}</span>
          <span class="tree-count">{{ row.count }}</span>
        </div>
        <div
          v-else-if="row.kind === 'chat'"
          class="tree-row tree-chat"
          :class="{ active: row.chat.id === selectedChat, 'is-studio-only': !row.chat.hostable }"
          :style="indent(row.depth)"
          role="treeitem"
          :aria-level="row.depth + 1"
          :title="row.chat.hostable ? t('mission.chatOpensInHerdr') : t('mission.chatOpensInStudio')"
          data-testid="mission-chat-row"
          @click="emit('select-chat', row.chat)"
        >
          <svg class="tree-chat-icon" viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><path d="M4 5h16v11H9l-5 4z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" /></svg>
          <span class="tree-name">{{ row.chat.title }}</span>
          <span class="tree-meta">{{ row.chat.agent }}</span>
        </div>
        <div
          v-else
          class="tree-row tree-pane"
          :class="{ active: row.pane.pane_id === selectedPane }"
          :style="indent(row.depth)"
          role="treeitem"
          :aria-level="row.depth + 1"
          data-testid="mission-pane-row"
          @click="emit('select-pane', row.pane.pane_id)"
        >
          <AgentStatusIcon :status="row.pane.agent_status || 'unknown'" live :size="11" />
          <span class="tree-name">{{ paneName(row.pane) }}</span>
          <span class="tree-meta">{{ row.pane.agent }}</span>
        </div>
      </template>

      <div
        v-if="dragging"
        class="tree-dropout"
        :class="{ 'is-drop': dropTarget === 'out' }"
        @dragover="onDragOver($event, 'out')"
        @drop.prevent="dropOut"
      >{{ dragging.kind === 'folder' ? t('mission.dropFolderOut') : t('mission.dropOut') }}</div>
      <p v-if="!workspaces.length && !(chats && chats.length)" class="tree-empty">{{ t('mission.noSpaces') }}</p>
    </div>
  </section>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.space-tree {
  display: flex;
  flex-direction: column;
  min-height: 0;
  gap: 6px;
}

.space-tree-head {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 0 4px;
  font-size: 11.5px;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: $text-muted;
  text-transform: uppercase;
}

.space-tree-spacer {
  flex: 1 1 auto;
}

.space-tree-icon,
.tree-action {
  display: inline-grid;
  place-items: center;
  width: 24px;
  height: 24px;
  border: 0;
  border-radius: var(--radius-component, 6px);
  background: transparent;
  color: $text-muted;
  cursor: pointer;

  &:hover {
    background: rgba(var(--accent-primary-rgb), 0.06);
    color: $text-primary;
  }
}

.tree-chat {
  color: $text-secondary;

  .tree-chat-icon {
    flex: 0 0 auto;
    color: $text-muted;
  }

  &.is-studio-only .tree-name {
    font-style: italic;
  }
}

.space-tree-search {
  margin: 0 4px;
  padding: 5px 8px;
  font-size: 12px;
  color: $text-primary;
  border: var(--border-width, 1px) solid $border-light;
  border-radius: var(--radius-component, 6px);
  outline: none;

  &:focus {
    border-color: $accent-primary;
  }
}

.space-tree-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
}

.tree-row {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 6px 0 8px;
  border-radius: var(--radius-component, 6px);
  color: $text-primary;
  font-size: 13px;
  cursor: pointer;
  user-select: none;

  &:hover {
    background: rgba(var(--accent-primary-rgb), 0.06);
  }

  &.active {
    background: rgba(var(--accent-primary-rgb), 0.12);
    font-weight: 600;
  }

  &.is-drop {
    outline: 1px solid $accent-primary;
    outline-offset: -1px;
  }


  .tree-action {
    width: 20px;
    height: 20px;
    visibility: hidden;
  }

  &:hover .tree-action {
    visibility: visible;
  }
}

.tree-chevron {
  display: inline-block;
  width: 10px;
  color: $text-muted;
  transition: transform 0.12s ease;

  &.open {
    transform: rotate(90deg);
  }
}

.folder-tile {
  display: inline-grid;
  place-items: center;
  flex: 0 0 auto;
  width: 18px;
  height: 18px;
  border-radius: 5px;
  color: var(--text-on-accent);
  background: $text-muted;
}

.folder-tile[data-color="teal"] {
  /* theme-exception: semantic -- Folder tile colors are user-chosen labels shared with herdr-space-folders. */
  background: #22a99a;
}
.folder-tile[data-color="orange"] {
  /* theme-exception: semantic -- Folder tile colors are user-chosen labels shared with herdr-space-folders. */
  background: #e3814f;
}
.folder-tile[data-color="blue"] {
  /* theme-exception: semantic -- Folder tile colors are user-chosen labels shared with herdr-space-folders. */
  background: #5b8def;
}
.folder-tile[data-color="violet"] {
  /* theme-exception: semantic -- Folder tile colors are user-chosen labels shared with herdr-space-folders. */
  background: #8b7cf6;
}
.folder-tile[data-color="green"] {
  /* theme-exception: semantic -- Folder tile colors are user-chosen labels shared with herdr-space-folders. */
  background: #3fae6a;
}
.folder-tile[data-color="pink"] {
  /* theme-exception: semantic -- Folder tile colors are user-chosen labels shared with herdr-space-folders. */
  background: #d9649a;
}

.tree-name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tree-folder .tree-name {
  font-weight: 500;
}

.tree-count,
.tree-meta {
  font-size: 11px;
  color: $text-muted;
}

.tree-dropout {
  margin: 6px 4px;
  padding: 10px;
  text-align: center;
  font-size: 12px;
  color: $text-muted;
  border: 1px dashed $border-light;
  border-radius: var(--radius-component, 6px);

  &.is-drop {
    border-color: $accent-primary;
    color: $text-primary;
  }
}

.tree-empty {
  margin: 8px;
  font-size: 12px;
  color: $text-muted;
}
</style>
