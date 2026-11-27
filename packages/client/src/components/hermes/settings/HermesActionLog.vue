<script setup lang="ts">
import { computed } from 'vue'
import { NTag } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { logLineLevel } from '@/api/hermes/agent-tools'

const props = defineProps<{ lines: string[]; running: boolean; exitCode: number | null; finished: boolean; error?: string }>()
const { t } = useI18n()

const rows = computed(() => props.lines.map(text => ({ text, level: logLineLevel(text) })))
</script>

<template>
  <div v-if="running || finished || error" class="action-log">
    <div class="action-log-status">
      <NTag v-if="running" size="small" type="info">{{ t('hermesTools.action.running') }}</NTag>
      <NTag v-else-if="error" size="small" type="error">{{ t('hermesTools.action.failedToStart') }}</NTag>
      <NTag v-else-if="finished && exitCode === 0" size="small" type="success">{{ t('hermesTools.action.done') }}</NTag>
      <NTag v-else-if="finished" size="small" type="warning">{{ t('hermesTools.action.doneWithIssues') }}</NTag>
      <span v-if="error" class="action-log-error">{{ error }}</span>
    </div>
    <pre v-if="rows.length" class="action-log-output"><span v-for="(row, i) in rows" :key="i" :class="`line-${row.level}`">{{ row.text }}
</span></pre>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.action-log {
  margin-top: 8px;
}

.action-log-status {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}

.action-log-error {
  font-size: calc(var(--font-size-base, 14px) * 12 / 14);
  color: $error;
}

.action-log-output {
  max-height: 320px;
  overflow: auto;
  margin: 0;
  padding: 10px 12px;
  border: var(--border-width, 1px) solid $border-light;
  border-radius: $radius-sm;
  background: rgba(var(--text-primary-rgb), 0.04);
  font-family: $font-code;
  font-size: calc(var(--font-size-base, 14px) * 12 / 14);
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}

.line-ok { color: $success; }
.line-warn { color: $warning; }
.line-error { color: $error; }
.line-heading { color: $text-primary; font-weight: 600; }
.line-plain { color: $text-secondary; }
</style>
