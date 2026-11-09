<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { NButton, NTooltip, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import AgentStatusIcon from '@/components/common/AgentStatusIcon.vue'
import HerdrTerminal from './HerdrTerminal.vue'
import { useHerdrStore } from '@/stores/hermes/herdr'
import { fetchHerdrMachines, focusHerdrMachineAgent, focusHerdrPane, openSessionInHerdr, studioFocusRequest, type HerdrMachine, type HerdrPaneView } from '@/api/coding-agents/herdr'
import { missionUrl } from '@/utils/mission-url'
import { herdrKeyBytes } from '@/utils/herdr-keys'
import HerdrSpacesPanel from './HerdrSpacesPanel.vue'

/**
 * herdr in the chat page's center column: herdr's own full UI (its key bar,
 * search, pickers and settings), opened on this chat's agent. Studio's
 * sidebar, header and tool panel stay; ChatPanel keeps this and the chat
 * mounted together and only shows one, so swapping is instant.
 */
const props = defineProps<{ sessionId: string; active: boolean }>()
const emit = defineEmits<{ 'open-chat': [sessionId: string]; 'new-chat': [] }>()

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
/** The open chat's pane; with no herdr chat open (sessionId ''), herdr shows its own focus. */
const linked = computed(() => (props.sessionId ? panes.value.find(pane => pane.studioSessionId === props.sessionId) ?? null : null))

const KEY_DEFAULTS = { prefix: 'ctrl+b', search: 'prefix+g', workspaces: 'prefix+w', settings: 'prefix+s', help: 'prefix+?', sidebar: 'prefix+b' }
const keys = computed(() => ({ ...KEY_DEFAULTS, ...(herdr.status?.keys || {}) }))
/** One-tap herdr keys: handy on a phone, where the prefix key is awkward. */
const keyButtons = computed(() => (['search', 'workspaces', 'settings', 'help'] as const)
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

watch(() => props.active, async value => {
  if (!value || started.value) return
  await focusChat()
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
      <header class="herdr-center-bar">
        <div v-if="machines.length" class="herdr-center-machines" role="radiogroup" :aria-label="t('herdr.machineSwitch')" data-testid="herdr-center-machines">
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
        <span v-else-if="linked" class="herdr-center-agent" data-testid="herdr-center-agent">
          <AgentStatusIcon :status="linked.agent_status || 'unknown'" live :size="11" />
          <span>{{ linked.label || linked.agent }}</span>
          <small>{{ linked.pane_id }}</small>
        </span>
        <NButton v-else-if="sessionId && !machine" size="small" type="primary" :loading="opening" data-testid="herdr-center-open" @click="openHere">{{ t('herdr.centerOpenChat') }}</NButton>
        <span v-else-if="!machine" class="herdr-center-landing" data-testid="herdr-center-landing">{{ t('herdr.centerLanding') }}</span>
        <span class="herdr-center-spacer" />
        <NTooltip v-for="button in keyButtons" :key="button.name" trigger="hover">
          <template #trigger>
            <button type="button" class="herdr-center-key" :data-testid="`herdr-center-key-${button.name}`" @click="press(button.bytes)">
              {{ t(`herdr.key.${button.name}`) }}
            </button>
          </template>
          {{ button.combo.replace(/^prefix\+/i, `${keys.prefix} then `) }}
        </NTooltip>
        <a class="herdr-center-link" :href="missionUrl(linked ? { pane: linked.pane_id } : {})">{{ t('herdr.centerMission') }}</a>
      </header>
      <div class="herdr-center-body">
        <!-- Studio's spaces (its folders) and agents stand in for herdr's own sidebar, whose rail is cropped off. -->
        <aside class="herdr-center-rail" data-testid="herdr-center-rail">
          <HerdrSpacesPanel
            :active-session-id="sessionId"
            :new-chat-key="newChatKey"
            :machines="machines"
            :machine="machine"
            @open-chat="id => { machine = ''; emit('open-chat', id) }"
            @select-local="machine = ''"
            @open-machine="openMachine"
            @new-chat="machine = ''; newChat()"
          />
        </aside>
        <HerdrTerminal
          v-if="started"
          v-show="!machine"
          ref="localTerminal"
          class="herdr-center-terminal"
          mode="client"
          :crop-left="herdr.status?.view?.rail ?? 4"
          :crop-above="herdr.status?.view?.mobileWidth ?? 64"
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
  display: flex;
  flex: 1 1 auto;
  min-height: 0;
}

.herdr-center-rail {
  display: flex;
  flex: 0 0 260px;
  flex-direction: column;
  min-height: 0;
  border-right: var(--border-width, 1px) solid $border-light;
}

.herdr-center-terminal {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
}

@media (max-width: 768px) {
  .herdr-center-rail {
    display: none;
  }
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
