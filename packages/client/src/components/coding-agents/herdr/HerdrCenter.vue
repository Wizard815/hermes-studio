<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { NButton, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import AgentStatusIcon from '@/components/common/AgentStatusIcon.vue'
import HerdrTerminal from './HerdrTerminal.vue'
import { useHerdrStore } from '@/stores/hermes/herdr'
import { openSessionInHerdr, type HerdrPaneView } from '@/api/coding-agents/herdr'
import { missionUrl } from '@/utils/mission-url'

/**
 * herdr in the chat page's center column: the chat's live agent pane, with
 * the other agents in its herdr space as tabs. Studio's sidebar, header and
 * tool panel stay; ChatPanel keeps this and the chat mounted together and
 * only shows one, so swapping is instant and nothing restarts.
 */
const props = defineProps<{ sessionId: string; active: boolean }>()

const { t } = useI18n()
const toast = useMessage()
const herdr = useHerdrStore()
const selected = ref('')
const control = ref(false)
const opening = ref(false)
/** Connect the terminal the first time the herdr center is shown, then keep it. */
const shown = ref(props.active)
watch(() => props.active, value => { if (value) shown.value = true })

const panes = computed<HerdrPaneView[]>(() => herdr.bridge?.panes || [])
const linked = computed(() => panes.value.find(pane => pane.studioSessionId === props.sessionId) ?? null)
/** Agents in the same herdr space as this chat's agent. */
const tabs = computed(() => {
  const space = linked.value?.workspace_id
  return space ? panes.value.filter(pane => pane.workspace_id === space && pane.agent) : []
})
const current = computed(() => panes.value.find(pane => pane.pane_id === selected.value) ?? linked.value)

watch(() => [props.sessionId, linked.value?.pane_id] as const, ([, paneId]) => {
  selected.value = paneId || ''
  control.value = false
}, { immediate: true })
watch(selected, () => { control.value = false })

function paneName(pane: HerdrPaneView): string {
  return pane.label || pane.terminal_title_stripped || pane.agent || pane.pane_id
}

async function openHere() {
  opening.value = true
  try {
    const { link } = await openSessionInHerdr(props.sessionId)
    await herdr.refresh()
    selected.value = link.paneId
  } catch (err: any) {
    toast.error(err?.message || String(err))
  } finally {
    opening.value = false
  }
}

onMounted(() => {
  herdr.acquire()
  if (!herdr.status) void herdr.refresh()
})
onBeforeUnmount(() => herdr.release())
</script>

<template>
  <section class="herdr-center" data-testid="herdr-center">
    <template v-if="!herdr.enabled">
      <p class="herdr-center-empty">{{ t('herdr.centerOff') }}</p>
    </template>
    <template v-else-if="current">
      <header class="herdr-center-bar">
        <nav class="herdr-center-tabs" role="tablist">
          <button
            v-for="pane in (tabs.length ? tabs : [current])"
            :key="pane.pane_id"
            type="button"
            role="tab"
            class="herdr-center-tab"
            :class="{ active: pane.pane_id === current.pane_id }"
            :aria-selected="pane.pane_id === current.pane_id"
            data-testid="herdr-center-tab"
            @click="selected = pane.pane_id"
          >
            <AgentStatusIcon :status="pane.agent_status || 'unknown'" live :size="11" />
            <span>{{ paneName(pane) }}</span>
            <small>{{ pane.agent }}</small>
          </button>
        </nav>
        <NButton size="small" quaternary data-testid="herdr-center-control" @click="control = !control">
          {{ control ? t('herdr.releaseControl') : t('herdr.takeControl') }}
        </NButton>
        <a class="herdr-center-link" :href="missionUrl({ pane: current.pane_id })">{{ t('herdr.centerMission') }}</a>
      </header>
      <!-- Stays connected once shown, so swapping back is instant. -->
      <HerdrTerminal
        v-if="shown"
        :key="`${current.pane_id}:${control}`"
        class="herdr-center-terminal"
        :mode="control ? 'control' : 'observe'"
        :target="current.pane_id"
        :takeover="control"
      />
    </template>
    <div v-else class="herdr-center-empty">
      <p>{{ t('herdr.centerNotLive') }}</p>
      <NButton size="small" type="primary" :loading="opening" data-testid="herdr-center-open" @click="openHere">{{ t('herdr.openInHerdr') }}</NButton>
    </div>
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
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-bottom: var(--border-width, 1px) solid $border-light;
}

.herdr-center-tabs {
  display: flex;
  flex: 1 1 auto;
  gap: 4px;
  min-width: 0;
  overflow-x: auto;
}

.herdr-center-tab {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 6px;
  max-width: 240px;
  padding: 4px 10px;
  border: var(--border-width, 1px) solid $border-light;
  border-radius: 999px;
  background: transparent;
  color: $text-secondary;
  font-size: 12px;
  cursor: pointer;

  span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  small {
    color: $text-muted;
  }

  &.active {
    color: $text-primary;
    border-color: $accent-primary;
    background: rgba(var(--accent-primary-rgb), 0.12);
  }
}

.herdr-center-link {
  flex: 0 0 auto;
  font-size: 12px;
  color: $text-secondary;
}

.herdr-center-terminal {
  flex: 1 1 auto;
  min-height: 0;
}

.herdr-center-empty {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  margin: 0;
  color: $text-muted;
  font-size: 13px;

  p {
    margin: 0;
  }
}
</style>
