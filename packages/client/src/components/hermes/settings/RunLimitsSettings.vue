<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { NInputNumber, NSwitch, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { isStoredSuperAdmin } from '@/api/client'
import { fetchRunLimitDefaults, saveRunLimitDefaults } from '@/api/studio/run-limits'
import { DEFAULT_RUN_LIMITS, LIMIT_FIELDS, type RunLimitKind, type RunLimits } from '../../../../../shared/run-limits'
import { LIMIT_INPUT, LIMIT_KINDS, limitValue } from '../run-limits/run-limit-format'
import SettingRow from './SettingRow.vue'

/** Settings → Agent → Run limits: what every chat follows unless it sets its own (docs/agent-limits.md). */
const { t } = useI18n()
const message = useMessage()
const canEdit = isStoredSuperAdmin()
const limits = ref<RunLimits>({ ...DEFAULT_RUN_LIMITS })
/** The last number for a limit that is off, so turning it back on restores it. */
const remembered = ref<Record<RunLimitKind, number>>({ cost: 2, tokens: 500000, time: 30, loop: 5 })
const loaded = ref(false)
const timers = new Map<RunLimitKind, number>()

onMounted(async () => {
  try {
    limits.value = (await fetchRunLimitDefaults()).defaults
    loaded.value = true
  } catch {
    message.error(t('runLimits.loadFailed'))
  }
})

async function save(kind: RunLimitKind, value: number | null) {
  const field = LIMIT_FIELDS[kind]
  try {
    limits.value = (await saveRunLimitDefaults({ [field]: value })).defaults
    message.success(t('runLimits.saved'))
  } catch {
    message.error(t('runLimits.saveFailed'))
  }
}

function toggle(kind: RunLimitKind, on: boolean) {
  const current = limitValue(limits.value, kind)
  if (current != null) remembered.value[kind] = current
  const next = on ? remembered.value[kind] || LIMIT_INPUT[kind].default : null
  limits.value = { ...limits.value, [LIMIT_FIELDS[kind]]: next }
  void save(kind, next)
}

function change(kind: RunLimitKind, value: number | null) {
  if (value == null || value <= 0) return
  limits.value = { ...limits.value, [LIMIT_FIELDS[kind]]: value }
  remembered.value[kind] = value
  window.clearTimeout(timers.get(kind))
  timers.set(kind, window.setTimeout(() => { void save(kind, value) }, 600))
}

const LABEL: Record<RunLimitKind, string> = { cost: 'cost', tokens: 'tokens', time: 'time', loop: 'loop' }
</script>

<template>
  <section class="settings-section run-limits-settings" data-testid="run-limits-settings">
    <h3 class="section-title">{{ t('runLimits.title') }}</h3>
    <p class="section-hint">{{ t('runLimits.description') }}</p>
    <p v-if="!canEdit" class="section-hint">{{ t('runLimits.superAdminOnly') }}</p>

    <SettingRow
      v-for="kind in LIMIT_KINDS"
      :key="kind"
      :label="t(`runLimits.${LABEL[kind]}`)"
      :hint="t(`runLimits.${LABEL[kind]}Hint`)"
    >
      <div class="run-limit-control">
        <NSwitch
          :value="limitValue(limits, kind) != null"
          :disabled="!canEdit || !loaded"
          :data-testid="`run-limit-${kind}-switch`"
          @update:value="(on: boolean) => toggle(kind, on)"
        />
        <NInputNumber
          v-if="limitValue(limits, kind) != null"
          :value="limitValue(limits, kind)"
          :min="LIMIT_INPUT[kind].min"
          :step="LIMIT_INPUT[kind].step"
          :precision="LIMIT_INPUT[kind].precision"
          :disabled="!canEdit"
          size="small"
          class="run-limit-input"
          :data-testid="`run-limit-${kind}-input`"
          @update:value="(value: number | null) => change(kind, value)"
        >
          <template #suffix>{{ t(`runLimits.unit.${kind}`) }}</template>
        </NInputNumber>
        <span v-else class="run-limit-off">{{ t('runLimits.off') }}</span>
      </div>
    </SettingRow>
  </section>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.run-limits-settings {
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

.run-limit-control {
  display: flex;
  align-items: center;
  gap: 10px;
  justify-content: flex-end;
  flex-wrap: wrap;
}

.run-limit-input {
  width: 170px;
}

.run-limit-off {
  min-width: 170px;
  color: $text-muted;
  font-size: 13px;
}

@media (max-width: 640px) {
  .run-limit-input,
  .run-limit-off {
    width: 140px;
    min-width: 140px;
  }
}
</style>
