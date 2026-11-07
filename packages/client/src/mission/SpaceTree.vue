<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import AgentStatusIcon from '@/components/common/AgentStatusIcon.vue'
import type { HerdrPaneView, HerdrWorkspace, SpaceFolder, SpaceFolderState } from '@/api/coding-agents/herdr'
import { folderOf, rollupStatus } from './useMission'

/**
 * The Spaces tree: herdr-space-folders' colored, foldable folders holding
 * herdr workspaces, with each workspace's agents as leaves, drawn like
 * Studio's file tree. Drag a space onto a folder to file it, onto a space to
 * join its folder, or onto the bottom zone to take it out.
 */
const props = defineProps<{
  workspaces: HerdrWorkspace[]
  panes: HerdrPaneView[]
  folders: SpaceFolderState
  home: string
  selectedSpace: string
  selectedPane: string
}>()

const emit = defineEmits<{
  'select-space': [id: string]
  'select-pane': [id: string]
  'new-space': [folder: SpaceFolder | null]
  'edit-folder': [folder: SpaceFolder | null]
  'update-folders': [state: SpaceFolderState]
}>()

const { t } = useI18n()
const search = ref('')
const expandedSpaces = ref(new Set<string>())
const dragging = ref<{ kind: 'space' | 'folder'; id: string } | null>(null)
const dropTarget = ref('')

function spaceCwd(workspaceId: string): string {
  const pane = props.panes.find(p => p.workspace_id === workspaceId)
  return pane?.foreground_cwd || pane?.cwd || ''
}

function panesOf(workspaceId: string): HerdrPaneView[] {
  return props.panes.filter(p => p.workspace_id === workspaceId && p.agent)
}

function label(workspace: HerdrWorkspace): string {
  return workspace.label || workspace.workspace_id
}

const filtered = computed(() => {
  const q = search.value.trim().toLowerCase()
  if (!q) return props.workspaces
  return props.workspaces.filter(w => label(w).toLowerCase().includes(q)
    || panesOf(w.workspace_id).some(p => `${p.label || ''} ${p.terminal_title_stripped || ''} ${p.agent || ''}`.toLowerCase().includes(q)))
})

const placement = computed(() => {
  const map = new Map<string, string>()
  for (const w of props.workspaces) map.set(w.workspace_id, folderOf(props.folders, w.workspace_id, spaceCwd(w.workspace_id), props.home))
  return map
})

const groups = computed(() => props.folders.list.map(folder => {
  const spaces = filtered.value.filter(w => placement.value.get(w.workspace_id) === folder.id)
  return { folder, spaces, status: rollupStatus(spaces.map(w => w.agent_status)) }
}))

const loose = computed(() => filtered.value.filter(w => !placement.value.get(w.workspace_id)))

function update(mutator: (state: SpaceFolderState) => void) {
  const next: SpaceFolderState = { list: props.folders.list.map(f => ({ ...f })), of: { ...props.folders.of }, at: Date.now() }
  mutator(next)
  emit('update-folders', next)
}

function toggleFolder(folder: SpaceFolder) {
  update(state => { const f = state.list.find(x => x.id === folder.id); if (f) f.folded = !f.folded })
}

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

function dropOnFolder(folder: SpaceFolder) {
  const drag = dragging.value
  if (!drag) return
  if (drag.kind === 'space') update(state => { state.of[drag.id] = folder.id })
  else if (drag.id !== folder.id) {
    update(state => {
      const from = state.list.findIndex(f => f.id === drag.id)
      const [moved] = state.list.splice(from, 1)
      const to = state.list.findIndex(f => f.id === folder.id)
      state.list.splice(from <= to ? to + 1 : to, 0, moved)
    })
  }
  onDragEnd()
}

function dropOnSpace(spaceId: string) {
  const drag = dragging.value
  if (drag?.kind !== 'space' || drag.id === spaceId) return onDragEnd()
  update(state => { state.of[drag.id] = placement.value.get(spaceId) || '' })
  onDragEnd()
}

function dropOut() {
  const drag = dragging.value
  if (drag?.kind === 'space') update(state => { state.of[drag.id] = '' })
  onDragEnd()
}

function paneName(pane: HerdrPaneView): string {
  return pane.label || pane.terminal_title_stripped || pane.agent || pane.pane_id
}
</script>

