<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { studioUrl } from '../useMission'

/**
 * The one note Mission shows for Orb sources while Pondering Orb has no
 * address: Orb is optional, and its sources make no requests until it has one.
 */
defineEmits<{ 'open-control': [] }>()
const { t } = useI18n()
const settingsUrl = studioUrl('/studio/agents/herdr/settings')
</script>

<template>
  <section class="source orb-not-connected" data-testid="mission-orb-not-connected">
    <p>{{ t('mission.orbNotConnected') }}</p>
    <div class="orb-not-connected-actions">
      <a v-if="settingsUrl" :href="settingsUrl" data-testid="mission-orb-settings-link">{{ t('mission.orbOpenSettings') }}</a>
      <button type="button" data-testid="mission-orb-open-control" @click="$emit('open-control')">{{ t('mission.orbSetUpHere') }}</button>
    </div>
  </section>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;
@use './source';

.orb-not-connected {
  align-items: flex-start;
  gap: 10px;
  padding: 16px;
  color: $text-secondary;
  font-size: 13px;

  p {
    margin: 0;
  }
}

.orb-not-connected-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;

  a,
  button {
    padding: 4px 12px;
    border: var(--border-width, 1px) solid $border-light;
    border-radius: var(--radius-component, 6px);
    background: transparent;
    color: $accent-primary;
    font-size: 12.5px;
    text-decoration: none;
    cursor: pointer;
  }
}
</style>
