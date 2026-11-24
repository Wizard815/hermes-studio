<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import HerdrTerminal from './HerdrTerminal.vue'
import HerdrSpaceSidebar from './HerdrSpaceSidebar.vue'
import HerdrAgentsList from './HerdrAgentsList.vue'
import type { SidebarChat } from './space-folders'
import { agentPanes, paneBox, paneHeader, phonePane } from './herdr-app-layout'
import {
  closeHerdrTab,
  createHerdrTab,
  fetchHerdrSpaceView,
  focusHerdrPane,
  focusHerdrTab,
  type HerdrMachine,
  type HerdrPaneView,
  type HerdrSpaceView,
} from '@/api/coding-agents/herdr'
import { deploymentUrl } from '@/utils/deployment-url'
import { chatSessionAgentAvatar } from '@/utils/chat-agent-avatar'

/**
 * Studio's herdr page in the Herdr App layout: the Herdr desktop app's chrome
 * with herdr-space-folders' `main-folders` layout, drawn in Vue.
 *
 *  - sidebar (268px): brand row, Spaces (space folders), Agents, footer
 *  - work: the space's tab bar (tabs, +, Files / Changes / Issues), its panes
 *    as herdr lays them out (each its own terminal), and the status bar
 *
 * Each pane is a `herdr terminal session control` stream of that pane alone
 * (not herdr's terminal UI). On a phone the sidebar is a drawer and one pane
 * shows at a time.
 */
const props = defineProps<{
  panes: HerdrPaneView[]
  workspaces: Array<{ workspace_id: string; label?: string; agent_status?: string }>
  focusedPane: string
  /** Chats elevated to herdr (null: unknown). */
  elevated: Set<string> | null
  activeChat: string
  machines: HerdrMachine[]
  phone: boolean
  /** The home folder (and its real path) for `~` in pane headers. */
  home: string[]
  /** The right-hand panel shown: Studio's tools dock, Changes, or none. */
  panel: '' | 'dock' | 'changes'
  /** The dock's tab while it shows (Files and Issues light up their buttons). */
  dockTab: string
  connected: boolean
  /** Chats' waiting panes (no agent running yet). */
  waiting?: ReadonlySet<string>
}>()
const emit = defineEmits<{
  'open-chat': [chat: SidebarChat, asleep: boolean, paneId: string]
  'focus-pane': [paneId: string]
  'open-machine': [machineId: string, paneId?: string]
  'new-chat': []
  panel: [which: 'files' | 'changes' | 'issues']
  palette: []
}>()
const { t } = useI18n()

// ---- sidebar ----
const SIDEBAR_KEY = 'studio_herdr_app_sidebar'
function readSidebar(): boolean {
  try { return localStorage.getItem(SIDEBAR_KEY) !== 'hidden' } catch { return true }
}
const wideSidebar = ref(readSidebar())
const drawer = ref(false)
const sidebarOpen = computed(() => (props.phone ? drawer.value : wideSidebar.value))
function toggleSidebar() {
  if (props.phone) drawer.value = !drawer.value
  else {
    wideSidebar.value = !wideSidebar.value
    try { localStorage.setItem(SIDEBAR_KEY, wideSidebar.value ? 'shown' : 'hidden') } catch { /* private mode */ }
  }
}
watch(() => props.phone, () => { drawer.value = false })
const searchOpen = ref(false)
const spaces = ref<InstanceType<typeof HerdrSpaceSidebar> | null>(null)
/** After picking in the drawer, the panes come back (phones). */
function picked() { if (props.phone) drawer.value = false }

function onOpenChat(chat: SidebarChat, asleep: boolean, paneId: string) {
  picked()
  emit('open-chat', chat, asleep, paneId)
}
function onFocusPane(paneId: string) {
  picked()
  emit('focus-pane', paneId)
}

const spaceName = (workspaceId: string) => props.workspaces.find(item => item.workspace_id === workspaceId)?.label || ''
const chatTitles = computed(() => new Map((spaces.value?.chatList || []).map(chat => [chat.id, chat.title])))
const chatTitle = (sessionId: string) => chatTitles.value.get(sessionId) || ''

// ---- the space shown: the one herdr has focused ----
const focused = computed(() => props.panes.find(pane => pane.pane_id === props.focusedPane) ?? null)
const workspaceId = computed(() => focused.value?.workspace_id || '')
const view = ref<HerdrSpaceView | null>(null)
const viewError = ref('')

