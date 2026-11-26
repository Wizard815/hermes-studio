<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { NInputNumber, NSwitch, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { isStoredSuperAdmin } from '@/api/client'
import { fetchHermesToolSearch, fetchToolLoadSettings, saveHermesToolSearch, saveToolLoadSettings } from '@/api/studio/tool-load'
import { useProfilesStore } from '@/stores/hermes/profiles'
import { DEFAULT_TOOL_LOAD_THRESHOLD, TOOL_LOAD_THRESHOLD_LIMITS, type ToolSearchSetting } from '../../../../../shared/tool-load'
import SettingRow from './SettingRow.vue'

/**
 * Settings → Tools: Hermes's tool search for this profile (config.yaml
 * `tools.tool_search.enabled`) and when Studio warns about a chat's tool count
 * (docs/hermes-tool-load.md).
 */
const { t } = useI18n()
const message = useMessage()
const profiles = useProfilesStore()
const canEdit = isStoredSuperAdmin()
const profile = computed(() => profiles.activeProfileName || 'default')
const toolSearch = ref<ToolSearchSetting>('auto')
const threshold = ref(DEFAULT_TOOL_LOAD_THRESHOLD)
const loaded = ref(false)
const saving = ref(false)
let timer = 0

async function load() {
  loaded.value = false
  try {
    const [search, settings] = await Promise.all([fetchHermesToolSearch(profile.value), fetchToolLoadSettings()])
    toolSearch.value = search
    threshold.value = settings.settings.threshold
    loaded.value = true
  } catch {
    message.error(t('toolLoad.loadFailed'))
  }
}

onMounted(load)
watch(profile, load)

async function setToolSearch(on: boolean) {
  const next: ToolSearchSetting = on ? 'auto' : 'off'
  saving.value = true
  try {
    await saveHermesToolSearch(next, profile.value)
    toolSearch.value = next
    message.success(t('toolLoad.saved'))
  } catch (error: any) {
    message.error(error?.message || t('toolLoad.failed'))
  } finally {
    saving.value = false
  }
}

function setThreshold(value: number | null) {
  if (value == null || value < 0) return
  threshold.value = value
  window.clearTimeout(timer)
  timer = window.setTimeout(async () => {
    try {
      threshold.value = (await saveToolLoadSettings({ threshold: value })).settings.threshold
      message.success(t('toolLoad.saved'))
    } catch {
      message.error(t('toolLoad.failed'))
    }
  }, 600)
}
</script>

<template>
  <section class="settings-section tool-search-settings" data-testid="tool-search-settings">
    <h3 class="section-title">{{ t('toolLoad.settingsTitle') }}</h3>
    <p class="section-hint">{{ t('toolLoad.settingsHint') }}</p>

    <SettingRow :label="t('toolLoad.searchLabel', { profile })" :hint="t('toolLoad.searchHint')">
      <div class="tool-search-control">
        <span class="tool-search-state">{{ toolSearch === 'off' ? t('toolLoad.stateOff') : t('toolLoad.stateOn') }}</span>
        <NSwitch
          :value="toolSearch !== 'off'"
          :disabled="!loaded || saving"
          :loading="saving"
          :aria-label="t('toolLoad.searchLabel', { profile })"
          data-testid="tool-search-switch"
          @update:value="setToolSearch"
        />
      </div>
    </SettingRow>

    <SettingRow :label="t('toolLoad.thresholdLabel')" :hint="t('toolLoad.thresholdHint')">
      <NInputNumber
        :value="threshold"
        :min="TOOL_LOAD_THRESHOLD_LIMITS.min"
        :max="TOOL_LOAD_THRESHOLD_LIMITS.max"
        :step="10"
        :disabled="!loaded || !canEdit"
        size="small"
        class="tool-load-input"
        :aria-label="t('toolLoad.thresholdLabel')"
        data-testid="tool-load-threshold"
        @update:value="setThreshold"
      >
        <template #suffix>{{ t('toolLoad.toolsUnit') }}</template>
      </NInputNumber>
    </SettingRow>
  </section>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.tool-search-settings {
  margin-bottom: 16px;
  padding-bottom: calc(16px * var(--spacing-scale, 1));
  border-bottom: var(--border-width, 1px) solid $border-light;
}

.section-title {
  margin: 0 0 6px;
  font-size: calc(var(--font-size-base, 14px) * 15 / 14);
  font-weight: 600;
  color: $text-primary;
}

.section-hint {
  margin: 0 0 12px;
  color: $text-secondary;
  font-size: calc(var(--font-size-base, 14px) * 13 / 14);
}

.tool-search-control {
  display: flex;
  align-items: center;
  gap: 10px;
}

.tool-search-state {
  color: $text-secondary;
  font-size: 13px;
}

.tool-load-input {
  width: 160px;
}
</style>
