<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { PlanLimits, PlanWindow } from '@/api/studio/command-center'

/** Codex plan windows (5-hour and weekly) as bars, from Codex's own rollout reports. */
const props = defineProps<{ limits: PlanLimits; compact?: boolean }>()
const { t } = useI18n()

function label(window: PlanWindow): string {
  const minutes = window.windowMinutes || 0
  if (minutes >= 1440 * 6) return t('commandCenter.usage.weekly')
  if (minutes >= 60) return t('commandCenter.usage.hours', { n: Math.round(minutes / 60) })
  return t('commandCenter.usage.window')
}
function resets(window: PlanWindow): string {
  if (!window.resetsAt) return ''
  return t('commandCenter.usage.resets', { time: new Date(window.resetsAt).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' }) })
}
const level = (percent: number) => (percent >= 90 ? 'is-bad' : percent >= 70 ? 'is-warn' : '')
const windows = computed(() => [props.limits.primary, props.limits.secondary].filter((item): item is PlanWindow => !!item))
</script>

<template>
  <div class="cc-plan" :class="{ 'is-compact': compact }" data-testid="cc-plan-bars">
    <div v-for="(window, index) in windows" :key="index" class="cc-meter">
      <div class="cc-meter-label">
        <span>{{ compact ? t('commandCenter.usage.codexPlan') + ' · ' : '' }}{{ label(window) }}</span>
        <span :title="resets(window)">{{ Math.round(window.usedPercent) }}%</span>
      </div>
      <div class="cc-bar" :class="level(window.usedPercent)" role="meter" :aria-valuenow="Math.round(window.usedPercent)" aria-valuemin="0" aria-valuemax="100" :aria-label="label(window)">
        <span :style="{ width: `${window.usedPercent}%` }" />
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use './command-center';

.cc-plan {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
</style>