/** What can change the space's tabs and layout: its panes, their tabs, and focus. */
const viewKey = computed(() => {
  const id = workspaceId.value
  if (!id) return ''
  const inSpace = props.panes.filter(pane => pane.workspace_id === id).map(pane => `${pane.pane_id}@${pane.tab_id || ''}`).join(',')
  return `${id}|${props.focusedPane}|${inSpace}`
})

let loadTimer = 0
let loadSeq = 0
async function loadView() {
  const id = workspaceId.value
  const seq = ++loadSeq
  if (!id || !props.connected) { view.value = null; return }
  try {
    const next = await fetchHerdrSpaceView(id)
    if (seq !== loadSeq) return
    view.value = next
    viewError.value = ''
  } catch (err: any) {
    if (seq === loadSeq) viewError.value = err?.message || String(err)
  }
}
function scheduleView(ms = 80) {
  if (loadTimer) window.clearTimeout(loadTimer)
  loadTimer = window.setTimeout(() => { loadTimer = 0; void loadView() }, ms)
}
watch([viewKey, () => props.connected], () => scheduleView(), { immediate: true })
onBeforeUnmount(() => { if (loadTimer) window.clearTimeout(loadTimer) })

const shownView = computed(() => (view.value && view.value.workspaceId === workspaceId.value ? view.value : null))
const tabs = computed(() => shownView.value?.tabs || [])
const paneById = computed(() => new Map(props.panes.map(pane => [pane.pane_id, pane])))
const layoutPanes = computed(() => shownView.value?.panes || [])
const herdrFocus = computed(() => shownView.value?.focusedPaneId || props.focusedPane)

// Phones: one pane at a time (the focused one; arrows step through the tab's panes).
const phoneShown = ref('')
watch([herdrFocus, layoutPanes], () => { phoneShown.value = phonePane(layoutPanes.value.map(pane => pane.pane_id), herdrFocus.value) }, { immediate: true })
const shownPanes = computed(() => (props.phone ? layoutPanes.value.filter(pane => pane.pane_id === phoneShown.value) : layoutPanes.value))
const phoneIndex = computed(() => Math.max(0, layoutPanes.value.findIndex(pane => pane.pane_id === phoneShown.value)))
function stepPane(step: number) {
  const next = phonePane(layoutPanes.value.map(pane => pane.pane_id), phoneShown.value, step)
  if (next) { phoneShown.value = next; void focusPane(next) }
}

function box(pane: { rect: HerdrSpaceView['panes'][number]['rect'] }) {
  return props.phone ? { left: '0', top: '0', width: '100%', height: '100%' } : paneBox(pane.rect)
}
function header(pane: HerdrSpaceView['panes'][number]) {
  const info = paneById.value.get(pane.pane_id) ?? null
  const base = paneHeader(info, pane.process, props.home)
  // A chat's waiting pane (its agent starts when you press Enter): the chat's name.
  if (props.waiting?.has(pane.pane_id) && info?.label) return { ...base, title: info.label, agent: false }
  // A chat's agent that herdr does not name (it runs under Studio's chat
  // wrapper, so its program is "sh"): the chat's agent, as Studio knows it.
  if (!base.agent && info?.studioSessionId && info.studioAgent && !props.waiting?.has(pane.pane_id)) {
    return { ...base, title: chatSessionAgentAvatar({ agent: info.studioAgent, codingAgentId: info.studioAgent, source: 'coding_agent' }).label, agent: true }
  }
  return base
}

const terminals = ref<Record<string, InstanceType<typeof HerdrTerminal> | null>>({})
async function focusPane(paneId: string) {
  if (!paneId || paneId === herdrFocus.value) return
  if (view.value) view.value = { ...view.value, focusedPaneId: paneId, panes: view.value.panes.map(pane => ({ ...pane, focused: pane.pane_id === paneId })) }
  await focusHerdrPane(paneId).catch(() => undefined)
}
function clickPane(paneId: string) {
  void focusPane(paneId)
  terminals.value[paneId]?.focus()
}

