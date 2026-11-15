<script setup lang="ts">
import { ref } from 'vue'
import { NButton, NCollapseTransition } from 'naive-ui'
import { useI18n } from 'vue-i18n'

/** Plain-language steps for creating a Mattermost bot account and token. Open until the channel is set up. */
const props = defineProps<{ configured: boolean }>()
const { t } = useI18n()
const open = ref(!props.configured)
const steps = ['createBot', 'copyToken', 'addToTeam', 'fillIn', 'userId', 'tryIt'] as const
</script>

<template>
  <div class="mm-guide">
    <div class="guide-head">
      <span class="guide-title">{{ t('hermesChannels.mattermost.guideTitle') }}</span>
      <NButton size="tiny" quaternary @click="open = !open">{{ open ? t('hermesChannels.mattermost.hideSteps') : t('hermesChannels.mattermost.showSteps') }}</NButton>
    </div>
    <NCollapseTransition :show="open">
      <ol class="steps">
        <li v-for="step in steps" :key="step">{{ t(`hermesChannels.mattermost.steps.${step}`) }}</li>
      </ol>
      <p class="note">{{ t('hermesChannels.mattermost.channelIds') }}</p>
      <p class="note">{{ t('hermesChannels.mattermost.personalToken') }}</p>
    </NCollapseTransition>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.mm-guide {
  margin-top: 10px;
  padding: 8px 12px;
  border: var(--border-width, 1px) solid $border-light;
  border-radius: $radius-sm;
}

.guide-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.guide-title {
  font-size: calc(var(--font-size-base, 14px) * 13 / 14);
  font-weight: 600;
  color: $text-primary;
}

.steps {
  margin: 8px 0 4px;
  padding-left: 20px;
  font-size: calc(var(--font-size-base, 14px) * 13 / 14);
  color: $text-secondary;
  line-height: 1.55;

  li + li {
    margin-top: 4px;
  }
}

.note {
  margin: 6px 0 0;
  font-size: calc(var(--font-size-base, 14px) * 12 / 14);
  color: $text-muted;
}
</style>
