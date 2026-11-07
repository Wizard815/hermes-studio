<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { NButton, NInput, NModal, NSelect, NSpin, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import AgentStatusIcon from '@/components/common/AgentStatusIcon.vue'
import HerdrTerminal from '@/components/coding-agents/herdr/HerdrTerminal.vue'
import HerdrSettingsPanel from '@/components/coding-agents/herdr/HerdrSettingsPanel.vue'
import { fetchCodingAgentsStatus, type CodingAgentToolStatus } from '@/api/coding-agents'
import { focusHerdrPane, launchHerdrAgent, type HerdrPaneView, type HerdrStatusValue } from '@/api/coding-agents/herdr'
import { useHerdrStore } from '@/stores/hermes/herdr'
import { useAppStore } from '@/stores/hermes/app'

type Tab = 'herdr' | 'agents' | 'settings'

/** Studio coding agents herdr can host (see services/herdr/protocol.ts). */
const HERDR_AGENTS = new Set(['claude-code', 'codex', 'pi', 'grok', 'opencode', 'cursor', 'antigravity', 'qwen', 'kimi', 'qoder', 'copilot'])

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const toast = useMessage()
const herdr = useHerdrStore()
const appStore = useAppStore()

const tab = ref<Tab>(route.query.tab === 'agents' || route.query.tab === 'settings' ? route.query.tab : 'herdr')
const selectedPaneId = ref<string>(typeof route.query.pane === 'string' ? route.query.pane : '')
const control = ref(false)
const showLaunch = ref(false)
const launching = ref(false)
const tools = ref<CodingAgentToolStatus[]>([])
const launchForm = ref({ agentId: '', provider: '', model: '', workspace: '', title: '' })

const ready = computed(() => herdr.enabled && herdr.status?.installed)
const panes = computed(() => herdr.bridge?.panes ?? [])
const agentPanes = computed(() => panes.value.filter(pane => pane.agent))
const groups = computed(() => (herdr.bridge?.workspaces ?? []).map(workspace => ({
  workspace,
  panes: agentPanes.value.filter(pane => pane.workspace_id === workspace.workspace_id),
})).filter(group => group.panes.length > 0))
const selectedPane = computed(() => panes.value.find(pane => pane.pane_id === selectedPaneId.value) ?? null)
const counts = computed(() => {
  const result: Record<HerdrStatusValue, number> = { working: 0, blocked: 0, done: 0, idle: 0, unknown: 0 }
  for (const pane of agentPanes.value) result[pane.agent_status || 'unknown'] += 1
  return result
})

const agentOptions = computed(() => tools.value
  .filter(tool => tool.installed && HERDR_AGENTS.has(tool.id))
  .map(tool => ({ label: tool.name, value: tool.id })))
const providerGroups = computed(() => {
  const profile = herdr.status?.settings.profile || 'default'
  return appStore.profileModelGroups.find(entry => entry.profile === profile)?.groups ?? []
})
const providerOptions = computed(() => [
  { label: t('herdr.launch.agentDefault'), value: '' },
  ...providerGroups.value.map(group => ({ label: group.label || group.provider, value: group.provider })),
])
const modelOptions = computed(() => (providerGroups.value.find(group => group.provider === launchForm.value.provider)?.models ?? [])
  .map(model => ({ label: model, value: model })))

watch(() => launchForm.value.provider, () => { launchForm.value.model = modelOptions.value[0]?.value ?? '' })

watch(agentPanes, list => {
  if (selectedPaneId.value && panes.value.some(pane => pane.pane_id === selectedPaneId.value)) return
  // Prefer something that needs attention.
  const pick = list.find(pane => pane.agent_status === 'blocked') || list.find(pane => pane.agent_status === 'working') || list[0]
  selectedPaneId.value = pick?.pane_id ?? ''
}, { immediate: true })

watch(tab, value => {
  void router.replace({ query: { ...route.query, tab: value === 'herdr' ? undefined : value } })
})
watch(selectedPaneId, () => { control.value = false })

function paneTitle(pane: HerdrPaneView): string {
  return pane.label || pane.terminal_title_stripped || pane.agent || pane.pane_id
}

function openChat(pane: HerdrPaneView) {
  if (pane.studioSessionId) void router.push({ name: 'hermes.session', params: { sessionId: pane.studioSessionId } })
}

async function selectPane(pane: HerdrPaneView) {
  selectedPaneId.value = pane.pane_id
  try { await focusHerdrPane(pane.pane_id) } catch { /* focus is cosmetic */ }
}

async function openLaunch() {
  showLaunch.value = true
  if (!tools.value.length) {
    try { tools.value = (await fetchCodingAgentsStatus()).tools } catch (err: any) { toast.error(err?.message || String(err)) }
  }
  if (!launchForm.value.agentId) launchForm.value.agentId = agentOptions.value[0]?.value ?? ''
  if (!appStore.profileModelGroups.length) void appStore.loadModels?.()
}

async function launch() {
  if (!launchForm.value.agentId) return
  launching.value = true
  try {
    const { link } = await launchHerdrAgent({
      agentId: launchForm.value.agentId,
      provider: launchForm.value.provider || undefined,
      model: launchForm.value.provider ? launchForm.value.model || undefined : undefined,
      workspace: launchForm.value.workspace.trim() || undefined,
      title: launchForm.value.title.trim() || undefined,
    })
    showLaunch.value = false
    selectedPaneId.value = link.paneId
    tab.value = 'agents'
  } catch (err: any) {
    toast.error(err?.message || String(err))
  } finally {
    launching.value = false
  }
}

function backToStudio() {
  if (window.history.length > 1) router.back()
  else void router.push({ name: 'hermes.chat' })
}

onMounted(async () => {
  herdr.acquire()
  await herdr.refresh()
  if (!ready.value) tab.value = 'settings'
})
onBeforeUnmount(() => herdr.release())
</script>

<template>
  <div class="herdr-view" data-testid="herdr-view">
    <header class="herdr-view-bar" data-theme-surface="card">
      <div class="herdr-view-title">
        <strong>herdr</strong>
        <span class="herdr-view-conn" :data-connected="herdr.connected">
          {{ herdr.connected ? t('herdr.connected') : (herdr.enabled ? t('herdr.disconnected') : t('herdr.off')) }}
        </span>
        <span v-if="agentPanes.length" class="herdr-view-counts">
          <span v-for="status in (['blocked', 'working', 'done', 'idle'] as const)" :key="status" class="herdr-view-count">
            <AgentStatusIcon :status="status" live :size="11" /> {{ counts[status] }}
          </span>
        </span>
      </div>
      <nav class="herdr-view-tabs" data-theme-surface="input">
        <button type="button" :class="{ active: tab === 'herdr' }" :disabled="!ready" data-testid="herdr-tab-ui" @click="tab = 'herdr'">{{ t('herdr.tabs.ui') }}</button>
        <button type="button" :class="{ active: tab === 'agents' }" :disabled="!ready" data-testid="herdr-tab-agents" @click="tab = 'agents'">{{ t('herdr.tabs.agents') }}</button>
        <button type="button" :class="{ active: tab === 'settings' }" data-testid="herdr-tab-settings" @click="tab = 'settings'">{{ t('herdr.tabs.settings') }}</button>
      </nav>
      <div class="herdr-view-actions">
        <NButton v-if="ready" size="small" data-testid="herdr-new-agent" @click="openLaunch">{{ t('herdr.launch.button') }}</NButton>
        <NButton size="small" type="primary" data-testid="herdr-back-to-studio" @click="backToStudio">{{ t('herdr.backToStudio') }}</NButton>
      </div>
    </header>

    <p v-if="herdr.error || herdr.status?.error" class="herdr-view-error">{{ herdr.error || herdr.status?.error }}</p>

    <NSpin v-if="herdr.loading && !herdr.status" class="herdr-view-loading" />

    <main v-else class="herdr-view-body">
      <HerdrSettingsPanel v-if="tab === 'settings' || !ready" />

      <HerdrTerminal v-else-if="tab === 'herdr'" mode="client" class="herdr-view-full" />

      <div v-else class="herdr-view-agents">
        <aside class="herdr-view-list" data-theme-surface="card" data-testid="herdr-agent-list">
          <p v-if="!groups.length" class="herdr-view-empty">{{ t('herdr.noAgents') }}</p>
          <section v-for="group in groups" :key="group.workspace.workspace_id" class="herdr-view-group">
            <h4>
              <AgentStatusIcon :status="group.workspace.agent_status || 'unknown'" live :size="11" />
              {{ group.workspace.label || group.workspace.workspace_id }}
            </h4>
            <button
              v-for="pane in group.panes"
              :key="pane.pane_id"
              type="button"
              class="herdr-view-pane"
              :class="{ active: pane.pane_id === selectedPaneId }"
              :data-status="pane.agent_status"
              data-testid="herdr-pane-row"
              @click="selectPane(pane)"
            >
              <AgentStatusIcon :status="pane.agent_status || 'unknown'" live />
              <span class="herdr-view-pane-name">{{ paneTitle(pane) }}</span>
              <span class="herdr-view-pane-agent">{{ pane.agent }}</span>
              <span
                v-if="pane.studioSessionId"
                class="herdr-view-pane-chat"
                role="link"
                tabindex="0"
                :title="t('herdr.openChat')"
                @click.stop="openChat(pane)"
                @keydown.enter.stop="openChat(pane)"
              >{{ t('herdr.chat') }}</span>
            </button>
          </section>
        </aside>
        <section class="herdr-view-pane-view">
          <template v-if="selectedPane">
            <div class="herdr-view-pane-bar">
              <AgentStatusIcon :status="selectedPane.agent_status || 'unknown'" live />
              <strong>{{ paneTitle(selectedPane) }}</strong>
              <span class="herdr-view-pane-id">{{ selectedPane.pane_id }}</span>
              <span class="herdr-view-spacer" />
              <NButton v-if="selectedPane.studioSessionId" size="tiny" @click="openChat(selectedPane)">{{ t('herdr.openChat') }}</NButton>
              <NButton size="tiny" :type="control ? 'warning' : 'default'" data-testid="herdr-take-control" @click="control = !control">
                {{ control ? t('herdr.releaseControl') : t('herdr.takeControl') }}
              </NButton>
            </div>
            <HerdrTerminal
              :key="selectedPane.pane_id"
              :mode="control ? 'control' : 'observe'"
              :target="selectedPane.pane_id"
              :takeover="control"
            />
          </template>
          <p v-else class="herdr-view-empty">{{ t('herdr.selectAgent') }}</p>
        </section>
      </div>
    </main>

    <NModal v-model:show="showLaunch" preset="card" :title="t('herdr.launch.title')" class="herdr-launch-modal" :style="{ width: 'min(480px, calc(100vw - 32px))' }">
      <div class="herdr-launch-form">
        <label>
          <span>{{ t('herdr.launch.agent') }}</span>
          <NSelect v-model:value="launchForm.agentId" :options="agentOptions" data-testid="herdr-launch-agent" />
        </label>
        <label>
          <span>{{ t('herdr.launch.provider') }}</span>
          <NSelect v-model:value="launchForm.provider" :options="providerOptions" />
        </label>
        <label v-if="launchForm.provider">
          <span>{{ t('herdr.launch.model') }}</span>
          <NSelect v-model:value="launchForm.model" :options="modelOptions" filterable tag />
        </label>
        <label>
          <span>{{ t('herdr.launch.workspace') }}</span>
          <NInput v-model:value="launchForm.workspace" :placeholder="t('herdr.launch.workspacePlaceholder')" />
        </label>
        <label>
          <span>{{ t('herdr.launch.name') }}</span>
          <NInput v-model:value="launchForm.title" />
        </label>
        <p class="herdr-launch-hint">{{ t('herdr.launch.hint') }}</p>
        <NButton type="primary" block :loading="launching" :disabled="!launchForm.agentId" data-testid="herdr-launch-submit" @click="launch">
          {{ t('herdr.launch.start') }}
        </NButton>
      </div>
    </NModal>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.herdr-view {
  display: flex;
  flex-direction: column;
  gap: 10px;
  height: 100%;
  min-height: 0;
  padding: 12px 16px 16px;
  color: $text-primary;
}

.herdr-view-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  background: $bg-card;
  border: var(--border-width, 1px) solid $border-light;
  border-radius: var(--radius-component, 8px);
}

