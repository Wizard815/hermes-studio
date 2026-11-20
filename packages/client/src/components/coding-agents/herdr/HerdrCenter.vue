<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { NButton, NPopover, NTooltip, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import AgentStatusIcon from '@/components/common/AgentStatusIcon.vue'
import HerdrTerminal from './HerdrTerminal.vue'
import HerdrMissionDock from './HerdrMissionDock.vue'
import HeaderActionOverflow from '@/components/layout/HeaderActionOverflow.vue'
import { useHerdrDock } from './herdr-layout'
import { useHerdrStore } from '@/stores/hermes/herdr'
import { fetchHerdrMachines, focusHerdrMachineAgent, focusHerdrPane, openSessionInHerdr, reopenClosedHerdrChat, studioFocusRequest, type HerdrMachine, type HerdrPaneView } from '@/api/coding-agents/herdr'
import { herdrKeyBytes } from '@/utils/herdr-keys'

/**
 * The herdr page (Studio's chat page in herdr mode): herdr's own full UI on
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
}>(), { headerTarget: null })
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
  terminal.value?.focus()
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
    terminal.value?.focus()
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
    terminal.value?.focus()
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

onMounted(() => {
  void loadMachines()
  herdr.acquire()
  if (!herdr.status) void herdr.refresh()
})
onBeforeUnmount(() => herdr.release())
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
          <NPopover v-if="dock.phone.value && headerTarget" v-model:show="phoneMenu" trigger="click" placement="bottom-end">
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
              <button v-for="button in keyButtons" :key="button.name" type="button" class="herdr-center-key" :data-testid="`herdr-center-key-${button.name}`" @click="fromMenu(() => press(button.bytes))">
                {{ t(`herdr.key.${button.name}`) }}
              </button>
            </div>
          </NPopover>
          <HeaderActionOverflow v-else :key="headerTarget ? 'header' : 'inline'" :label="t('chat.more')" :breakpoint="HEADER_ROOM" class="herdr-center-more" data-testid="herdr-center-more">
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
          <button
            type="button"
            class="herdr-center-key herdr-center-dock-toggle"
            :class="{ active: dock.open.value }"
            :aria-expanded="dock.open.value"
            aria-controls="herdr-dock"
            data-testid="herdr-center-dock-toggle"
            @click="dock.toggle()"
          >{{ t('herdr.dock.title') }}</button>
        </div>
      </Teleport>
      <div class="herdr-center-body" :class="{ 'is-phone': dock.phone.value }">
        <!-- herdr's own sidebar lists every Studio chat as a space (folder path in its name). -->
        <HerdrTerminal
          v-if="started"
          v-show="!machine"
          ref="localTerminal"
          class="herdr-center-terminal"
          mode="client"
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

.herdr-dock-backdrop {
  position: absolute;
  z-index: 4;
  inset: 0;
  background: rgba(0, 0, 0, 0.28);
}

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
