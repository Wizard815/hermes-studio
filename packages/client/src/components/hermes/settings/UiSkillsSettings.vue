<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { NSwitch, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { fetchUiSkills, setUiSkillsEnabled, type UiSkillsInfo } from '@/api/studio/ui-skills'
import SettingRow from './SettingRow.vue'

/** Settings switch for the UI skills Studio copies once into every agent (docs/ui-skills.md). */
const { t } = useI18n()
const message = useMessage()
const info = ref<UiSkillsInfo | null>(null)
const saving = ref(false)

const names = computed(() => (info.value?.skills || []).map(skill => skill.name).join(', '))

async function load() {
  try { info.value = await fetchUiSkills() } catch { info.value = null }
}

async function save(value: boolean) {
  saving.value = true
  try {
    const state = await setUiSkillsEnabled(value)
    if (info.value) info.value = { ...info.value, enabled: state.enabled, disabledByEnv: state.disabledByEnv }
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
  <section v-if="info" class="settings-section ui-skills-settings" data-testid="ui-skills-settings">
    <h3 class="section-title">{{ t('uiSkills.settingsTitle') }}</h3>
    <p class="section-hint">{{ t('uiSkills.settingsDescription', { names, author: info.source.author }) }}</p>
    <SettingRow :label="t('uiSkills.settingsEnabled')" :hint="t('uiSkills.settingsEnabledHint', { env: info.env })">
      <NSwitch :value="info.enabled" :loading="saving" :disabled="info.disabledByEnv" :aria-label="t('uiSkills.settingsEnabled')" @update:value="save" />
    </SettingRow>
    <p v-if="info.disabledByEnv" class="section-hint env-note">{{ t('uiSkills.settingsDisabledByEnv', { env: info.env }) }}</p>
  </section>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.ui-skills-settings {
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
