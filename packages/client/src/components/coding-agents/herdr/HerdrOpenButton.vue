<script setup lang="ts">
import { computed, ref } from 'vue'
import { NButton, NTooltip, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useHerdrStore } from '@/stores/hermes/herdr'
import { openChatInHerdr } from '@/utils/mission-url'

/**
 * The chat header's way into herdr. A Studio-only chat shows "Elevate to
 * herdr" (its herdr space is made and its agent starts there); an elevated
 * chat shows "Open in herdr" (the herdr page on its pane).
 */
const props = defineProps<{ sessionId: string }>()

const { t } = useI18n()
const toast = useMessage()
const herdr = useHerdrStore()
const busy = ref(false)
const elevated = computed(() => herdr.isElevated(props.sessionId))
const label = computed(() => (elevated.value ? t('herdr.openLive') : t('herdr.elevate')))

async function open() {
  busy.value = true
  try {
    await openChatInHerdr(props.sessionId)
  } catch (err: any) {
    toast.error(t('herdr.elevateFailed', { error: err?.message || String(err) }))
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <NTooltip trigger="hover">
    <template #trigger>
      <NButton
        class="herdr-open-button"
        :class="{ 'is-elevate': !elevated }"
        quaternary
        size="small"
        :circle="elevated"
        :loading="busy"
        :aria-label="label"
        :data-elevated="elevated ? 'true' : 'false'"
        data-testid="herdr-open-chat"
        @click="open"
      >
        <template #icon>
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M3 4h18v16H3zM12 4v16M3 12h9M7 8l2 2-2 2" />
          </svg>
        </template>
        <span v-if="!elevated" class="herdr-open-label">{{ t('herdr.elevateShort') }}</span>
      </NButton>
    </template>
    {{ elevated ? t('herdr.openLive') : t('herdr.elevateHint') }}
  </NTooltip>
</template>

<style scoped>
.herdr-open-button.is-elevate {
  min-height: 32px;
  padding: 0 8px;
}

.herdr-open-label {
  font-size: 12px;
}
</style>