// ---- tabs ----
async function pickTab(tabId: string) {
  if (view.value) view.value = { ...view.value, tabs: view.value.tabs.map(tab => ({ ...tab, focused: tab.tab_id === tabId })) }
  await focusHerdrTab(tabId).catch(() => undefined)
  scheduleView(0)
}
async function closeTab(tabId: string) {
  await closeHerdrTab(tabId).catch(() => undefined)
  scheduleView(0)
}
async function newTab() {
  if (!workspaceId.value) return
  const created = await createHerdrTab(workspaceId.value).catch(() => null)
  if (created?.paneId) await focusHerdrPane(created.paneId).catch(() => undefined)
  scheduleView(0)
}

// ---- status bar ----
const agentCount = computed(() => agentPanes(props.panes, props.waiting).length)
const logo = deploymentUrl('/coding-agents/herdr-logo.svg')
const SETTINGS_HREF = '#/studio/agents/herdr/settings'

defineExpose({
  step: (dir: 1 | -1) => spaces.value?.step(dir) ?? false,
  chatList: () => spaces.value?.chatList || [],
  openChat: (id: string) => spaces.value?.openChat(id) ?? false,
  toggleSidebar,
  newTab,
  focusedPaneId: herdrFocus,
  focusTerminal: () => terminals.value[herdrFocus.value]?.focus(),
})
</script>

