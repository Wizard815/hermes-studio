<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { AgentDisplayStatus } from '../../../../shared/session-state'

/**
 * Chat/agent status glyph, shared with herdr's "symbols" indicator style so a
 * status looks the same in both apps: ◐ working, × blocked, ✓ done, ○ idle, · unknown.
 */
const props = withDefaults(defineProps<{
  status: AgentDisplayStatus
  /** Idle chats with no live agent render muted to keep long lists calm. */
  live?: boolean
  size?: number
}>(), { live: false, size: 12 })

const { t } = useI18n()

const GLYPHS: Record<AgentDisplayStatus, string> = {
  working: '◐',
  blocked: '×',
  done: '✓',
  idle: '○',
  unknown: '·',
}

const glyph = computed(() => GLYPHS[props.status] ?? GLYPHS.unknown)
const label = computed(() => t(`agentStatus.${props.status}`))
</script>

<template>
  <span
    class="agent-status-icon"
    :class="[`agent-status-icon--${status}`, { 'agent-status-icon--live': live }]"
    :style="{ fontSize: `${size}px`, width: `${size}px`, height: `${size}px` }"
    role="img"
    :aria-label="label"
    :title="label"
    :data-status="status"
  >{{ glyph }}</span>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.agent-status-icon {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  font-weight: 700;
  line-height: 1;
  color: $text-muted;
  user-select: none;
}

.agent-status-icon--working {
  color: $warning;
  animation: agent-status-spin 1.4s linear infinite;
}

.agent-status-icon--blocked {
  color: $error;
}

.agent-status-icon--done {
  color: $accent-primary;
}

.agent-status-icon--idle.agent-status-icon--live {
  color: $success;
}

@keyframes agent-status-spin {
  to { transform: rotate(360deg); }
}

@media (prefers-reduced-motion: reduce) {
  .agent-status-icon--working {
    animation: none;
  }
}
</style>
