<script setup lang="ts">
import { ref } from 'vue'
import { useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { setSkillLocked } from '@/api/hermes/agent-memory'

/** Lock a skill against changes by the agent and the curator (Hermes's `curator lock`). */
const props = defineProps<{ name: string; locked: boolean }>()
const emit = defineEmits<{ toggled: [name: string, locked: boolean] }>()
const { t } = useI18n()
const message = useMessage()
const busy = ref(false)

async function toggle() {
  if (busy.value) return
  busy.value = true
  try {
    const next = !props.locked
    await setSkillLocked(props.name, next)
    emit('toggled', props.name, next)
  } catch (err: any) {
    message.error(String(err?.message || err).replace(/^API Error \d+:\s*/, ''))
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <button
    class="lock-toggle"
    :class="{ active: locked }"
    :disabled="busy"
    :title="locked ? t('hermesMemory.lockedHint') : t('hermesMemory.unlockedHint')"
    :aria-label="locked ? t('hermesMemory.unlock') : t('hermesMemory.lock')"
    :aria-pressed="locked"
    @click="toggle"
  >
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <rect x="4" y="11" width="16" height="10" rx="2" :fill="locked ? 'currentColor' : 'none'" />
      <path v-if="locked" d="M8 11V7a4 4 0 0 1 8 0v4" />
      <path v-else d="M8 11V7a4 4 0 0 1 7.5-2" />
    </svg>
  </button>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.lock-toggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: var(--border-width, 1px) solid transparent;
  background: none;
  color: $text-muted;
  cursor: pointer;
  padding: calc(4px * var(--spacing-scale, 1));
  border-radius: var(--radius-component, 6px);
  opacity: 0.5;
  transition: all $transition-fast;

  &:hover {
    opacity: 1;
    color: $accent-primary;
    background: rgba(var(--accent-primary-rgb), 0.08);
    border-color: rgba(var(--accent-primary-rgb), 0.15);
  }

  &.active {
    opacity: 1;
    color: $accent-primary;
  }

  &:disabled {
    cursor: wait;
    opacity: 0.3;
  }
}
</style>
