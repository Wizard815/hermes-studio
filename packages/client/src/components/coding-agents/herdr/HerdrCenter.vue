<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { NButton, NPopover, NTooltip, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import AgentStatusIcon from '@/components/common/AgentStatusIcon.vue'
import HerdrTerminal from './HerdrTerminal.vue'
import HerdrMissionDock from './HerdrMissionDock.vue'
import HerdrSpaceSidebar from './HerdrSpaceSidebar.vue'
import HerdrAppView from './HerdrAppView.vue'
import HerdrChangesPanel from './HerdrChangesPanel.vue'
import HerdrCommandPalette from './HerdrCommandPalette.vue'
import { isPaletteKey, useHerdrView, type PaletteItem } from './herdr-app-layout'
import HeaderActionOverflow from '@/components/layout/HeaderActionOverflow.vue'
import { useHerdrDock } from './herdr-layout'
import { useSpaceSidebar } from './space-sidebar-layout'
import type { SidebarChat } from './space-folders'
import { useCommandCenter } from '@/mission/command-center/useCommandCenter'
import { useHerdrStore } from '@/stores/hermes/herdr'
import { fetchHerdrMachines, focusHerdrMachineAgent, focusHerdrPane, openSessionInHerdr, reopenClosedHerdrChat, studioFocusRequest, type HerdrMachine, type HerdrPaneView } from '@/api/coding-agents/herdr'
import { herdrKeyBytes } from '@/utils/herdr-keys'

/**
 * The herdr page (Studio's chat page in herdr mode). By default it is the
 * Herdr App layout (HerdrAppView: Studio draws herdr's chrome, each pane is its
 * own terminal); the header's "herdr TUI" switch shows the look below instead.
 *
 * herdr's terminal UI look: herdr's own full UI on
 * the left and center (its spaces sidebar, where every Studio chat is a space
 * in its Studio folder, and the focused pane with herdr's keys, search and
 * settings), and Mission's tools docked on the right (Chats, Tasks, Projects,
 * Ideas, Upkeep, Control). Old Mission links land here. ChatPanel keeps this
 * and the chat mounted together and only shows one, so swapping is instant.
 * On a phone herdr uses its own phone layout (its spaces slide over) and the
 * dock is a drawer.
 */
const props = withDefaults(defineProps<{
  sessionId: string
  active: boolean
  /** The chat page's header row: the herdr bar goes there (one row with the chat title and switch). */
  headerTarget?: HTMLElement | null
  /**
   * The page's own "more" menu takes herdr's less-used actions on a phone
   * (one menu in the row): it reads `menuItems` and calls `runMenuItem`.
   */
  hostMenu?: boolean
}>(), { headerTarget: null, hostMenu: false })
const emit = defineEmits<{ 'open-chat': [sessionId: string]; 'open-studio-chat': [sessionId: string]; 'new-chat': [] }>()
/** Below this header width the less-used herdr keys fold into the "more" menu. */
const HEADER_ROOM = 1560
/** The phone header's "more" menu: a pick closes it. */
const phoneMenu = ref(false)
function fromMenu(action: () => unknown) {
  phoneMenu.value = false
  void action()
}

const { t } = useI18n()
const toast = useMessage()
const herdr = useHerdrStore()
const opening = ref(false)
const localTerminal = ref<InstanceType<typeof HerdrTerminal> | null>(null)
const remoteTerminal = ref<InstanceType<typeof HerdrTerminal> | null>(null)

/**
 * herdr remote: saved SSH machines. '' is this machine; a machine id shows that
 * machine's full herdr (herdr's own remote attach), keys and all. The local
 * view stays connected underneath, so switching back is instant.
 */
const machines = ref<HerdrMachine[]>([])
const machine = ref('')
const machineLabel = computed(() => machines.value.find(item => item.id === machine.value)?.label || machine.value)
const terminal = computed(() => (machine.value ? remoteTerminal.value : localTerminal.value))

/**
 * The page's look: the Herdr App layout (Studio draws herdr's chrome and each
 * pane is its own terminal) or herdr's own terminal UI. A saved machine shows
 * its full herdr either way.
 */
const herdrView = useHerdrView()
const appView = ref<InstanceType<typeof HerdrAppView> | null>(null)
const appMode = computed(() => herdrView.mode.value === 'app' && !machine.value)
/** The right-hand panel of the Herdr App layout: Studio's tools, Changes, or none (hidden at first, as in Herdr App). */
const appPanel = ref<'' | 'dock' | 'changes'>('')
/** Keys go to the terminal on show: the focused pane's in the Herdr App layout, herdr's UI otherwise. */
function focusTerminal() {
  if (appMode.value) appView.value?.focusTerminal()
  else terminal.value?.focus()
}

async function loadMachines() {
  try { machines.value = (await fetchHerdrMachines()).machines.filter(item => item.enabled) } catch { machines.value = [] }
  if (machine.value && !machines.value.some(item => item.id === machine.value)) machine.value = ''
}

/** Open a machine's herdr, optionally on one of its agents. */
async function openMachine(id: string, paneId?: string) {
  machine.value = id
  if (paneId) await focusHerdrMachineAgent(id, paneId).catch((err: any) => toast.error(err?.message || String(err)))
}
/** The herdr client starts the first time this is shown, then stays connected. */
const started = ref(false)

const panes = computed<HerdrPaneView[]>(() => herdr.bridge?.panes || [])
const dock = useHerdrDock()

/**
 * The left column: Studio's Spaces sidebar (space folders, the same folders
 * as Herdr App's Space Folders) with herdr's own sidebar hidden, or herdr's
 * own sidebar instead. On a phone Studio's sidebar is a drawer.
 */
const spaces = useSpaceSidebar(dock.phone)
const spaceSidebar = ref<InstanceType<typeof HerdrSpaceSidebar> | null>(null)
const herdrWorkspaces = computed(() => herdr.bridge?.workspaces || [])
/** Chats' waiting panes: their spaces' placeholders, not running agents. */
const waitingPanes = computed(() => new Set(herdr.bridge?.waitingPanes || []))
/** Chats awake in herdr (they have a space now); null while herdr's state is unknown. */
const awakeChats = computed(() => {
  const list = herdr.bridge?.connected ? herdr.bridge.chatSpaces : undefined
  return Array.isArray(list) ? new Set(list) : null
})

/** A chat picked in the Spaces sidebar: herdr shows it (waking it if asleep) and the chat follows. */
async function openFromSidebar(chat: SidebarChat, asleep: boolean, paneId: string) {
  machine.value = ''
  spaces.picked()
  if (paneId && !asleep) {
    void focusHerdrPane(paneId).catch(() => undefined)
    if (chat.id !== props.sessionId) emit('open-chat', chat.id)
    focusTerminal()
    return
  }
  if (chat.id !== props.sessionId) emit('open-chat', chat.id)
  try {
    const { link } = await openSessionInHerdr(chat.id)
    await herdr.refresh()
    await focusHerdrPane(link.paneId).catch(() => undefined)
    focusTerminal()
  } catch (err: any) {
    toast.error(err?.message || String(err))
  }
}

function focusFromSidebar(paneId: string) {
  machine.value = ''
  spaces.picked()
  void focusHerdrPane(paneId).catch((err: any) => toast.error(err?.message || String(err)))
  focusTerminal()
}

/** alt+up / alt+down go to the space above or below in the Spaces list, as it shows (folders and all). */
function onListKeys(event: KeyboardEvent) {
  if (!props.active) return
  // Ctrl+Shift+P: the Herdr App layout's command palette.
  if (appMode.value && isPaletteKey(event)) {
    event.preventDefault()
    event.stopPropagation()
    palette.value = !palette.value
    return
  }
  const list = appMode.value ? appView.value : (spaces.mode.value === 'studio' ? spaceSidebar.value : null)
  if (!list) return
  if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
  if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
  event.preventDefault()
  event.stopPropagation()
  list.step(event.key === 'ArrowDown' ? 1 : -1)
}

// ---- the Herdr App layout's command palette ----
const palette = ref(false)
const paletteItems = computed<PaletteItem[]>(() => {
  if (!palette.value) return []
  const items: PaletteItem[] = [
    { id: 'action:new-chat', kind: 'action', label: t('herdrApp.actions.newChat') },
    { id: 'action:reopen', kind: 'action', label: t('herdrApp.actions.reopen'), detail: reopenKey.value ? reopenKey.value.replace(/^prefix\+/i, `${keys.value.prefix} `) : undefined },
    ...(studioChatId.value ? [{ id: 'action:open-studio', kind: 'action' as const, label: t('herdrApp.actions.openStudio') }] : []),
    { id: 'action:new-tab', kind: 'action', label: t('herdrApp.actions.newTab') },
    { id: 'action:next-space', kind: 'action', label: t('herdrApp.actions.nextSpace'), detail: 'Alt ↓' },
    { id: 'action:prev-space', kind: 'action', label: t('herdrApp.actions.prevSpace'), detail: 'Alt ↑' },
    { id: 'action:files', kind: 'action', label: t('herdrApp.actions.files') },
    { id: 'action:changes', kind: 'action', label: t('herdrApp.actions.changes') },
    { id: 'action:issues', kind: 'action', label: t('herdrApp.actions.issues') },
    { id: 'action:tools', kind: 'action', label: t('herdrApp.actions.tools') },
    { id: 'action:sidebar', kind: 'action', label: t('herdrApp.actions.toggleSidebar') },
    { id: 'action:tui', kind: 'action', label: t('herdrApp.actions.tui'), keywords: 'tui terminal herdr' },
    { id: 'action:settings', kind: 'action', label: t('herdrApp.actions.settings') },
  ]
  const chatSpaces = new Set<string>()
  for (const pane of panes.value) if (pane.studioSessionId) chatSpaces.add(pane.workspace_id)
  for (const space of herdrWorkspaces.value) {
    if (chatSpaces.has(space.workspace_id)) continue
    items.push({ id: `space:${space.workspace_id}`, kind: 'space', label: space.label || space.workspace_id })
  }
  for (const chat of appView.value?.chatList() || []) items.push({ id: `chat:${chat.id}`, kind: 'chat', label: chat.title, detail: chat.folder })
  return items
})

function runPalette(item: PaletteItem) {
  palette.value = false
  const [kind, ...rest] = item.id.split(':')
  const id = rest.join(':')
  if (kind === 'chat') { appView.value?.openChat(id); return }
  if (kind === 'space') {
    const pane = panes.value.find(entry => entry.workspace_id === id)
    if (pane) focusFromSidebar(pane.pane_id)
    return
  }
  if (id === 'new-chat') newChat()
  else if (id === 'reopen') void reopenClosed()
  else if (id === 'open-studio') { if (studioChatId.value) emit('open-studio-chat', studioChatId.value) }
  else if (id === 'new-tab') void appView.value?.newTab()
  else if (id === 'next-space') appView.value?.step(1)
  else if (id === 'prev-space') appView.value?.step(-1)
  else if (id === 'files') onAppPanel('files')
  else if (id === 'changes') onAppPanel('changes')
  else if (id === 'issues') onAppPanel('issues')
  else if (id === 'tools') appPanel.value = 'dock'
  else if (id === 'sidebar') appView.value?.toggleSidebar()
  else if (id === 'tui') herdrView.set('tui')
  else if (id === 'settings') window.location.hash = SETTINGS_HREF.slice(1)
  if (id !== 'settings' && id !== 'open-studio') focusTerminal()
}

/** Files and Issues open Studio's tools on that tab (Issues: the Inbox); Changes its own panel. A second click hides it. */
function onAppPanel(which: 'files' | 'changes' | 'issues') {
  if (which === 'changes') {
    appPanel.value = appPanel.value === 'changes' ? '' : 'changes'
    return
  }
  const tab = which === 'files' ? 'files' : 'inbox'
  if (appPanel.value === 'dock' && dock.tab.value === tab) { appPanel.value = ''; return }
  dock.tab.value = tab
  appPanel.value = 'dock'
}
function toggleTools() {
  if (appMode.value) appPanel.value = appPanel.value === 'dock' ? '' : 'dock'
  else dock.toggle()
}
const toolsOpen = computed(() => (appMode.value ? appPanel.value === 'dock' : dock.open.value))
onMounted(() => window.addEventListener('keydown', onListKeys, true))
onBeforeUnmount(() => window.removeEventListener('keydown', onListKeys, true))
/** Command Center's Inbox runs while this page is mounted; its count badges the Tools button. */
const commandCenter = useCommandCenter()
/** The pane herdr shows now, and its chat: what "Open in Studio" opens. */
const focusedPane = computed(() => {
  const id = herdr.bridge?.focusedPaneId || ''
  return (id && panes.value.find(pane => pane.pane_id === id)) || null
})
const studioChatId = computed(() => (machine.value ? '' : focusedPane.value?.studioSessionId || props.sessionId || ''))
/** Mission's tools start agents in the folder of the pane herdr shows. */
const dockWorkspace = computed(() => focusedPane.value?.foreground_cwd || focusedPane.value?.cwd || '')

/** A pane picked in the dock: herdr shows it (and the chat follows). */
function selectPane(paneId: string) {
  machine.value = ''
  void focusHerdrPane(paneId).catch((err: any) => toast.error(err?.message || String(err)))
  dock.picked()
  focusTerminal()
}
/** The open chat's pane; with no herdr chat open (sessionId ''), herdr shows its own focus. */
const linked = computed(() => (props.sessionId ? panes.value.find(pane => pane.studioSessionId === props.sessionId) ?? null : null))

const KEY_DEFAULTS = { prefix: 'ctrl+b', search: 'prefix+g', workspaces: 'prefix+w', settings: 'prefix+s', help: 'prefix+?', sidebar: 'prefix+b' }
const keys = computed(() => ({ ...KEY_DEFAULTS, ...(herdr.status?.keys || {}) }))
/** One-tap herdr keys: handy on a phone, where the prefix key is awkward. */
const keyButtons = computed(() => (['sidebar', 'search', 'workspaces', 'settings', 'help'] as const)
  .map(name => ({ name, combo: keys.value[name], bytes: herdrKeyBytes(keys.value[name], keys.value.prefix) }))
  .filter(button => button.bytes != null))

/** herdr's settings on the agents page (Studio uses hash routes). */
const SETTINGS_HREF = '#/studio/agents/herdr/settings'
const startingServer = ref(false)
async function startServer() {
  startingServer.value = true
  try { await herdr.startServer() } catch (err: any) { toast.error(err?.message || String(err)) } finally { startingServer.value = false }
}

function press(bytes: string | null) {
  if (bytes) terminal.value?.send(bytes)
}

/** herdr's "New Studio chat" key, when Studio's setup bound one. */
const newChatKey = computed(() => herdr.status?.keys?.newChat || '')

/**
 * New chat stays in herdr: herdr's New Studio chat picker opens here and the
 * agent it starts is a herdr pane and a Studio chat at once. Without that key,
 * Studio's new chat page.
 */
function newChat() {
  // The Herdr App layout has no herdr UI to open its picker in: Studio's new
  // chat, which opens in herdr by itself (every chat is a herdr space).
  if (appMode.value) { emit('new-chat'); return }
  const bytes = newChatKey.value ? herdrKeyBytes(newChatKey.value, keys.value.prefix) : null
  if (!bytes || !terminal.value?.send(bytes)) emit('new-chat')
}

/** herdr's "Reopen closed chat" key, when Studio's setup bound one. */
const reopenKey = computed(() => herdr.status?.keys?.reopen || '')
const reopening = ref(false)

/**
 * Reopen closed chat: Studio brings back the newest chat closed in herdr (a
 * pane, tab or space), linked to the same Studio chat, and shows it here.
 */
async function reopenClosed() {
  reopening.value = true
  try {
    const { reopened } = await reopenClosedHerdrChat()
    if (!reopened.length) { toast.info(t('herdr.reopenNothing')); return }
    await herdr.refresh()
    toast.success(t('herdr.reopened', { title: reopened.map(chat => chat.title || chat.sessionId).join(', ') }))
    emit('open-chat', reopened[0].sessionId)
    focusTerminal()
  } catch (err: any) {
    toast.error(err?.message || String(err))
  } finally {
    reopening.value = false
  }
}

/**
 * The chat follows herdr: switching agents inside herdr (its search, picker
 * or a new chat) opens that agent's Studio chat, so both show the same chat.
 * herdr's focus reports lag behind Studio's own focus requests, so reports
 * that disagree with a request Studio just made are stale and ignored, and
 * the first report after loading is not a switch.
 */
const STALE_FOCUS_MS = 2500
const focusedChat = computed(() => {
  const pane = herdr.bridge?.focusedPaneId || ''
  return { pane, chat: (pane && panes.value.find(item => item.pane_id === pane)?.studioSessionId) || '' }
})
watch(() => `${focusedChat.value.pane}|${focusedChat.value.chat}`, (_key, previous) => {
  const { pane, chat } = focusedChat.value
  if (!previous || previous.startsWith('|') || !props.active || machine.value || !chat || chat === props.sessionId) return
  if (Date.now() - studioFocusRequest.at < STALE_FOCUS_MS && pane !== studioFocusRequest.paneId) return
  emit('open-chat', chat)
})

/** herdr shows the focused pane: focus this chat's agent before and when switching chats. */
async function focusChat() {
  const pane = linked.value
  if (pane) await focusHerdrPane(pane.pane_id).catch(() => undefined)
}

// The terminal starts at once; focusing the chat's pane goes out first and
// lands while herdr's client attaches (waiting for it cost a round trip).
watch(() => props.active, value => {
  if (!value || started.value) return
  void focusChat()
  started.value = true
}, { immediate: true })
// A string key: only a different chat or pane refocuses (every herdr update makes new pane objects).
watch(() => `${props.sessionId}|${linked.value?.pane_id || ''}`, () => {
  if (started.value) void focusChat()
})

async function openHere() {
  opening.value = true
  try {
    const { link } = await openSessionInHerdr(props.sessionId)
    await herdr.refresh()
    await focusHerdrPane(link.paneId).catch(() => undefined)
    focusTerminal()
  } catch (err: any) {
    toast.error(err?.message || String(err))
  } finally {
    opening.value = false
  }
}

/**
 * In herdr mode, a chat whose agent is not running in herdr opens there by
 * itself (once per chat; the button stays for a retry if that fails).
 */
const autoOpened = new Set<string>()
watch(() => [props.active, props.sessionId, herdr.enabled, herdr.bridge?.connected, !!linked.value] as const, ([active, sessionId, enabled, connected, isLinked]) => {
  if (!active || machine.value || !sessionId || !enabled || !connected || isLinked || opening.value || autoOpened.has(sessionId)) return
  autoOpened.add(sessionId)
  void openHere()
}, { immediate: true })

/** herdr's actions for the page's own menu (phones, with `hostMenu`): one menu in the header row. */
interface HerdrMenuItem { key: string; label: string; disabled?: boolean }
const menuItems = computed<HerdrMenuItem[]>(() => {
  if (!props.hostMenu || !props.headerTarget || !dock.phone.value) return []
  const items: HerdrMenuItem[] = []
  if (machines.value.length) {
    items.push({ key: 'machine:', label: `${t('herdr.machineLocal')}${machine.value ? '' : ' ✓'}` })
    for (const item of machines.value) items.push({ key: `machine:${item.id}`, label: `${item.label || item.target}${machine.value === item.id ? ' ✓' : ''}` })
  }
  items.push({ key: 'view-mode', label: herdrView.mode.value === 'app' ? t('herdrApp.useTui') : t('herdrApp.useApp') })
  if (!appMode.value) items.push({ key: 'sidebar-mode', label: spaces.mode.value === 'studio' ? t('spaceFolders.useHerdrSidebar') : t('spaceFolders.useStudioSidebar') })
  if (studioChatId.value) items.push({ key: 'open-studio', label: t('mission.openInStudio') })
  if (!machine.value) {
    items.push({ key: 'new-chat', label: `+ ${t('chat.newChat')}` })
    items.push({ key: 'reopen', label: t('herdr.reopenClosed'), disabled: reopening.value })
  }
  if (appMode.value) items.push({ key: 'palette', label: t('herdrApp.palette.title') })
  else for (const button of keyButtons.value) items.push({ key: `key:${button.name}`, label: t(`herdr.key.${button.name}`) })
  return items
})

function runMenuItem(key: string) {
  if (key.startsWith('machine:')) {
    const id = key.slice('machine:'.length)
    if (id) void openMachine(id)
    else machine.value = ''
  } else if (key === 'view-mode') {
    herdrView.set(herdrView.mode.value === 'app' ? 'tui' : 'app')
  } else if (key === 'palette') {
    palette.value = true
  } else if (key === 'sidebar-mode') {
    spaces.setMode(spaces.mode.value === 'studio' ? 'herdr' : 'studio')
  } else if (key === 'open-studio') {
    if (studioChatId.value) emit('open-studio-chat', studioChatId.value)
  } else if (key === 'new-chat') {
    newChat()
  } else if (key === 'reopen') {
    void reopenClosed()
  } else if (key.startsWith('key:')) {
    press(keyButtons.value.find(button => button.name === key.slice(4))?.bytes ?? null)
  }
}

defineExpose({ menuItems, runMenuItem })

onMounted(() => {
  void loadMachines()
  herdr.acquire()
  commandCenter.acquire()
  if (!herdr.status) void herdr.refresh()
})
onBeforeUnmount(() => {
  herdr.release()
  commandCenter.release()
})
</script>

<template>
  <section class="herdr-center" data-testid="herdr-center">
    <div v-if="herdr.status && !herdr.enabled" class="herdr-center-empty">
      <p>{{ t('herdr.centerOff') }}</p>
      <a :href="SETTINGS_HREF" class="herdr-center-link" data-testid="herdr-center-settings">{{ t('sidebar.settings') }}</a>
    </div>
    <template v-else>
      <!-- herdr's connection, as the old herdr page showed it: the reason and a way to start it. -->
      <div v-if="herdr.status && !herdr.connected" class="herdr-center-notice" data-testid="herdr-center-notice">
        <span>{{ herdr.status?.error || herdr.error || t('herdr.disconnected') }}</span>
        <NButton v-if="herdr.status?.installed && !herdr.status?.server?.running" size="tiny" :loading="startingServer" data-testid="herdr-center-start" @click="startServer">{{ t('herdr.settings.startServer') }}</NButton>
        <a :href="SETTINGS_HREF" class="herdr-center-link">{{ t('sidebar.settings') }}</a>
      </div>
      <!--
        herdr's bar. In Studio it sits in the chat page's own header row (one row
        with the chat title and the Chat | herdr switch); elsewhere it is a row here.
        The less-used herdr keys fold into a "more" menu when the row is short, and
        on a phone everything but Tools does.
      -->
      <Teleport :to="headerTarget || 'body'" :disabled="!headerTarget">
        <div v-show="active || !headerTarget" class="herdr-center-bar" :class="{ 'in-header': !!headerTarget, 'is-phone': dock.phone.value }" data-testid="herdr-center-bar">
          <div v-if="machines.length && !dock.phone.value" class="herdr-center-machines" role="radiogroup" :aria-label="t('herdr.machineSwitch')" data-testid="herdr-center-machines">
            <button type="button" role="radio" :aria-checked="!machine" :class="{ active: !machine }" @click="machine = ''">{{ t('herdr.machineLocal') }}</button>
            <button
              v-for="item in machines"
              :key="item.id"
              type="button"
              role="radio"
              :aria-checked="machine === item.id"
              :class="{ active: machine === item.id }"
              :data-testid="`herdr-center-machine-${item.id}`"
              @click="openMachine(item.id)"
            >{{ item.label || item.target }}</button>
          </div>
          <span v-if="machine" class="herdr-center-agent" data-testid="herdr-center-remote-chip">{{ t('herdr.remoteChip', { name: machineLabel }) }}</span>
          <span v-else-if="linked && !dock.phone.value" class="herdr-center-agent" data-testid="herdr-center-agent" :title="linked.label || linked.agent">
            <AgentStatusIcon :status="linked.agent_status || 'unknown'" live :size="11" />
            <!-- In Studio's header the chat title is already there: just the agent and its pane. -->
            <span>{{ headerTarget ? linked.agent : (linked.label || linked.agent) }}</span>
            <small>{{ linked.pane_id }}</small>
          </span>
          <NButton v-else-if="sessionId && !machine && !linked" size="small" type="primary" :loading="opening" data-testid="herdr-center-open" @click="openHere">{{ t('herdr.centerOpenChat') }}</NButton>
          <span v-else-if="!machine && !linked && !headerTarget" class="herdr-center-landing" data-testid="herdr-center-landing">{{ t('herdr.centerLanding') }}</span>
          <span v-if="!headerTarget" class="herdr-center-spacer" />
          <template v-if="!dock.phone.value">
            <button
              v-if="studioChatId"
              type="button"
              class="herdr-center-key"
              data-testid="herdr-center-open-studio"
              @click="emit('open-studio-chat', studioChatId)"
            >{{ t('mission.openInStudio') }}</button>
            <button
              v-if="!machine"
              type="button"
              class="herdr-center-key herdr-center-new"
              data-testid="herdr-center-new-chat"
              :title="newChatKey ? newChatKey.replace(/^prefix\+/i, `${keys.prefix} then `) : undefined"
              @click="newChat"
            ><span aria-hidden="true">+</span> {{ t('chat.newChat') }}</button>
            <button
              v-if="!machine"
              type="button"
              class="herdr-center-key"
              data-testid="herdr-center-reopen"
              :disabled="reopening"
              :title="reopenKey ? reopenKey.replace(/^prefix\+/i, `${keys.prefix} then `) : undefined"
              @click="reopenClosed"
            >{{ t('herdr.reopenClosed') }}</button>
          </template>
          <!-- Phones in Studio's header: everything but Tools is in this menu (one row, always). -->
          <NPopover v-if="dock.phone.value && headerTarget && !hostMenu" v-model:show="phoneMenu" trigger="click" placement="bottom-end">
            <template #trigger>
              <NButton size="small" class="header-overflow-trigger herdr-center-more-button" :title="t('chat.more')" :aria-label="t('chat.more')" :aria-expanded="phoneMenu" data-testid="herdr-center-more">
                <template #icon>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="19" cy="12" r="2" /></svg>
                </template>
              </NButton>
            </template>
            <div class="herdr-center-menu">
              <div v-if="machines.length" class="herdr-center-machines" role="radiogroup" :aria-label="t('herdr.machineSwitch')">
                <button type="button" role="radio" :aria-checked="!machine" :class="{ active: !machine }" @click="fromMenu(() => { machine = '' })">{{ t('herdr.machineLocal') }}</button>
                <button
                  v-for="item in machines"
                  :key="item.id"
                  type="button"
                  role="radio"
                  :aria-checked="machine === item.id"
                  :class="{ active: machine === item.id }"
                  @click="fromMenu(() => openMachine(item.id))"
                >{{ item.label || item.target }}</button>
              </div>
              <button v-if="studioChatId" type="button" class="herdr-center-key" data-testid="herdr-center-open-studio" @click="fromMenu(() => emit('open-studio-chat', studioChatId))">{{ t('mission.openInStudio') }}</button>
              <button v-if="!machine" type="button" class="herdr-center-key herdr-center-new" data-testid="herdr-center-new-chat" @click="fromMenu(newChat)"><span aria-hidden="true">+</span> {{ t('chat.newChat') }}</button>
              <button v-if="!machine" type="button" class="herdr-center-key" data-testid="herdr-center-reopen" :disabled="reopening" @click="fromMenu(reopenClosed)">{{ t('herdr.reopenClosed') }}</button>
              <button v-if="!machine" type="button" class="herdr-center-key" data-testid="herdr-center-view-toggle" @click="fromMenu(() => herdrView.set(herdrView.mode.value === 'app' ? 'tui' : 'app'))">{{ herdrView.mode.value === 'app' ? t('herdrApp.useTui') : t('herdrApp.useApp') }}</button>
              <button v-if="appMode" type="button" class="herdr-center-key" data-testid="herdr-center-palette" @click="fromMenu(() => { palette = true })">{{ t('herdrApp.palette.title') }}</button>
              <template v-else>
                <button v-for="button in keyButtons" :key="button.name" type="button" class="herdr-center-key" :data-testid="`herdr-center-key-${button.name}`" @click="fromMenu(() => press(button.bytes))">
                  {{ t(`herdr.key.${button.name}`) }}
                </button>
              </template>
            </div>
          </NPopover>
          <HeaderActionOverflow v-else-if="!appMode && !(dock.phone.value && headerTarget && hostMenu)" :key="headerTarget ? 'header' : 'inline'" :label="t('chat.more')" :breakpoint="HEADER_ROOM" class="herdr-center-more" data-testid="herdr-center-more">
            <template v-if="dock.phone.value">
              <button v-if="studioChatId" type="button" class="herdr-center-key" data-testid="herdr-center-open-studio" @click="emit('open-studio-chat', studioChatId)">{{ t('mission.openInStudio') }}</button>
              <button v-if="!machine" type="button" class="herdr-center-key herdr-center-new" data-testid="herdr-center-new-chat" @click="newChat"><span aria-hidden="true">+</span> {{ t('chat.newChat') }}</button>
              <button v-if="!machine" type="button" class="herdr-center-key" data-testid="herdr-center-reopen" :disabled="reopening" @click="reopenClosed">{{ t('herdr.reopenClosed') }}</button>
            </template>
            <NTooltip v-for="button in keyButtons" :key="button.name" trigger="hover">
              <template #trigger>
                <button type="button" class="herdr-center-key" :data-testid="`herdr-center-key-${button.name}`" @click="press(button.bytes)">
                  {{ t(`herdr.key.${button.name}`) }}
                </button>
              </template>
              {{ button.combo.replace(/^prefix\+/i, `${keys.prefix} then `) }}
            </NTooltip>
          </HeaderActionOverflow>
          <!-- The page's look: the Herdr App layout, or herdr's own terminal UI. -->
          <button
            v-if="!machine && !dock.phone.value"
            type="button"
            class="herdr-center-key herdr-center-view-toggle"
            :class="{ active: herdrView.mode.value === 'tui' }"
            :aria-pressed="herdrView.mode.value === 'tui'"
            :title="herdrView.mode.value === 'app' ? t('herdrApp.useTui') : t('herdrApp.useApp')"
            data-testid="herdr-center-view-toggle"
            @click="herdrView.set(herdrView.mode.value === 'app' ? 'tui' : 'app')"
          >{{ t('herdrApp.tuiView') }}</button>
          <button
            v-if="!appMode"
            type="button"
            class="herdr-center-key herdr-center-spaces-toggle"
            :aria-expanded="spaces.open.value"
            aria-controls="herdr-spaces"
            :class="{ active: spaces.open.value, 'is-icon': dock.phone.value }"
            :title="spaces.mode.value === 'herdr' ? t('spaceFolders.useStudioSidebar') : t('spaceFolders.open')"
            :aria-label="t('spaceFolders.open')"
            data-testid="herdr-center-spaces-toggle"
            @click="spaces.toggle()"
          >
            <!-- A phone's one-row header has no room for the word: the sidebar glyph. -->
            <svg v-if="dock.phone.value" viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M4 5h16v14H4zM9 5v14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" /></svg>
            <template v-else>{{ t('spaceFolders.open') }}</template>
          </button>
          <button
            type="button"
            class="herdr-center-key herdr-center-dock-toggle"
            :class="{ active: toolsOpen }"
            :aria-expanded="toolsOpen"
            aria-controls="herdr-dock"
            data-testid="herdr-center-dock-toggle"
            @click="toggleTools()"
          >{{ t('herdr.dock.title') }}<span
            v-if="commandCenter.unseen.value"
            class="herdr-center-badge"
            data-testid="herdr-center-inbox-badge"
            :aria-label="t('commandCenter.inbox.new', { n: commandCenter.unseen.value })"
            :title="t('commandCenter.inbox.new', { n: commandCenter.unseen.value })"
          >{{ commandCenter.unseen.value > 99 ? '99+' : commandCenter.unseen.value }}</span></button>
        </div>
      </Teleport>
      <!-- The Herdr App layout: Studio draws herdr's chrome, each pane its own terminal. -->
      <div v-if="appMode && started" class="herdr-center-body is-app" :class="{ 'is-phone': dock.phone.value }">
        <HerdrAppView
          ref="appView"
          :panes="panes"
          :workspaces="herdrWorkspaces"
          :focused-pane="herdr.bridge?.focusedPaneId || ''"
          :awake="awakeChats"
          :active-chat="sessionId || focusedPane?.studioSessionId || ''"
          :machines="machines"
          :phone="dock.phone.value"
          :home="[herdr.status?.home || '', herdr.status?.homeReal || '']"
          :panel="appPanel"
          :dock-tab="dock.tab.value"
          :connected="herdr.connected"
          :waiting="waitingPanes"
          @open-chat="openFromSidebar"
          @focus-pane="focusFromSidebar"
          @open-machine="(id, pane) => { void openMachine(id, pane) }"
          @new-chat="newChat"
          @panel="onAppPanel"
          @palette="palette = true"
        >
          <template #panel>
            <HerdrChangesPanel v-if="appPanel === 'changes'" :pane-id="appView?.focusedPaneId || herdr.bridge?.focusedPaneId || ''" @close="appPanel = ''" />
            <HerdrMissionDock
              v-else-if="appPanel === 'dock'"
              id="herdr-dock"
              :tab="dock.tab.value"
              :panes="panes"
              :workspace="dockWorkspace"
              :drawer="dock.phone.value"
              @update:tab="value => { dock.tab.value = value }"
              @select-pane="pane => { appPanel = dock.phone.value ? '' : appPanel; void focusHerdrPane(pane).catch(() => undefined) }"
              @close="appPanel = ''"
            />
          </template>
        </HerdrAppView>
        <HerdrCommandPalette v-if="palette" :items="paletteItems" @run="runPalette" @close="palette = false; focusTerminal()" />
      </div>
      <div v-else class="herdr-center-body" :class="{ 'is-phone': dock.phone.value }">
        <!--
          Studio's Spaces sidebar (space folders): every chat in its folder, the
          same folders as Herdr App's Space Folders. herdr's own sidebar is hidden
          under it, or shows instead when picked. On a phone it slides over.
        -->
        <div v-if="dock.phone.value && spaces.open.value" class="herdr-spaces-backdrop" data-testid="herdr-spaces-backdrop" @click="spaces.setOpen(false)" />
        <HerdrSpaceSidebar
          v-if="spaces.mode.value === 'studio' && started"
          v-show="spaces.open.value"
          id="herdr-spaces"
          ref="spaceSidebar"
          class="herdr-center-spaces"
          :class="{ 'is-drawer': dock.phone.value }"
          :panes="panes"
          :workspaces="herdrWorkspaces"
          :awake="awakeChats"
          :active-chat="machine ? '' : (sessionId || focusedPane?.studioSessionId || '')"
          :focused-pane="herdr.bridge?.focusedPaneId || ''"
          :machines="machines"
          :drawer="dock.phone.value"
          @open-chat="openFromSidebar"
          @focus-pane="focusFromSidebar"
          @open-machine="(id, pane) => { spaces.picked(); void openMachine(id, pane) }"
          @new-chat="newChat"
          @use-herdr-sidebar="spaces.setMode('herdr')"
          @close="spaces.setOpen(false)"
        />
        <HerdrTerminal
          v-if="started"
          v-show="!machine"
          ref="localTerminal"
          class="herdr-center-terminal"
          mode="client"
          :sidebar="spaces.mode.value"
        />
        <!-- A saved machine's full herdr (its own sidebar included: it is that machine's UI). -->
        <HerdrTerminal
          v-if="machine"
          :key="machine"
          ref="remoteTerminal"
          class="herdr-center-terminal"
          mode="client"
          :target="`machine:${machine}`"
          data-testid="herdr-center-remote"
        />
        <!-- Mission's tools: beside the terminal, or a drawer over it on a phone. -->
        <div v-if="dock.phone.value && dock.open.value" class="herdr-dock-backdrop" data-testid="herdr-dock-backdrop" @click="dock.setOpen(false)" />
        <HerdrMissionDock
          v-if="dock.open.value"
          id="herdr-dock"
          class="herdr-center-dock"
          :class="{ 'is-drawer': dock.phone.value }"
          :tab="dock.tab.value"
          :panes="panes"
          :workspace="dockWorkspace"
          :drawer="dock.phone.value"
          @update:tab="value => { dock.tab.value = value }"
          @select-pane="selectPane"
          @close="dock.setOpen(false)"
        />
      </div>
    </template>
  </section>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.herdr-center {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
}

