<script setup lang="ts">
import PageLoading from '@/components/common/PageLoading.vue'
import PageHeader from '@/components/layout/PageHeader.vue'
import { onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { NTabPane, NTabs } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import AgentSettings from '@/components/hermes/settings/AgentSettings.vue'
import GatewayAutoStartSettings from '@/components/hermes/settings/GatewayAutoStartSettings.vue'
import RecommendedPluginsSettings from '@/components/hermes/settings/RecommendedPluginsSettings.vue'
import RunLimitsSettings from '@/components/hermes/settings/RunLimitsSettings.vue'
import MemorySettings from '@/components/hermes/settings/MemorySettings.vue'
import SessionSettings from '@/components/hermes/settings/SessionSettings.vue'
import HermesToolsetsSettings from '@/components/hermes/settings/HermesToolsetsSettings.vue'
import HermesTerminalSettings from '@/components/hermes/settings/HermesTerminalSettings.vue'
import HermesSubagentSettings from '@/components/hermes/settings/HermesSubagentSettings.vue'
import HermesMaintenanceSettings from '@/components/hermes/settings/HermesMaintenanceSettings.vue'
import { isStoredSuperAdmin } from '@/api/client'
import { useProfilesStore } from '@/stores/hermes/profiles'
import { useSettingsStore } from '@/stores/hermes/settings'

type HermesSettingsTab = 'agent' | 'memory' | 'session' | 'tools' | 'terminal' | 'subagents' | 'maintenance'
// Tabs backed by Hermes Agent's own API (super administrators only).
const HERMES_AGENT_TABS = ['tools', 'terminal', 'subagents', 'maintenance'] as const
const canUseHermesAgent = isStoredSuperAdmin()

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const profilesStore = useProfilesStore()
const settingsStore = useSettingsStore()
const activeTab = ref<HermesSettingsTab>('agent')

function normalizeTab(value: unknown): HermesSettingsTab {
  if (value === 'memory' || value === 'session') return value
  if (canUseHermesAgent && (HERMES_AGENT_TABS as readonly unknown[]).includes(value)) return value as HermesSettingsTab
  return 'agent'
}

function handleTabUpdate(tab: HermesSettingsTab) {
  activeTab.value = normalizeTab(tab)
  void router.replace({
    query: {
      ...route.query,
      tab: activeTab.value === 'agent' ? undefined : activeTab.value,
    },
  })
}

watch(() => route.query.tab, tab => {
  activeTab.value = normalizeTab(tab)
}, { immediate: true })

async function loadSettingsForProfile() {
  if (!profilesStore.activeProfileName || profilesStore.profiles.length === 0) {
    await profilesStore.fetchProfiles()
  }
  await settingsStore.fetchSettings()
}

const initializing = ref(true)

onMounted(() => {
  void loadSettingsForProfile().finally(() => { initializing.value = false })
})
</script>

<template>
  <PageLoading :show="initializing || settingsStore.loading" class="hermes-settings-view">
    <PageHeader>
    <header class="page-header">
      <h2 class="header-title">{{ t('settings.title') }}</h2>
    </header>
    </PageHeader>

    <div class="hermes-settings-content">
      <div>
        <NTabs v-model:value="activeTab" type="line" animated @update:value="handleTabUpdate">
          <NTabPane name="agent" :tab="t('settings.tabs.agent')">
            <AgentSettings />
            <GatewayAutoStartSettings />
            <RecommendedPluginsSettings v-if="canUseHermesAgent" />
            <RunLimitsSettings />
          </NTabPane>
          <NTabPane name="memory" :tab="t('settings.tabs.memory')">
            <MemorySettings />
          </NTabPane>
          <NTabPane name="session" :tab="t('settings.tabs.session')">
            <SessionSettings />
          </NTabPane>
          <template v-if="canUseHermesAgent">
            <NTabPane name="tools" :tab="t('hermesTools.tabs.tools')" display-directive="show:lazy">
              <HermesToolsetsSettings />
            </NTabPane>
            <NTabPane name="terminal" :tab="t('hermesTools.tabs.terminal')" display-directive="show:lazy">
              <HermesTerminalSettings />
            </NTabPane>
            <NTabPane name="subagents" :tab="t('hermesTools.tabs.subagents')" display-directive="show:lazy">
              <HermesSubagentSettings />
            </NTabPane>
            <NTabPane name="maintenance" :tab="t('hermesTools.tabs.maintenance')" display-directive="show:lazy">
              <HermesMaintenanceSettings />
            </NTabPane>
          </template>
        </NTabs>
      </div>
    </div>
  </PageLoading>
</template>

<style scoped lang="scss">
.hermes-settings-view {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.hermes-settings-content {
  flex: 1 1 auto;
  min-height: 0;
  padding: calc(20px * var(--spacing-scale, 1));
  overflow-y: auto;
}
</style>
