<script setup lang="ts">
import PageLoading from '@/components/common/PageLoading.vue'
import PageHeader from '@/components/layout/PageHeader.vue'
import { computed, onMounted, ref, watch } from 'vue'
import { NAlert, NButton, useMessage } from 'naive-ui'

import { useI18n } from 'vue-i18n'
import { useSettingsStore } from '@/stores/hermes/settings'
import { useProfilesStore } from '@/stores/hermes/profiles'
import PlatformSettings from '@/components/hermes/settings/PlatformSettings.vue'
import PlatformCard from '@/components/hermes/settings/PlatformCard.vue'
import HermesPlatformPanel from '@/components/hermes/channels/HermesPlatformPanel.vue'
import HermesPairingSection from '@/components/hermes/channels/HermesPairingSection.vue'
import HermesWebhooksSection from '@/components/hermes/channels/HermesWebhooksSection.vue'
import { cleanError, extraPlatforms, isActive, stateKey, stateTagType } from '@/components/hermes/channels/channel-helpers'
import { useHermesChannels } from '@/components/hermes/channels/useHermesChannels'

const settingsStore = useSettingsStore()
const profilesStore = useProfilesStore()
const { t } = useI18n()
const message = useMessage()
const channels = useHermesChannels()

const CHANNEL_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>'

async function loadSettingsForProfile() {
  if (!profilesStore.activeProfileName || profilesStore.profiles.length === 0) {
    await profilesStore.fetchProfiles()
  }
  await Promise.all([settingsStore.fetchSettings(), channels.load()])
}

const initializing = ref(true)

onMounted(() => {
  void loadSettingsForProfile().finally(() => { initializing.value = false })
})

// Studio's own cards save through Studio (and restart the gateway): re-read Hermes's view after.
watch(() => settingsStore.platforms, () => { if (!initializing.value) void channels.load() }, { deep: true })
watch(() => profilesStore.activeProfileName, () => { if (!initializing.value) void loadSettingsForProfile() })

const statuses = computed(() => {
  if (!channels.loaded.value) return undefined
  const out: Record<string, { label: string; type: ReturnType<typeof stateTagType> }> = {}
  for (const p of channels.platforms.value) out[p.id] = { label: t(`hermesChannels.state.${stateKey(p.state)}`), type: stateTagType(p.state) }
  return out
})
const morePlatforms = computed(() => extraPlatforms(channels.platforms.value))

async function afterHermesSave() {
  await settingsStore.fetchSettings()
}

async function restart() {
  try {
    await channels.restartGateway()
    message.success(t('hermesChannels.gateway.restarted'))
  } catch (err) {
    message.error(cleanError(err, t('hermesChannels.gateway.restartFailed')))
  }
}
</script>

<template>
  <PageLoading :show="initializing || settingsStore.loading" class="channels-view">
    <PageHeader>
    <header class="page-header">
      <h2 class="header-title">{{ t('sidebar.channels') }}</h2>
    </header>
    </PageHeader>

    <div class="channels-content">
      <div v-if="!initializing">
        <NAlert v-if="channels.error.value" type="warning" :show-icon="false" class="gateway-alert">
          <div class="alert-row">
            <span>{{ t('hermesChannels.loadFailed') }} {{ channels.error.value }}</span>
            <NButton size="small" :loading="channels.loading.value" @click="channels.load()">{{ t('hermesChannels.retry') }}</NButton>
          </div>
        </NAlert>
        <NAlert v-else-if="channels.loaded.value && (channels.pendingRestart.value || !channels.gatewayRunning.value)" :type="channels.pendingRestart.value ? 'info' : 'warning'" :show-icon="false" class="gateway-alert">
          <div class="alert-row">
            <span>{{ channels.pendingRestart.value ? t('hermesChannels.gateway.restartNeeded') : t('hermesChannels.gateway.stopped') }}</span>
            <NButton size="small" type="primary" :loading="channels.restarting.value" @click="restart">
              {{ channels.gatewayRunning.value ? t('hermesChannels.gateway.restart') : t('hermesChannels.gateway.start') }}
            </NButton>
          </div>
        </NAlert>

        <PlatformSettings v-if="!settingsStore.loading" :statuses="statuses">
          <template #platform-extra="{ platformKey }">
            <HermesPlatformPanel v-if="channels.byId(platformKey)" :platform="channels.byId(platformKey)!" embedded @saved="afterHermesSave" />
          </template>
        </PlatformSettings>

        <template v-if="morePlatforms.length">
          <h3 class="more-title">{{ t('hermesChannels.moreChannels') }}</h3>
          <p class="more-hint">{{ t('hermesChannels.moreChannelsHint') }}</p>
          <PlatformCard
            v-for="p in morePlatforms"
            :key="p.id"
            :platform-key="p.id"
            :name="p.name"
            :icon="CHANNEL_ICON"
            :config="{}"
            :status-label="t(`hermesChannels.state.${stateKey(p.state)}`)"
            :status-type="stateTagType(p.state)"
            :default-expanded="isActive(p) && p.state !== 'connected'"
          >
            <HermesPlatformPanel :platform="p" @saved="afterHermesSave" />
          </PlatformCard>
        </template>

        <template v-if="channels.loaded.value">
          <HermesPairingSection />
          <HermesWebhooksSection />
        </template>
      </div>
    </div>
  </PageLoading>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.channels-view {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.channels-content {
  flex: 1;
  overflow-y: auto;
  padding: calc(20px * var(--spacing-scale, 1));
  position: relative;
}

.gateway-alert {
  margin-bottom: 12px;
}

.alert-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.more-title {
  margin: 24px 0 0;
  font-size: calc(var(--font-size-base, 14px) * 15 / 14);
  font-weight: 600;
  color: $text-primary;
}

.more-hint {
  margin: 4px 0 10px;
  font-size: calc(var(--font-size-base, 14px) * 13 / 14);
  color: $text-secondary;
}
</style>