.herdr-center-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border-bottom: var(--border-width, 1px) solid $border-light;

  // In Studio's header row: one row, no frame of its own; if it is ever too
  // long it scrolls sideways inside the header, never the page.
  &.in-header {
    flex-wrap: nowrap;
    justify-content: flex-end;
    gap: 4px;
    min-width: 0;
    padding: 0;
    border-bottom: 0;
    overflow-x: auto;
    scrollbar-width: none;

    > * {
      flex: none;
    }
  }
}

.herdr-center-more {
  flex-wrap: nowrap;
  gap: 4px;
}

.herdr-center-more-button {
  width: 30px;
  padding: 0;

  :deep(.n-button__icon) {
    margin: 0;
  }
}

.herdr-center-menu {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 6px;
  min-width: 180px;

  .herdr-center-key {
    text-align: left;
  }
}

// Phones: the bar is one row that scrolls sideways (the page never does).
@media (max-width: 640px) {
  .herdr-center-bar {
    flex-wrap: nowrap;
    overflow-x: auto;
    scrollbar-width: none;

    > * {
      flex: none;
    }
  }

  .herdr-center-spacer {
    display: none;
  }
}

.herdr-center-agent {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  font-size: 12px;
  color: $text-primary;

  span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  small {
    color: $text-muted;
  }
}

