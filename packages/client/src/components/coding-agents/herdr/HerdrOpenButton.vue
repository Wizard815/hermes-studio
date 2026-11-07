<script setup lang="ts">
import { computed, ref } from 'vue'
import { NButton, NTooltip, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { openSessionInHerdr } from '@/api/coding-agents/herdr'
import { useSessionStateStore } from '@/stores/hermes/session-state'
import { missionUrl } from '@/utils/mission-url'

/** Studio → herdr swap for one chat: opens (or focuses) its live pane, then switches to the herdr view. */
const props = defineProps<{ sessionId: string }>()

const { t } = useI18n()
const toast = useMessage()
const states = useSessionStateStore()
const busy = ref(false)
const link = computed(() => states.herdrLink(props.sessionId))

async function open() {
  busy.value = true
  try {
    const { link: opened } = await openSessionInHerdr(props.sessionId)
    // The Mission view is a separate page on Studio's origin (same tunnel port).
    window.location.assign(missionUrl({ pane: opened.paneId }))
  } catch (err: any) {
    toast.error(err?.message || String(err))
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
        quaternary
        size="small"
        circle
        :loading="busy"
        :aria-label="link ? t('herdr.openLive') : t('herdr.openInHerdr')"
        data-testid="herdr-open-chat"
        @click="open"
      >
        <template #icon>
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M3 4h18v16H3zM12 4v16M3 12h9M7 8l2 2-2 2" />
          </svg>
        </template>
      </NButton>
    </template>
    {{ link ? t('herdr.openLive') : t('herdr.openInHerdr') }}
  </NTooltip>
</template>