.herdr-view-title {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.herdr-view-conn {
  font-size: 12px;
  color: $text-muted;

  &[data-connected="true"] {
    color: $success;
  }
}

.herdr-view-counts {
  display: inline-flex;
  gap: 8px;
  font-size: 12px;
  color: $text-secondary;
}

.herdr-view-count {
  display: inline-flex;
  align-items: center;
  gap: 3px;
}

.herdr-view-tabs {
  display: inline-flex;
  gap: 2px;
  padding: 2px;
  margin-left: auto;
  border: var(--border-width, 1px) solid $border-light;
  border-radius: var(--radius-component, 8px);

  button {
    border: 0;
    background: transparent;
    color: $text-secondary;
    padding: 4px 10px;
    border-radius: var(--radius-component, 6px);
    cursor: pointer;
    font-size: 12px;

    &.active {
      background: $accent-muted;
      color: $text-primary;
    }

    &:disabled {
      cursor: not-allowed;
      color: $text-muted;
    }
  }
}

.herdr-view-actions {
  display: inline-flex;
  gap: 6px;
}

.herdr-view-error {
  margin: 0;
  font-size: 12px;
  color: $error;
}

.herdr-view-loading {
  margin: 40px auto;
}

.herdr-view-body {
  display: flex;
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;

  > .herdr-settings {
    width: min(720px, 100%);
    height: fit-content;
  }
}

.herdr-view-full {
  min-height: 360px;
}

.herdr-view-agents {
  display: flex;
  flex: 1 1 auto;
  gap: 10px;
  min-height: 0;
}

.herdr-view-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  flex: 0 0 260px;
  min-height: 0;
  overflow: auto;
  padding: 10px;
  background: $bg-card;
  border: var(--border-width, 1px) solid $border-light;
  border-radius: var(--radius-component, 8px);
}