<template>
  <div class="hap" :class="{ 'is-phone': phone, 'no-sidebar': !sidebarOpen }" data-testid="herdr-app">
    <div v-if="phone && drawer" class="hap-backdrop" data-testid="herdr-app-backdrop" @click="drawer = false" />
    <aside v-show="sidebarOpen" class="hap-side" :class="{ 'is-drawer': phone }" data-testid="herdr-app-sidebar">
      <div class="hap-brand">
        <img class="hap-logo" :src="logo" alt="" />
        <span class="hap-brand-name">{{ t('herdrApp.brand') }}</span>
        <span class="hap-spacer" />
        <button type="button" class="hap-icon" :class="{ active: searchOpen }" :title="t('herdrApp.search')" :aria-label="t('herdrApp.search')" :aria-pressed="searchOpen" data-testid="herdr-app-search" @click="searchOpen = !searchOpen">
          <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" stroke-width="1.7" /><path d="M16 16l4 4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" /></svg>
        </button>
        <button type="button" class="hap-icon" :title="t('herdrApp.hideSidebar')" :aria-label="t('herdrApp.hideSidebar')" data-testid="herdr-app-collapse" @click="toggleSidebar">
          <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="15" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.6" /><path d="M9.5 4.5v15" stroke="currentColor" stroke-width="1.6" /></svg>
        </button>
      </div>
      <div class="hap-lists">
        <HerdrSpaceSidebar
          ref="spaces"
          variant="app"
          :search-open="searchOpen"
          :panes="panes"
          :workspaces="workspaces"
          :elevated="elevated"
          :active-chat="activeChat"
          :focused-pane="focusedPane"
          :machines="machines"
          :drawer="phone"
          @open-chat="onOpenChat"
          @focus-pane="onFocusPane"
          @open-machine="(id, pane) => { picked(); emit('open-machine', id, pane) }"
          @new-chat="emit('new-chat')"
        />
        <HerdrAgentsList :panes="panes" :focused-pane="focusedPane" :space-name="spaceName" :chat-title="chatTitle" :waiting="waiting" @focus-pane="onFocusPane" />
      </div>
      <nav class="hap-foot">
        <a :href="SETTINGS_HREF" class="hap-foot-item" data-testid="herdr-app-settings">
          <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="1.6" /><path d="M12 2.8v2.4M12 18.8v2.4M4.2 7.5l2.1 1.2M17.7 15.3l2.1 1.2M4.2 16.5l2.1-1.2M17.7 8.7l2.1-1.2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" /><circle cx="12" cy="12" r="7" fill="none" stroke="currentColor" stroke-width="1.6" /></svg>
          <span>{{ t('herdrApp.settings') }}</span>
        </a>
        <a :href="SETTINGS_HREF" class="hap-foot-item is-muted" data-testid="herdr-app-add-machine">
          <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" /></svg>
          <span>{{ t('herdrApp.addMachine') }}</span>
        </a>
      </nav>
    </aside>

    <main class="hap-work">
      <div class="hap-tabs" role="tablist" :aria-label="t('herdrApp.newTab')" data-testid="herdr-app-tabs">
        <button v-if="!sidebarOpen" type="button" class="hap-icon hap-expand" :title="t('herdrApp.showSidebar')" :aria-label="t('herdrApp.showSidebar')" data-testid="herdr-app-expand" @click="toggleSidebar">
          <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="15" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.6" /><path d="M9.5 4.5v15" stroke="currentColor" stroke-width="1.6" /></svg>
        </button>
        <div class="hap-tab-list">
          <div
            v-for="tab in tabs"
            :key="tab.tab_id"
            class="hap-tab"
            :class="{ active: tab.focused }"
            role="tab"
            :aria-selected="tab.focused"
            tabindex="0"
            :data-testid="`herdr-app-tab-${tab.tab_id}`"
            @click="pickTab(tab.tab_id)"
            @keydown.enter="pickTab(tab.tab_id)"
          >
            <svg class="hap-tab-glyph" viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path d="M5 7l5 5-5 5M12 18h7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" /></svg>
            <span class="hap-tab-label">{{ tab.label }}</span>
            <button type="button" class="hap-tab-close" :title="t('herdrApp.closeTab')" :aria-label="t('herdrApp.closeTab')" :data-testid="`herdr-app-tab-close-${tab.tab_id}`" @click.stop="closeTab(tab.tab_id)">×</button>
          </div>
        </div>
        <span class="hap-spacer" />
        <template v-if="phone && layoutPanes.length > 1">
          <button type="button" class="hap-icon" :aria-label="t('herdrApp.prevPane')" data-testid="herdr-app-pane-prev" @click="stepPane(-1)">‹</button>
          <span class="hap-pane-count">{{ t('herdrApp.paneOf', { n: phoneIndex + 1, total: layoutPanes.length }) }}</span>
          <button type="button" class="hap-icon" :aria-label="t('herdrApp.nextPane')" data-testid="herdr-app-pane-next" @click="stepPane(1)">›</button>
        </template>
        <button v-if="workspaceId" type="button" class="hap-icon" :title="t('herdrApp.newTab')" :aria-label="t('herdrApp.newTab')" data-testid="herdr-app-new-tab" @click="newTab">
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" /></svg>
        </button>
        <template v-if="!phone">
          <button type="button" class="hap-tool" :class="{ active: panel === 'dock' && dockTab === 'files' }" data-testid="herdr-app-files" @click="emit('panel', 'files')">
            <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M7 3.5h6.5L18 8v12.5H7z M13.5 3.5V8H18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" /></svg>
            <span>{{ t('herdrApp.files') }}</span>
          </button>
          <button type="button" class="hap-tool" :class="{ active: panel === 'changes' }" data-testid="herdr-app-changes-button" @click="emit('panel', 'changes')">
            <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><circle cx="7" cy="6" r="2" fill="none" stroke="currentColor" stroke-width="1.6" /><circle cx="17" cy="18" r="2" fill="none" stroke="currentColor" stroke-width="1.6" /><path d="M7 8v4a6 6 0 0 0 6 6h2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" /></svg>
            <span>{{ t('herdrApp.changes') }}</span>
          </button>
          <button type="button" class="hap-tool" :class="{ active: panel === 'dock' && dockTab === 'inbox' }" data-testid="herdr-app-issues" @click="emit('panel', 'issues')">
            <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="1.6" /><circle cx="12" cy="12" r="1.6" fill="currentColor" /></svg>
            <span>{{ t('herdrApp.issues') }}</span>
          </button>
        </template>
      </div>

      <div class="hap-body">
        <div class="hap-main" data-testid="herdr-app-panes">
          <div v-if="!workspaceId" class="hap-empty">
            <p>{{ t('herdrApp.noSpace') }}</p>
            <button type="button" class="hap-tool" @click="emit('new-chat')">+ {{ t('herdrApp.actions.newChat') }}</button>
          </div>
          <div v-else-if="shownView && !layoutPanes.length" class="hap-empty"><p>{{ t('herdrApp.noPanes') }}</p></div>
          <div
            v-for="pane in shownPanes"
            :key="pane.pane_id"
            class="hap-pane"
            :class="{ focused: pane.pane_id === herdrFocus }"
            :style="box(pane)"
            :data-testid="`herdr-app-pane-${pane.pane_id}`"
            data-herdr-pane
            @mousedown="focusPane(pane.pane_id)"
          >
            <div class="hap-pane-head" @click="clickPane(pane.pane_id)">
              <svg v-if="!header(pane).agent" class="hap-pane-glyph" viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><path d="M5 7l5 5-5 5M12 18h7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" /></svg>
              <span v-else class="hap-pane-dot" :class="`is-${paneById.get(pane.pane_id)?.agent_status || 'unknown'}`" aria-hidden="true" />
              <span class="hap-pane-title">{{ header(pane).title }}</span>
              <span class="hap-pane-detail">{{ header(pane).detail }}</span>
            </div>
            <HerdrTerminal
              :ref="el => { terminals[pane.pane_id] = el as any }"
              class="hap-term"
              mode="control"
              :target="pane.pane_id"
              takeover
              bare
              @focused="focusPane(pane.pane_id)"
            />
          </div>
        </div>
        <div v-if="panel" class="hap-panel" :class="{ 'is-drawer': phone }" data-testid="herdr-app-panel">
          <slot name="panel" />
        </div>
      </div>

      <footer class="hap-status" data-testid="herdr-app-status">
        <span class="hap-status-item">
          <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="11" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.6" /><path d="M9 19.5h6M12 15.5v4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" /></svg>
          {{ t('herdrApp.thisComputer') }}
        </span>
        <span class="hap-status-item">
          <span class="hap-status-dot" :class="{ live: connected }" aria-hidden="true" />
          {{ t('herdrApp.agentCount', agentCount) }}
        </span>
        <span class="hap-spacer" />
        <button type="button" class="hap-status-item hap-status-keys" data-testid="herdr-app-palette-button" @click="emit('palette')">
          <kbd v-if="!phone">Ctrl Shift P</kbd> {{ t('herdrApp.commands') }}
        </button>
      </footer>
    </main>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