.herdr-center-landing {
  font-size: 12px;
  color: $text-muted;
}

.herdr-center-machines {
  display: inline-flex;
  gap: 2px;
  padding: 2px;
  border: var(--border-width, 1px) solid $border-light;
  border-radius: 999px;

  button {
    padding: 2px 10px;
    border: 0;
    border-radius: 999px;
    background: transparent;
    color: $text-secondary;
    font-size: 12px;
    cursor: pointer;

    &.active {
      background: rgba(var(--accent-primary-rgb), 0.14);
      color: $text-primary;
    }
  }
}

.herdr-center-spacer {
  flex: 1 1 auto;
}

.herdr-center-key {
  white-space: nowrap;
  padding: 3px 10px;
  border: var(--border-width, 1px) solid $border-light;
  border-radius: 999px;
  background: transparent;
  color: $text-secondary;
  font-size: 12px;
  cursor: pointer;

  &:hover {
    color: $text-primary;
    border-color: $accent-primary;
  }
}

.herdr-center-link {
  font-size: 12px;
  color: $text-secondary;
}

.herdr-center-body {
  position: relative;
  display: flex;
  flex: 1 1 auto;
  gap: 6px;
  min-height: 0;
  min-width: 0;
}

.herdr-center-dock {
  flex: 0 0 clamp(280px, 28vw, 380px);

  &.is-drawer {
    position: absolute;
    z-index: 5;
    top: 0;
    right: 0;
    bottom: 0;
    width: min(360px, 88vw);
    box-shadow: -8px 0 24px rgba(0, 0, 0, 0.18);
  }
}

