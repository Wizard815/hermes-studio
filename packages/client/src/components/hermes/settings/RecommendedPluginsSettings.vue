<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { NSwitch, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { fetchRecommendedPlugins, setRecommendedAutoInstall, type RecommendedPluginsInfo } from '@/api/hermes/plugins'
import SettingRow from './SettingRow.vue'

/** Settings switch for the recommended Hermes plugins Studio installs once per profile. */
const { t } = useI18n()
const message = useMessage()
const info = ref<RecommendedPluginsInfo | null>(null)
const saving = ref(false)

const names = computed(() => (info.value?.plugins || []).join(', '))

async function load() {
  try { info.value = await fetchRecommendedPlugins() } catch { info.value = null }
}

async function save(value: boolean) {
  saving.value = true
  try {
    const state = await setRecommendedAutoInstall(value)
    if (info.value) info.value = { ...info.value, autoInstall: state.autoInstall, disabledByEnv: state.disabledByEnv }
    message.success(t('settings.saved'))
  } catch {
    message.error(t('settings.saveFailed'))
  } finally {
    saving.value = false
  }
}

onMounted(load)
</script>

<template>
  <section v-if="info" class="settings-section recommended-plugins-settings">
    <h3 class="section-title">{{ t('recommendedPlugins.settingsTitle') }}</h3>
    <p class="section-hint">{{ t('recommendedPlugins.settingsDescription', { names }) }}</p>
    <SettingRow :label="t('recommendedPlugins.settingsEnabled')" :hint="t('recommendedPlugins.settingsEnabledHint', { env: info.env })">
      <NSwitch :value="info.autoInstall" :loading="saving" :disabled="info.disabledByEnv" @update:value="save" />
    </SettingRow>
    <p v-if="info.disabledByEnv" class="section-hint env-note">{{ t('recommendedPlugins.settingsDisabledByEnv', { env: info.env }) }}</p>
  </section>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.recommended-plugins-settings {
  margin-top: 16px;
  padding-top: calc(16px * var(--spacing-scale, 1));
  border-top: var(--border-width, 1px) solid var(--border-color);
}

.section-title {
  margin: 0 0 6px;
  font-size: calc(var(--font-size-base, 14px) * 15 / 14);
  font-weight: 600;
  color: var(--text-color);
}

.section-hint {
  margin: 0 0 12px;
  color: var(--text-color-secondary);
  font-size: calc(var(--font-size-base, 14px) * 13 / 14);
}

.env-note { color: $warning; }
</style>