.herdr-view-group h4 {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0 0 4px;
  font-size: 12px;
  color: $text-secondary;
}

.herdr-view-pane {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 6px 8px;
  border: 0;
  border-radius: var(--radius-component, 6px);
  background: transparent;
  color: $text-primary;
  text-align: left;
  cursor: pointer;
  font-size: 13px;

  &:hover,
  &.active {
    background: $accent-muted;
  }
}

.herdr-view-pane-name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.herdr-view-pane-agent,
.herdr-view-pane-id {
  font-size: 11px;
  color: $text-muted;
}

.herdr-view-pane-chat {
  font-size: 11px;
  color: $accent-primary;
  text-decoration: underline;
}

.herdr-view-pane-view {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  gap: 6px;
  min-width: 0;
  min-height: 0;
}

.herdr-view-pane-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}

.herdr-view-spacer {
  flex: 1 1 auto;
}

.herdr-view-empty {
  margin: 12px;
  color: $text-muted;
  font-size: 13px;
}

.herdr-launch-form {
  display: flex;
  flex-direction: column;
  gap: 10px;

  label {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 12px;
    color: $text-secondary;
  }
}

.herdr-launch-hint {
  margin: 0;
  font-size: 12px;
  color: $text-muted;
}

@media (max-width: 760px) {
  .herdr-view {
    padding: 8px;
  }

  .herdr-view-agents {
    flex-direction: column;
  }

  .herdr-view-list {
    flex: 0 0 auto;
    max-height: 38vh;
  }

  .herdr-view-tabs {
    margin-left: 0;
  }
}
</style>