.herdr-center-spaces-toggle.is-icon {
  display: inline-flex;
  align-items: center;
  padding: 3px 7px;
}

.herdr-center-spaces {
  flex: 0 0 clamp(230px, 20vw, 300px);

  &.is-drawer {
    position: absolute;
    z-index: 5;
    top: 0;
    left: 0;
    bottom: 0;
    width: min(320px, 86vw);
    /* theme-exception: state -- the drawer's edge shadow over the terminal, as the Tools drawer has */
    box-shadow: 8px 0 24px rgba(0, 0, 0, 0.18);
  }
}

.herdr-dock-backdrop {
  position: absolute;
  z-index: 4;
  inset: 0;
  background: rgba(0, 0, 0, 0.28);
}

.herdr-spaces-backdrop {
  position: absolute;
  z-index: 4;
  inset: 0;
  /* theme-exception: state -- dims the terminal under the open Spaces drawer, like the Tools drawer */
  background: rgba(0, 0, 0, 0.28);
}

.herdr-center-badge {
  display: inline-block;
  min-width: 16px;
  margin-left: 5px;
  padding: 0 4px;
  border-radius: 999px;
  background: $warning;
  color: $bg-card;
  font-size: 10px;
  font-weight: 700;
  line-height: 16px;
  text-align: center;
}

.herdr-center-spaces-toggle.active,
.herdr-center-dock-toggle.active,
.herdr-center-back:hover {
  color: $text-primary;
  border-color: $accent-primary;
}

.herdr-center-terminal {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
}

.herdr-center-notice {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-bottom: var(--border-width, 1px) solid $border-light;
  background: rgba(var(--accent-primary-rgb), 0.06);
  color: $text-secondary;
  font-size: 12px;
}

.herdr-center-empty {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 8px;
  align-items: center;
  justify-content: center;
  margin: 0;
  color: $text-muted;
  font-size: 13px;
}
</style>