<template>
  <section class="space-tree" data-testid="mission-space-tree">
    <header class="space-tree-head">
      <span>{{ t('mission.spaces') }}</span>
      <span class="space-tree-spacer" />
      <button type="button" class="space-tree-icon" :title="t('mission.newFolder')" data-testid="mission-new-folder" @click="emit('edit-folder', null)">
        <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM12 11v6M9 14h6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" /></svg>
      </button>
      <button type="button" class="space-tree-icon" :title="t('mission.newSpace')" @click="emit('new-space', null)">
        <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" /></svg>
      </button>
    </header>
    <input v-model="search" class="space-tree-search" data-theme-surface="input" :placeholder="t('mission.searchSpaces')" />

    <div class="space-tree-body" role="tree">
      <template v-for="group in groups" :key="group.folder.id">
        <div
          class="tree-row tree-folder"
          :class="{ 'is-drop': dropTarget === `folder:${group.folder.id}` }"
          role="treeitem"
          :aria-expanded="!group.folder.folded"
          draggable="true"
          data-testid="mission-folder-row"
          @click="toggleFolder(group.folder)"
          @dragstart="onDragStart($event, 'folder', group.folder.id)"
          @dragend="onDragEnd"
          @dragover="onDragOver($event, `folder:${group.folder.id}`)"
          @drop.prevent="dropOnFolder(group.folder)"
          @contextmenu.prevent="emit('edit-folder', group.folder)"
        >
          <span class="tree-chevron" :class="{ open: !group.folder.folded }" aria-hidden="true">›</span>
          <span class="folder-tile" :data-color="group.folder.color || 'none'" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="12" height="12"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" fill="currentColor" /></svg>
          </span>
          <span class="tree-name">{{ group.folder.name }}</span>
          <AgentStatusIcon v-if="group.folder.folded && ['blocked', 'done', 'working'].includes(group.status)" :status="group.status" live :size="11" />
          <button type="button" class="tree-action" :title="t('mission.newSpaceHere')" @click.stop="emit('new-space', group.folder)">+</button>
          <button type="button" class="tree-action" :title="t('mission.editFolder')" @click.stop="emit('edit-folder', group.folder)">⋯</button>
          <span class="tree-count">{{ group.spaces.length }}</span>
        </div>
        <template v-if="!group.folder.folded">
          <template v-for="space in group.spaces" :key="space.workspace_id">
            <div
              class="tree-row tree-space indent-1"
              :class="{ active: space.workspace_id === selectedSpace, 'is-drop': dropTarget === `space:${space.workspace_id}` }"
              role="treeitem"
              draggable="true"
              data-testid="mission-space-row"
              @click="selectSpace(space.workspace_id)"
              @dragstart="onDragStart($event, 'space', space.workspace_id)"
              @dragend="onDragEnd"
              @dragover="onDragOver($event, `space:${space.workspace_id}`)"
              @drop.prevent="dropOnSpace(space.workspace_id)"
            >
              <span class="tree-chevron" :class="{ open: expandedSpaces.has(space.workspace_id) }" aria-hidden="true" @click.stop="toggleSpace(space.workspace_id)">›</span>
              <AgentStatusIcon :status="space.agent_status || 'unknown'" :live="!!space.agent_status && space.agent_status !== 'unknown'" :size="11" />
              <span class="tree-name">{{ label(space) }}</span>
            </div>
            <template v-if="expandedSpaces.has(space.workspace_id)">
              <div
                v-for="pane in panesOf(space.workspace_id)"
                :key="pane.pane_id"
                class="tree-row tree-pane indent-2"
                :class="{ active: pane.pane_id === selectedPane }"
                role="treeitem"
                data-testid="mission-pane-row"
                @click="emit('select-pane', pane.pane_id)"
              >
                <AgentStatusIcon :status="pane.agent_status || 'unknown'" live :size="11" />
                <span class="tree-name">{{ paneName(pane) }}</span>
                <span class="tree-meta">{{ pane.agent }}</span>
              </div>
            </template>
          </template>
        </template>
      </template>

      <template v-for="space in loose" :key="space.workspace_id">
        <div
          class="tree-row tree-space"
          :class="{ active: space.workspace_id === selectedSpace, 'is-drop': dropTarget === `space:${space.workspace_id}` }"
          role="treeitem"
          draggable="true"
          data-testid="mission-space-row"
          @click="selectSpace(space.workspace_id)"
          @dragstart="onDragStart($event, 'space', space.workspace_id)"
          @dragend="onDragEnd"
          @dragover="onDragOver($event, `space:${space.workspace_id}`)"
          @drop.prevent="dropOnSpace(space.workspace_id)"
        >
          <span class="tree-chevron" :class="{ open: expandedSpaces.has(space.workspace_id) }" aria-hidden="true" @click.stop="toggleSpace(space.workspace_id)">›</span>
          <AgentStatusIcon :status="space.agent_status || 'unknown'" :live="!!space.agent_status && space.agent_status !== 'unknown'" :size="11" />
          <span class="tree-name">{{ label(space) }}</span>
        </div>
        <template v-if="expandedSpaces.has(space.workspace_id)">
          <div
            v-for="pane in panesOf(space.workspace_id)"
            :key="pane.pane_id"
            class="tree-row tree-pane indent-1"
            :class="{ active: pane.pane_id === selectedPane }"
            role="treeitem"
            data-testid="mission-pane-row"
            @click="emit('select-pane', pane.pane_id)"
          >
            <AgentStatusIcon :status="pane.agent_status || 'unknown'" live :size="11" />
            <span class="tree-name">{{ paneName(pane) }}</span>
            <span class="tree-meta">{{ pane.agent }}</span>
          </div>
        </template>
      </template>

      <div
        v-if="dragging?.kind === 'space'"
        class="tree-dropout"
        :class="{ 'is-drop': dropTarget === 'out' }"
        @dragover="onDragOver($event, 'out')"
        @drop.prevent="dropOut"
      >{{ t('mission.dropOut') }}</div>
      <p v-if="!workspaces.length" class="tree-empty">{{ t('mission.noSpaces') }}</p>
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

  &.indent-1 {
    padding-left: 26px;
  }

  &.indent-2 {
    padding-left: 44px;
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
