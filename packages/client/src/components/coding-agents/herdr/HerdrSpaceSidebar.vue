<script setup lang="ts">
import { computed, h, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { NDropdown, NModal, useMessage, type DropdownOption } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import AgentStatusIcon from '@/components/common/AgentStatusIcon.vue'
import HerdrFolderEditor from './HerdrFolderEditor.vue'
import {
  createSpaceFolder,
  deleteSpaceFolder,
  fetchHerdrMachineAgents,
  fetchSpaceFolderView,
  fetchSpaceRepos,
  newSpaceInFolder,
  orderSpaceFolders,
  placeChatInFolder,
  placeSpaceInFolder,
  updateSpaceFolder,
  type HerdrMachine,
  type HerdrPaneView,
  type HerdrRemoteAgent,
} from '@/api/coding-agents/herdr'
import { useHerdrStore } from '@/stores/hermes/herdr'
import { useSessionStateStore } from '@/stores/hermes/session-state'
import {
  avatarColor,
  avatarLetter,
  buildRows,
  colorClass,
  dropAction,
  FOLDER_COLOR_NAMES,
  repoTail,
  ruleFolder,
  stepRow,
  type DragItem,
  type DropTarget,
  type SidebarChat,
  type SidebarFolder,
  type SidebarRow,
  type SpaceFolderViewData,
  type SpaceRepo,
} from './space-folders'

/**
 * Studio's Spaces sidebar on the herdr page, rebuilt natively after Herdr
 * App's Space Folders mod (jankeesvw/herdr-space-folders) and Herdr Roundup's
 * spaces list (carstenlucke/herdr-roundup). Studio's chat folders are the
 * folders: colored tiles with a count that fold (a folded folder still shows
 * an agent that is blocked, done or working), filled by dragging or by their
 * rules. Every chat is listed, asleep ones marked "z" (a click wakes them).
 * The same folders show in Herdr App through herdr-space-folders' file.
 */
const props = defineProps<{
  panes: HerdrPaneView[]
  workspaces: Array<{ workspace_id: string; label?: string }>
  /** Chats awake in herdr (null: unknown). */
  awake: Set<string> | null
  /** The chat shown now. */
  activeChat: string
  /** The pane herdr shows now. */
  focusedPane: string
  machines: HerdrMachine[]
  drawer: boolean
  /**
   * 'app': the Spaces section of the Herdr App layout's sidebar (no frame of
   * its own, search behind the brand row's search button, + always shown).
   */
  variant?: 'panel' | 'app'
  /** 'app': the search field shows (the brand row's search button). */
  searchOpen?: boolean
}>()
const emit = defineEmits<{
  'open-chat': [chat: SidebarChat, asleep: boolean, paneId: string]
  'focus-pane': [paneId: string]
  'open-machine': [machineId: string, paneId?: string]
  'new-chat': []
  'use-herdr-sidebar': []
  close: []
}>()

const { t } = useI18n()
const toast = useMessage()
const herdr = useHerdrStore()
const states = useSessionStateStore()

const EMPTY: SpaceFolderViewData = { folders: [], chats: [], spaces: {}, home: '', file: null }
const view = ref<SpaceFolderViewData>(EMPTY)
const loaded = ref(false)
const query = ref('')

function valid(data: any): data is SpaceFolderViewData {
  return !!data && Array.isArray(data.folders) && Array.isArray(data.chats)
}

let loading: Promise<void> | null = null
async function load() {
  if (loading) return loading
  loading = (async () => {
    try {
      const data = await fetchSpaceFolderView()
      if (valid(data)) view.value = { ...EMPTY, ...data, spaces: data.spaces || {} }
    } catch { /* keep what shows */ } finally {
      loaded.value = true
      loading = null
    }
  })()
  return loading
}
let timer = 0
function schedule(ms = 250) {
  if (timer) window.clearTimeout(timer)
  timer = window.setTimeout(() => { timer = 0; void load() }, ms)
}

const built = computed(() => buildRows({
  view: view.value,
  panes: props.panes,
  workspaces: props.workspaces,
  awake: props.awake,
  query: query.value,
}))
const rows = computed(() => built.value.rows)

/** The row of what herdr or Studio shows now. */
const currentKey = computed(() => {
  if (props.activeChat) return `chat:${props.activeChat}`
  const pane = props.panes.find(item => item.pane_id === props.focusedPane)
  return pane ? `space:${pane.workspace_id}` : ''
})

// ---- repo, branch and ahead/behind of what shows ----
const repos = ref<Record<string, SpaceRepo | null>>({})
const cwdKey = computed(() => [...new Set(rows.value.flatMap(row => (row.kind !== 'folder' && row.cwd ? [row.cwd] : [])))].sort().join('\n'))
let repoTimer = 0
async function loadRepos() {
  const cwds = cwdKey.value ? cwdKey.value.split('\n') : []
  if (!cwds.length) return
  try {
    const { repos: found } = await fetchSpaceRepos(cwds)
    if (found && typeof found === 'object') repos.value = { ...repos.value, ...found }
  } catch { /* the names alone still show */ }
}
watch(cwdKey, () => {
  if (repoTimer) window.clearTimeout(repoTimer)
  repoTimer = window.setTimeout(() => { repoTimer = 0; void loadRepos() }, 400)
}, { immediate: true })

function rowName(row: SidebarRow): string {
  if (row.kind === 'chat') return row.chat.title || row.chat.id
  if (row.kind === 'space') return row.space.label
  return row.folder.name
}
function rowTail(row: SidebarRow): string {
  if (row.kind === 'folder') return ''
  return repoTail(repos.value[row.cwd], rowName(row))
}

// ---- actions ----
async function act(work: () => Promise<unknown>) {
  try {
    await work()
  } catch (error: any) {
    toast.error(t('spaceFolders.failed', { error: error?.message || String(error) }))
  } finally {
    await load()
  }
}

function toggleFolder(folder: SidebarFolder) {
  if (query.value.trim()) return
  // At once here; the server writes it for Herdr App too.
  view.value = { ...view.value, folders: view.value.folders.map(item => (item.id === folder.id ? { ...item, folded: !item.folded } : item)) }
  void act(() => updateSpaceFolder(folder.id, { folded: !folder.folded }))
}

function openRow(row: SidebarRow) {
  if (row.kind === 'chat') emit('open-chat', row.chat, row.asleep, row.paneId)
  else if (row.kind === 'space' && row.paneId) emit('focus-pane', row.paneId)
}

/** A folder's "+": a new space in its start folder, already in the folder. */
function newSpace(folder: SidebarFolder) {
  void act(async () => {
    const created = await newSpaceInFolder(folder.id)
    if (created?.paneId) emit('focus-pane', created.paneId)
  })
}

// ---- keys: alt+up / alt+down follow the list ----
function step(dir: 1 | -1): boolean {
  const next = stepRow(built.value.seen, currentKey.value, dir)
  if (!next) return false
  const row = rows.value.find(item => item.key === next)
  if (!row) return false
  openRow(row)
  return true
}
/** Every chat, for the command palette (folded ones too). */
const chatList = computed(() => {
  const names = new Map(view.value.folders.map(folder => [folder.id, folder.name]))
  return [...view.value.chats]
    .sort((a, b) => b.lastActive - a.lastActive)
    .map(chat => ({ id: chat.id, title: chat.title || chat.id, folder: names.get(chat.folderId) || '' }))
})

/** Open a chat by id (the command palette), waking it if it sleeps. */
function openChat(id: string): boolean {
  const chat = view.value.chats.find(item => item.id === id)
  if (!chat) return false
  const paneId = props.panes.find(pane => pane.studioSessionId === id)?.pane_id || ''
  const asleep = props.awake ? !props.awake.has(id) : !paneId
  emit('open-chat', chat, asleep, paneId)
  return true
}

const searchField = ref<HTMLInputElement | null>(null)
watch(() => props.searchOpen, value => {
  if (value) window.setTimeout(() => searchField.value?.focus(), 0)
  else query.value = ''
})

defineExpose({ step, reload: load, chatList, openChat })

// ---- drag and drop ----
const dragging = ref<DragItem | null>(null)
const over = ref('')
function dragKey(row: SidebarRow): DragItem {
  if (row.kind === 'folder') return { kind: 'folder', id: row.folder.id }
  if (row.kind === 'chat') return { kind: 'chat', id: row.chat.id }
  return { kind: 'space', id: row.space.workspaceId }
}
function onDragStart(event: DragEvent, row: SidebarRow) {
  dragging.value = dragKey(row)
  event.dataTransfer?.setData('text/plain', row.key)
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
}
function onDragEnd() {
  dragging.value = null
  over.value = ''
}
function onDragOver(event: DragEvent, key: string) {
  if (!dragging.value) return
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
  over.value = key
}
function targetOf(row: SidebarRow | null): DropTarget {
  if (!row) return { kind: 'end' }
  if (row.kind === 'folder') return { kind: 'folder', id: row.folder.id }
  return { kind: 'item', folderId: row.folderId }
}
function ruleFolderOf(item: DragItem): string {
  const row = rows.value.find(entry => entry.kind !== 'folder' && entry.key === `${item.kind}:${item.id}`)
  return row && row.kind !== 'folder' ? ruleFolder(view.value.folders, row.cwd, view.value.home) : ''
}
function onDrop(row: SidebarRow | null) {
  const drag = dragging.value
  onDragEnd()
  if (!drag) return
  const action = dropAction(drag, targetOf(row), { folders: view.value.folders, ruleFolderOf })
  if (!action) return
  if (action.kind === 'placeChat') {
    view.value = { ...view.value, chats: view.value.chats.map(chat => (chat.id === action.sessionId ? { ...chat, folderId: action.folderId || '', out: action.folderId === '' } : chat)) }
    void act(() => placeChatInFolder(action.sessionId, action.folderId))
  } else if (action.kind === 'placeSpace') {
    void act(() => placeSpaceInFolder(action.workspaceId, action.folderId))
  } else {
    void act(() => orderSpaceFolders(action.ids, action.move))
  }
}

// ---- folder menu (right-click) ----
const menu = ref<{ folder: SidebarFolder; x: number; y: number } | null>(null)
function openMenu(event: MouseEvent, folder: SidebarFolder) {
  menu.value = { folder, x: event.clientX, y: event.clientY }
}
function paint(folder: SidebarFolder, color: string) {
  menu.value = null
  view.value = { ...view.value, folders: view.value.folders.map(item => (item.id === folder.id ? { ...item, color } : item)) }
  void act(() => updateSpaceFolder(folder.id, { color }))
}
const menuOptions = computed<DropdownOption[]>(() => {
  const folder = menu.value?.folder
  if (!folder) return []
  return [
    {
      key: 'colors',
      type: 'render',
      render: () => h('div', { class: 'sf-menu-colors', role: 'radiogroup', 'aria-label': t('spaceFolders.color') }, ['', ...FOLDER_COLOR_NAMES].map(color => h('button', {
        type: 'button',
        role: 'radio',
        class: ['sf-menu-swatch', colorClass(color), { active: folder.color === color }],
        'aria-checked': folder.color === color,
        'aria-label': t(`spaceFolders.colors.${color || 'none'}`),
        title: t(`spaceFolders.colors.${color || 'none'}`),
        'data-testid': `space-folder-menu-color-${color || 'none'}`,
        onClick: () => paint(folder, color),
      }))),
    },
    { key: 'space', label: t('spaceFolders.newSpaceHere'), props: { 'data-testid': 'space-folder-menu-space' } as any },
    { key: 'subfolder', label: t('spaceFolders.newSubfolder'), props: { 'data-testid': 'space-folder-menu-subfolder' } as any },
    { key: 'edit', label: t('spaceFolders.editFolder'), props: { 'data-testid': 'space-folder-menu-edit' } as any },
    { key: 'delete', label: t('spaceFolders.deleteFolder'), props: { 'data-testid': 'space-folder-menu-delete' } as any },
  ]
})
function onMenu(key: string) {
  const folder = menu.value?.folder
  menu.value = null
  if (!folder) return
  if (key === 'space') newSpace(folder)
  else if (key === 'subfolder') editing.value = { folder: null, parentId: folder.id }
  else if (key === 'edit') editing.value = { folder, parentId: folder.parentId }
  else if (key === 'delete') deleting.value = folder
}

// ---- edit / new / delete ----
const editing = ref<{ folder: SidebarFolder | null; parentId: string } | null>(null)
const deleting = ref<SidebarFolder | null>(null)
function saveFolder(value: { name: string; parentId: string; start: string; rules: string; color: string }) {
  const target = editing.value
  editing.value = null
  if (!target) return
  void act(async () => {
    if (!target.folder) {
      await createSpaceFolder({ name: value.name, parentId: value.parentId || undefined, start: value.start, rules: value.rules, color: value.color })
      return
    }
    const folder = target.folder
    await updateSpaceFolder(folder.id, { name: value.name, start: value.start, rules: value.rules, color: value.color })
    if (value.parentId !== folder.parentId) {
      const ids = view.value.folders.map(item => item.id)
      await orderSpaceFolders(ids, { id: folder.id, parentId: value.parentId })
    }
  })
}
function confirmDelete() {
  const folder = deleting.value
  deleting.value = null
  if (folder) void act(() => deleteSpaceFolder(folder.id))
}

// ---- other machines (herdr remote): their agents, under a header each ----
const remote = ref<Record<string, { agents: HerdrRemoteAgent[]; error: string }>>({})
const machinesFolded = ref(new Set<string>())
async function loadRemote() {
  const next: Record<string, { agents: HerdrRemoteAgent[]; error: string }> = {}
  await Promise.all(props.machines.map(async machine => {
    try { next[machine.id] = { agents: (await fetchHerdrMachineAgents(machine.id)).agents || [], error: '' } } catch (error: any) { next[machine.id] = { agents: [], error: error?.message || String(error) } }
  }))
  remote.value = next
}
watch(() => props.machines.map(machine => machine.id).join(','), () => { void loadRemote() })
function toggleMachine(id: string) {
  const next = new Set(machinesFolded.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  machinesFolded.value = next
}

// ---- lifecycle ----
let stopList: (() => void) | null = null
let poll = 0
watch(() => herdr.foldersVersion, () => schedule(100))
onMounted(() => {
  void load()
  void loadRemote()
  states.start()
  stopList = states.onListChanged(() => schedule())
  poll = window.setInterval(() => { void load(); void loadRemote(); void loadRepos() }, 30_000)
})
onBeforeUnmount(() => {
  stopList?.()
  if (timer) window.clearTimeout(timer)
  if (repoTimer) window.clearTimeout(repoTimer)
  if (poll) window.clearInterval(poll)
})

const indent = (depth: number) => ({ paddingLeft: `${6 + depth * 14}px` })
const fileName = computed(() => view.value.file?.path.replace(/^.*\/(\.config\/)/, '~/$1') || '')
</script>

<template>
  <aside class="sf" :class="{ 'is-drawer': drawer, 'is-app': variant === 'app' }" data-theme-surface="card" data-testid="space-sidebar" :aria-label="t('spaceFolders.title')">
    <header class="sf-head">
      <span class="sf-title" :title="fileName ? t('spaceFolders.synced', { file: fileName }) : undefined">{{ t('spaceFolders.title') }}</span>
      <span class="sf-spacer" />
      <button type="button" class="sf-icon" :title="t('spaceFolders.newFolder')" :aria-label="t('spaceFolders.newFolder')" data-testid="space-sidebar-new-folder" @click="editing = { folder: null, parentId: '' }">
        <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM12 11v6M9 14h6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" /></svg>
      </button>
      <button type="button" class="sf-icon" :title="t('spaceFolders.newChat')" :aria-label="t('spaceFolders.newChat')" data-testid="space-sidebar-new-chat" @click="emit('new-chat')">
        <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" /></svg>
      </button>
      <button v-if="variant !== 'app'" type="button" class="sf-icon" :title="t('spaceFolders.useHerdrSidebar')" :aria-label="t('spaceFolders.useHerdrSidebar')" data-testid="space-sidebar-use-herdr" @click="emit('use-herdr-sidebar')">
        <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M4 5h16v14H4zM9 5v14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" /></svg>
      </button>
      <button v-if="drawer && variant !== 'app'" type="button" class="sf-icon" :title="t('spaceFolders.close')" :aria-label="t('spaceFolders.close')" data-testid="space-sidebar-close" @click="emit('close')">×</button>
    </header>
    <input v-if="variant !== 'app' || searchOpen" ref="searchField" v-model="query" class="sf-search" data-theme-surface="input" type="search" :placeholder="t('spaceFolders.search')" :aria-label="t('spaceFolders.search')" data-testid="space-sidebar-search" />

    <div class="sf-list" role="tree" :aria-label="t('spaceFolders.title')" @dragover="onDragOver($event, 'end')" @drop.prevent="onDrop(null)">
      <div v-if="machines.length" class="sf-machine" data-testid="space-sidebar-machine-local">
        <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path d="M4 5h16v11H4zM8 20h8M12 16v4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" /></svg>
        <span>{{ t('spaceFolders.thisComputer') }}</span>
      </div>
      <template v-for="row in rows" :key="row.key">
        <div
          v-if="row.kind === 'folder'"
          class="sf-row sf-folder"
          :class="{ 'is-drop': over === row.key, 'is-dragged': dragging?.kind === 'folder' && dragging.id === row.folder.id }"
          :style="indent(row.depth)"
          role="treeitem"
          :aria-level="row.depth + 1"
          :aria-expanded="row.open"
          draggable="true"
          :data-testid="`space-folder-${row.folder.id}`"
          data-kind="folder"
          @click="toggleFolder(row.folder)"
          @contextmenu.prevent="openMenu($event, row.folder)"
          @dragstart="onDragStart($event, row)"
          @dragend="onDragEnd"
          @dragover.stop="onDragOver($event, row.key)"
          @drop.prevent.stop="onDrop(row)"
        >
          <span class="sf-tile" :class="colorClass(row.folder.color)" :style="!colorClass(row.folder.color) ? { background: row.folder.color } : undefined" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="12" height="12"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" fill="currentColor" /></svg>
          </span>
          <span class="sf-name sf-folder-name">{{ row.folder.name }}</span>
          <AgentStatusIcon v-if="!row.open && row.status" :status="row.status" live :size="11" data-testid="space-folder-status" />
          <button type="button" class="sf-add" :title="t('spaceFolders.newSpaceHere')" :aria-label="t('spaceFolders.newSpaceHere')" :data-testid="`space-folder-add-${row.folder.id}`" @click.stop="newSpace(row.folder)">+</button>
          <span class="sf-count">{{ row.count }}</span>
          <span class="sf-chevron" :class="{ open: row.open }" aria-hidden="true">›</span>
        </div>
        <div
          v-else
          class="sf-row sf-item"
          :class="{ active: row.key === currentKey, 'is-drop': over === row.key, 'is-asleep': row.kind === 'chat' && row.asleep }"
          :style="indent(row.depth)"
          role="treeitem"
          :aria-level="row.depth + 1"
          :aria-current="row.key === currentKey ? 'true' : undefined"
          draggable="true"
          :data-testid="row.kind === 'chat' ? `space-chat-${row.chat.id}` : `space-other-${row.space.workspaceId}`"
          :data-kind="row.kind"
          :title="row.kind === 'chat' && row.asleep ? t('spaceFolders.asleepWake') : rowName(row)"
          @click="openRow(row)"
          @dragstart="onDragStart($event, row)"
          @dragend="onDragEnd"
          @dragover.stop="onDragOver($event, row.key)"
          @drop.prevent.stop="onDrop(row)"
        >
          <span class="sf-avatar" :class="colorClass(avatarColor(row.kind === 'chat' ? row.chat.id : row.space.workspaceId))" aria-hidden="true">{{ avatarLetter(rowName(row)) }}</span>
          <span class="sf-name">{{ rowName(row) }}</span>
          <span v-if="rowTail(row)" class="sf-tail">{{ rowTail(row) }}</span>
          <span v-if="row.kind === 'chat' && row.asleep" class="sf-asleep" data-testid="space-chat-asleep" :aria-label="t('herdr.asleep')">z</span>
          <AgentStatusIcon v-else :status="row.status" :live="row.status !== 'unknown'" :size="11" />
        </div>
      </template>
      <p v-if="loaded && !rows.length" class="sf-empty">{{ query.trim() ? t('spaceFolders.noMatch') : t('spaceFolders.empty') }}</p>
      <div
        v-if="dragging"
        class="sf-dropout"
        :class="{ 'is-drop': over === 'end' }"
        data-testid="space-sidebar-dropout"
        @dragover.stop="onDragOver($event, 'end')"
        @drop.prevent.stop="onDrop(null)"
      >{{ dragging.kind === 'folder' ? t('spaceFolders.dropFolderOut') : t('spaceFolders.dropOut') }}</div>

      <template v-for="machine in machines" :key="machine.id">
        <div class="sf-machine sf-machine-remote" role="button" tabindex="0" :data-testid="`space-sidebar-machine-${machine.id}`" @click="toggleMachine(machine.id)" @keydown.enter="toggleMachine(machine.id)">
          <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path d="M4 4h16v6H4zM4 14h16v6H4zM8 7h.01M8 17h.01" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" /></svg>
          <span>{{ machine.label || machine.target }}</span>
          <span class="sf-spacer" />
          <small v-if="remote[machine.id]?.error">{{ t('spaceFolders.unreachable') }}</small>
          <span class="sf-chevron" :class="{ open: !machinesFolded.has(machine.id) }" aria-hidden="true">›</span>
        </div>
        <template v-if="!machinesFolded.has(machine.id)">
          <div
            v-for="agent in remote[machine.id]?.agents || []"
            :key="`${machine.id}:${agent.pane_id}`"
            class="sf-row sf-item"
            :style="indent(1)"
            role="treeitem"
            :data-testid="`space-remote-${machine.id}-${agent.pane_id}`"
            @click="emit('open-machine', machine.id, agent.pane_id)"
          >
            <span class="sf-avatar" :class="colorClass(avatarColor(`${machine.id}:${agent.workspace_id}`))" aria-hidden="true">{{ avatarLetter(agent.label || agent.agent) }}</span>
            <span class="sf-name">{{ agent.label || agent.agent }}</span>
            <span class="sf-tail">{{ agent.agent }}</span>
            <AgentStatusIcon :status="(agent.agent_status as any) || 'unknown'" live :size="11" />
          </div>
        </template>
      </template>
    </div>

    <NDropdown
      v-if="menu"
      :show="true"
      trigger="manual"
      placement="bottom-start"
      :x="menu.x"
      :y="menu.y"
      :options="menuOptions"
      data-testid="space-folder-menu"
      @select="onMenu"
      @clickoutside="menu = null"
    />
    <HerdrFolderEditor
      v-if="editing"
      :folder="editing.folder"
      :folders="view.folders"
      :parent-id="editing.parentId"
      :home="view.home"
      @save="saveFolder"
      @cancel="editing = null"
    />
    <NModal
      v-if="deleting"
      :show="true"
      preset="dialog"
      type="warning"
      :title="t('spaceFolders.deleteFolder')"
      :content="t('spaceFolders.deleteConfirm', { name: deleting.name })"
      :positive-text="t('spaceFolders.deleteFolder')"
      :negative-text="t('spaceFolders.cancel')"
      data-testid="space-folder-delete"
      @positive-click="confirmDelete"
      @negative-click="deleting = null"
      @update:show="value => { if (!value) deleting = null }"
    />
  </aside>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;
@use './space-colors' as colors;

@include colors.palette;

.sf {
  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
  background: $bg-card;
  border: var(--border-width, 1px) solid $border-light;
  border-radius: var(--radius-component, 8px);
  overflow: hidden;
  font-size: 13px;
}

.sf-head {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 8px 6px 4px 12px;
}

.sf-title {
  font-size: 11.5px;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: $text-muted;
}

.sf-spacer {
  flex: 1 1 auto;
}

.sf-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: $text-secondary;
  font-size: 16px;
  cursor: pointer;

  &:hover {
    color: $text-primary;
    background: rgba(var(--accent-primary-rgb), 0.1);
  }
}

.sf-search {
  margin: 2px 8px 6px;
  padding: 5px 8px;
  font-size: 12px;
  color: $text-primary;
  background: $bg-input;
  border: var(--border-width, 1px) solid $border-light;
  border-radius: var(--radius-component, 6px);
  outline: none;

  &:focus {
    border-color: $accent-primary;
  }
}

.sf-list {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 0 6px 12px;
}

.sf-row {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 30px;
  padding-right: 6px;
  border: var(--border-width, 1px) solid transparent;
  border-radius: 7px;
  color: $text-primary;
  cursor: pointer;
  user-select: none;

  &:hover {
    background: rgba(var(--accent-primary-rgb), 0.07);
  }

  &.active {
    background: rgba(var(--accent-primary-rgb), 0.16);
  }

  &.is-drop {
    border-color: $accent-primary;
    background: rgba(var(--accent-primary-rgb), 0.1);
  }
}

.sf-folder {
  font-weight: 500;

  &.is-dragged:not(:hover) {
    color: $text-muted;
  }
}

.sf-tile,
.sf-avatar {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: 5px;
  @include colors.on-color;
  font-size: 10.5px;
  font-weight: 600;
  line-height: 1;
}

.sf-name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sf-tail {
  flex: 0 1 auto;
  min-width: 0;
  max-width: 45%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  color: $text-muted;
}

.sf-count {
  flex: none;
  min-width: 14px;
  text-align: right;
  font-size: 11.5px;
  color: $text-muted;
}

.sf-add {
  flex: none;
  padding: 0 5px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: $text-muted;
  font-size: 14px;
  line-height: 18px;
  cursor: pointer;
  visibility: hidden;

  &:hover {
    color: $text-primary;
    background: rgba(var(--accent-primary-rgb), 0.12);
  }
}

.sf-folder:hover .sf-add,
.sf-folder:focus-within .sf-add {
  visibility: visible;
}

.sf-chevron {
  flex: none;
  width: 10px;
  color: $text-muted;
  transition: transform 0.12s ease;

  &.open {
    transform: rotate(90deg);
  }
}

.sf-asleep {
  flex: none;
  font-size: 10px;
  font-style: italic;
  line-height: 1;
  color: $text-muted;
}

.sf-item.is-asleep .sf-name {
  color: $text-secondary;
}

.sf-machine {
  display: flex;
  align-items: center;
  gap: 7px;
  height: 26px;
  padding: 0 6px;
  font-size: 11px;
  color: $text-muted;

  small {
    font-size: 10.5px;
  }
}

.sf-machine-remote {
  margin-top: 8px;
  border-radius: 6px;
  cursor: pointer;

  &:hover {
    background: rgba(var(--accent-primary-rgb), 0.07);
  }
}

.sf-empty {
  margin: 12px 8px;
  font-size: 12px;
  color: $text-muted;
}

.sf-dropout {
  margin-top: 6px;
  padding: 10px 8px;
  border: var(--border-width, 1px) dashed $border-light;
  border-radius: 7px;
  font-size: 11.5px;
  color: $text-muted;
  text-align: center;

  &.is-drop {
    border-color: $accent-primary;
    color: $text-primary;
  }
}

// ---- the Spaces section of the Herdr App layout (space-folders mod) ----
.sf.is-app {
  flex: 1 1 auto;
  border: 0;
  border-radius: 0;
  background: transparent;
  font-size: 13.5px;

  .sf-head {
    height: 34px;
    padding: 6px 12px 0 16px;
  }

  .sf-title {
    font-size: 11.5px;
    font-weight: 500;
    letter-spacing: 0;
  }

  .sf-icon {
    width: 24px;
    height: 24px;
    color: $text-muted;
  }

  .sf-search {
    margin: 4px 10px 6px;
  }

  .sf-list {
    padding: 2px 8px 8px;
  }

  .sf-row {
    height: 30px;
    margin-bottom: 0;
    padding-right: 8px;
    border-radius: 6px;
    gap: 9px;

    &.active {
      background: rgba(var(--accent-primary-rgb), 0.12);
    }
  }

  .sf-folder {
    font-weight: 400;
  }

  .sf-tile,
  .sf-avatar {
    width: 17px;
    height: 17px;
    border-radius: 4px;
    font-size: 10px;
  }

  // Herdr App shows a folder's + and count all the time.
  .sf-add {
    visibility: visible;
    font-size: 15px;
  }

  .sf-count {
    font-size: 12px;
  }
}

:global(.sf-menu-colors) {
  display: flex;
  gap: 6px;
  padding: 6px 10px 8px;
}

:global(.sf-menu-swatch) {
  width: 20px;
  height: 20px;
  padding: 0;
  border: 2px solid transparent;
  border-radius: 999px;
  cursor: pointer;
}

:global(.sf-menu-swatch.active) {
  border-color: $text-primary;
}

@include colors.menu-palette;
</style>
