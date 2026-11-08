<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { NButton, NTooltip, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import AgentStatusIcon from '@/components/common/AgentStatusIcon.vue'
import HerdrTerminal from './HerdrTerminal.vue'
import { useHerdrStore } from '@/stores/hermes/herdr'
import { focusHerdrPane, openSessionInHerdr, type HerdrPaneView } from '@/api/coding-agents/herdr'
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
const terminal = ref<InstanceType<typeof HerdrTerminal> | null>(null)
/** The herdr client starts the first time this is shown, then stays connected. */
const started = ref(false)

const panes = computed<HerdrPaneView[]>(() => herdr.bridge?.panes || [])
const linked = computed(() => panes.value.find(pane => pane.studioSessionId === props.sessionId) ?? null)

const KEY_DEFAULTS = { prefix: 'ctrl+b', search: 'prefix+g', workspaces: 'prefix+w', settings: 'prefix+s', help: 'prefix+?', sidebar: 'prefix+b' }
const keys = computed(() => ({ ...KEY_DEFAULTS, ...(herdr.status?.keys || {}) }))
/** One-tap herdr keys: handy on a phone, where the prefix key is awkward. */
const keyButtons = computed(() => (['search', 'workspaces', 'settings', 'help'] as const)
  .map(name => ({ name, combo: keys.value[name], bytes: herdrKeyBytes(keys.value[name], keys.value.prefix) }))
  .filter(button => button.bytes != null))

function press(bytes: string | null) {
  if (bytes) terminal.value?.send(bytes)
}

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
watch(() => [props.sessionId, linked.value?.pane_id] as const, () => {
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
  if (!active || !enabled || !connected || isLinked || opening.value || autoOpened.has(sessionId)) return
  autoOpened.add(sessionId)
  void openHere()
}, { immediate: true })

onMounted(() => {
  herdr.acquire()
  if (!herdr.status) void herdr.refresh()
})
onBeforeUnmount(() => herdr.release())
</script>

<template>
  <section class="herdr-center" data-testid="herdr-center">
    <p v-if="!herdr.enabled" class="herdr-center-empty">{{ t('herdr.centerOff') }}</p>
    <template v-else>
      <header class="herdr-center-bar">
        <span v-if="linked" class="herdr-center-agent" data-testid="herdr-center-agent">
          <AgentStatusIcon :status="linked.agent_status || 'unknown'" live :size="11" />
          <span>{{ linked.label || linked.agent }}</span>
          <small>{{ linked.pane_id }}</small>
        </span>
        <NButton v-else size="small" type="primary" :loading="opening" data-testid="herdr-center-open" @click="openHere">{{ t('herdr.centerOpenChat') }}</NButton>
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
          <HerdrSpacesPanel :active-session-id="sessionId" @open-chat="id => emit('open-chat', id)" @new-chat="emit('new-chat')" />
        </aside>
        <HerdrTerminal
          v-if="started"
          ref="terminal"
          class="herdr-center-terminal"
          mode="client"
          :crop-left="herdr.status?.view?.rail ?? 4"
          :crop-above="herdr.status?.view?.mobileWidth ?? 64"
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

.herdr-center-empty {
  display: flex;
  flex: 1 1 auto;
  align-items: center;
  justify-content: center;
  margin: 0;
  color: $text-muted;
  font-size: 13px;
}
</style>
