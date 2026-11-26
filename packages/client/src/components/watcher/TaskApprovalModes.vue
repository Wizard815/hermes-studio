<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { NSelect, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { fetchTaskApprovalMode, saveTaskApprovalMode } from '@/api/studio/watcher'
import type { AgentWork } from '@/api/studio/agent-work'
import { TASK_APPROVAL_MODES, type TaskApprovalMode } from '../../../../shared/watcher'

/**
 * Connections → Agent work: how each open task's agent asks (docs/watcher.md).
 * A task's mode is its chat's own mode, the one /yolo sets: inherit follows
 * the agent's mode in Settings, auto lets the task run unattended.
 */
const props = defineProps<{ work: AgentWork[] }>()
const { t } = useI18n()
const message = useMessage()
const modes = ref<Record<string, TaskApprovalMode>>({})

const open = computed(() => props.work.filter(item => item.sessionId && !item.decision && item.status !== 'done' && item.status !== 'rejected'))
const options = computed(() => TASK_APPROVAL_MODES.map(value => ({ value, label: t(`watcher.taskMode.${value}`) })))

watch(open, items => {
  for (const item of items) {
    if (modes.value[item.id]) continue
    fetchTaskApprovalMode(item.id).then(result => { modes.value = { ...modes.value, [item.id]: result.mode } }).catch(() => undefined)
  }
}, { immediate: true })

async function change(item: AgentWork, mode: TaskApprovalMode) {
  const before = modes.value[item.id]
  modes.value = { ...modes.value, [item.id]: mode }
  try {
    await saveTaskApprovalMode(item.id, mode)
    message.success(t('watcher.taskMode.saved'))
  } catch {
    modes.value = { ...modes.value, [item.id]: before }
    message.error(t('watcher.actionFailed'))
  }
}
</script>

<template>
  <section v-if="open.length" class="aw-card task-modes" data-theme-surface="card" data-testid="task-approval-modes">
    <h3 class="task-modes__head">{{ t('watcher.taskMode.title') }}</h3>
    <p class="task-modes__hint">{{ t('watcher.taskMode.hint') }}</p>
    <div v-for="item in open" :key="item.id" class="task-modes__row" data-testid="task-approval-mode">
      <label :for="`task-mode-${item.id}`" class="task-modes__title">{{ item.title }}<small>{{ item.agent }}</small></label>
      <NSelect
        :id="`task-mode-${item.id}`"
        :value="modes[item.id] || 'inherit'"
        :options="options"
        size="small"
        class="task-modes__select"
        :aria-label="t('watcher.taskMode.label', { title: item.title })"
        @update:value="(mode: TaskApprovalMode) => change(item, mode)"
      />
    </div>
  </section>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.task-modes__head {
  margin: 0 0 4px;
  color: $text-primary;
  font-size: 14px;
  font-weight: 600;
}

.task-modes__hint {
  margin: 0 0 8px;
  color: $text-muted;
  font-size: 12px;
}

.task-modes__row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 0;
  border-top: var(--border-width, 1px) solid $border-light;
}

.task-modes__title {
  flex: 1;
  min-width: 0;
  color: $text-primary;
  font-size: 13px;

  small {
    display: block;
    color: $text-muted;
    font-size: 11px;
  }
}

.task-modes__select { width: 210px; }

@media (max-width: 640px) {
  .task-modes__row { flex-direction: column; align-items: stretch; }
  .task-modes__select { width: 100%; }
}
</style>
