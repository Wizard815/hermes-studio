<script setup lang="ts">
import { useI18n } from 'vue-i18n'

// Two counts for a project (or all of them): threads that need the person, and
// threads that are done or idle. Nothing shows when both are zero.
defineProps<{ needsYou: number; idle: number }>()
const { t } = useI18n()
</script>

<template>
  <span v-if="needsYou || idle" class="project-attention" data-testid="project-attention">
    <span
      v-if="needsYou"
      class="project-attention-count project-attention-count--needs"
      :title="t('projects.attention.needsYou', { n: needsYou })"
      :aria-label="t('projects.attention.needsYou', { n: needsYou })"
      data-testid="project-attention-needs"
    >{{ needsYou }}</span>
    <span
      v-if="idle"
      class="project-attention-count project-attention-count--idle"
      :title="t('projects.attention.idle', { n: idle })"
      :aria-label="t('projects.attention.idle', { n: idle })"
      data-testid="project-attention-idle"
    >{{ idle }}</span>
  </span>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.project-attention {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 3px;
  margin-inline-start: auto;
}

.project-attention-count {
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  line-height: 18px;
  text-align: center;
  font-variant-numeric: tabular-nums;

  // Needs you: warning colour. Done or idle: success colour. The words are in the label.
  &--needs {
    border: var(--border-width, 1px) solid $warning;
    background-color: color-mix(in srgb, #{$warning} 28%, transparent);
    color: $text-primary;
    line-height: 16px;
  }

  &--idle {
    border: var(--border-width, 1px) solid $success;
    background-color: color-mix(in srgb, #{$success} 16%, transparent);
    color: $text-primary;
    line-height: 16px;
  }
}
</style>