// Herdr App's look: canvas behind everything, the chrome in the sidebar,
// panes as rounded framed cards (main-folders.json).
.hap {
  position: relative;
  display: flex;
  flex: 1 1 auto;
  min-height: 0;
  min-width: 0;
  overflow: hidden;
  background: var(--theme-content-bg, $bg-main-surface);
  color: $text-primary;
  font-family: $font-ui;
  font-size: 13.5px;
}

.hap-spacer {
  flex: 1 1 auto;
}

// ---- sidebar ----
.hap-side {
  display: flex;
  flex: none;
  flex-direction: column;
  width: 268px;
  min-height: 0;
  border-right: var(--border-width, 1px) solid $border-light;
  background: var(--theme-sidebar-bg, $bg-sidebar-surface);

  &.is-drawer {
    position: absolute;
    z-index: 6;
    top: 0;
    bottom: 0;
    left: 0;
    width: min(300px, 86vw);
    box-shadow: 4px 0 24px color-mix(in srgb, $text-primary 16%, transparent);
  }
}

.hap-backdrop {
  position: absolute;
  z-index: 5;
  inset: 0;
  background: color-mix(in srgb, $text-primary 22%, transparent);
}

.hap-brand {
  display: flex;
  flex: none;
  align-items: center;
  gap: 4px;
  height: 46px;
  padding: 0 12px 0 16px;
}

.hap-logo {
  width: 18px;
  height: 18px;
  margin-right: 6px;
  border-radius: 5px;
}

.hap-brand-name {
  font-size: 14px;
  font-weight: 500;
}

.hap-icon {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: $text-muted;
  font-size: 17px;
  cursor: pointer;

  &:hover,
  &.active {
    color: $text-primary;
    background: rgba(var(--accent-primary-rgb), 0.08);
  }
}

.hap-lists {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  min-height: 0;

  > :deep(.sf) {
    flex: 1 1 0;
    min-height: 90px;
  }
}

.hap-foot {
  display: flex;
  flex: none;
  flex-direction: column;
  justify-content: center;
  gap: 2px;
  height: 69px;
  padding: 0 8px;
  border-top: var(--border-width, 1px) solid $border-light;
}

.hap-foot-item {
  display: flex;
  align-items: center;
  gap: 9px;
  height: 28px;
  padding: 0 10px;
  border-radius: 6px;
  color: $text-primary;
  font-size: 13.5px;
  text-decoration: none;

  svg {
    color: $text-muted;
  }

  &.is-muted {
    color: $text-muted;
  }

  &:hover {
    background: rgba(var(--accent-primary-rgb), 0.07);
    color: $text-primary;
  }
}

// ---- work column ----
.hap-work {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}

.hap-tabs {
  display: flex;
  flex: none;
  align-items: center;
  gap: 4px;
  height: 42px;
  padding: 0 10px 0 8px;
  border-bottom: var(--border-width, 1px) solid $border-light;
}

.hap-tab-list {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  overflow-x: auto;
  scrollbar-width: none;
}

.hap-tab {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 7px;
  height: 30px;
  padding: 0 6px 0 10px;
  border: var(--border-width, 1px) solid transparent;
  border-radius: 7px;
  color: $text-secondary;
  font-size: 13px;
  cursor: pointer;
  user-select: none;

  &:hover {
    background: rgba(var(--accent-primary-rgb), 0.06);
  }

  &.active {
    border-color: $border-light;
    background: var(--theme-card-bg, $bg-card);
    color: $text-primary;
  }
}

.hap-tab-glyph {
  color: $text-muted;
}

.hap-tab-label {
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.hap-tab-close {
  width: 18px;
  height: 18px;
  padding: 0;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: $text-muted;
  font-size: 14px;
  line-height: 1;
  cursor: pointer;

  &:hover {
    color: $text-primary;
    background: rgba(var(--accent-primary-rgb), 0.12);
  }
}

.hap-tool {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 9px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: $text-secondary;
  font-size: 13px;
  cursor: pointer;

  &:hover,
  &.active {
    color: $text-primary;
    background: rgba(var(--accent-primary-rgb), 0.08);
  }
}

.hap-pane-count {
  font-size: 12px;
  color: $text-muted;
  white-space: nowrap;
}

.hap-body {
  display: flex;
  flex: 1 1 auto;
  gap: 8px;
  min-height: 0;
  padding: 8px;
}

.hap-main {
  position: relative;
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
}

.hap-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  height: 100%;
  color: $text-muted;
  font-size: 13px;
  text-align: center;
}

.hap-pane {
  position: absolute;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  border: 1px solid $border-light;
  border-radius: 10px;
  background: var(--theme-card-bg, $bg-card);

  &.focused {
    border-color: $accent-primary;
  }
}

.hap-pane-head {
  display: flex;
  flex: none;
  align-items: center;
  gap: 7px;
  height: 30px;
  padding: 0 12px;
  border-bottom: var(--border-width, 1px) solid $border-light;
  font-size: 12.5px;
  cursor: default;
}

.hap-pane-glyph {
  flex: none;
  color: $text-muted;
}

.hap-pane-dot {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 999px;
  border: 1.5px solid $text-muted;

  &.is-working { border-color: $warning; background: $warning; }
  &.is-blocked { border-color: $error; background: $error; }
  &.is-done { border-color: $success; background: $success; }
}

.hap-pane-title {
  flex: none;
  color: $text-primary;
  font-weight: 500;
}

.hap-pane-detail {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: $text-muted;
}

.hap-term {
  flex: 1 1 auto;
  min-height: 0;
}

.hap-panel {
  display: flex;
  flex: none;
  flex-direction: column;
  width: 368px;
  min-width: 280px;
  min-height: 0;

  > :deep(*) {
    flex: 1 1 auto;
    min-height: 0;
  }

  &.is-drawer {
    position: absolute;
    z-index: 6;
    top: 50px;
    right: 8px;
    bottom: 36px;
    width: min(368px, calc(100% - 16px));
  }
}

.hap-status {
  display: flex;
  flex: none;
  align-items: center;
  gap: 16px;
  height: 28px;
  padding: 0 12px;
  border-top: var(--border-width, 1px) solid $border-light;
  color: $text-secondary;
  font-size: 12px;
}

.hap-status-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;

  svg {
    color: $text-muted;
  }
}

.hap-status-dot {
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: $text-muted;

  &.live {
    background: $success;
  }
}

.hap-status-keys {
  padding: 0;
  border: 0;
  background: transparent;
  color: $text-muted;
  font-size: 12px;
  cursor: pointer;

  kbd {
    font-family: inherit;
    letter-spacing: 0.02em;
  }

  &:hover {
    color: $text-primary;
  }
}

// ---- phone: the sidebar is a drawer, one pane at a time ----
.hap.is-phone {
  .hap-tabs {
    padding: 0 6px;
  }

  .hap-body {
    padding: 6px;
  }

  .hap-status {
    gap: 10px;
    padding: 0 10px;
  }
}
</style>
