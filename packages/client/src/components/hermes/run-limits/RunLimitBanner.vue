<script setup lang="ts">
import { computed, ref } from 'vue'
import { NButton, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { continueChatRun, stopChatAtLimit } from '@/api/studio/run-limits'
import { useSessionStateStore } from '@/stores/hermes/session-state'
import { useChatStore } from '@/stores/hermes/chat'
import type { RunLimitKind } from '../../../../../shared/run-limits'
import { formatLimit, hitMessageKey } from './run-limit-format'

/**
 * A run limit stopped this chat's run (docs/agent-limits.md): which limit, the
 * numbers, and "Continue with a higher limit" / "Stop". The chat shows blocked
 * (list, herdr, Inbox) until one of them is pressed or a new message is sent.
 */
const props = defineProps<{ sessionId: string }>()
const { t, locale } = useI18n()
const toast = useMessage()
const sessionState = useSessionStateStore()
const chatStore = useChatStore()
const busy = ref<'' | 'continue' | 'stop'>('')

const hit = computed(() => sessionState.limitHit(props.sessionId))
const words = computed(() => ({
  off: t('runLimits.off'),
  unit: { cost: t('runLimits.unit.cost'), tokens: t('runLimits.unit.tokens'), time: t('runLimits.unit.time'), loop: t('runLimits.unit.loop') } as Record<RunLimitKind, string>,
}))
const number = (kind: RunLimitKind, value: number) => {
  if (kind === 'cost') return formatLimit(kind, value, words.value, locale.value)
  if (kind === 'time') return String(Math.round(value * 10) / 10)
  return Math.round(value).toLocaleString(locale.value)
}
const sentence = computed(() => {
  const current = hit.value
  if (!current) return ''
  return t(hitMessageKey(current), { value: number(current.kind, current.value), limit: number(current.kind, current.limit) })
})
const suggested = computed(() => hit.value ? formatLimit(hit.value.kind, hit.value.suggested, words.value, locale.value) : '')

async function onContinue() {
  const current = hit.value
  if (!current || busy.value) return
  busy.value = 'continue'
  try {
    const result = await continueChatRun(props.sessionId)
    const raised = result.raised
    if (raised) toast.success(t('runLimits.banner.continued', { value: formatLimit(raised.kind, raised.value, words.value, locale.value) }))
    // The agent picks up again in its usual way for this chat (Studio run or its herdr pane).
    if (chatStore.activeSessionId === props.sessionId) await chatStore.sendMessage(t('runLimits.banner.continuePrompt'))
  } catch (error: any) {
    toast.error(error?.message || t('runLimits.banner.failed'))
  } finally {
    busy.value = ''
  }
}

async function onStop() {
  if (!hit.value || busy.value) return
  busy.value = 'stop'
  try { await stopChatAtLimit(props.sessionId) } catch (error: any) {
    toast.error(error?.message || t('runLimits.banner.failed'))
  } finally {
    busy.value = ''
  }
}
</script>

<template>
  <div v-if="hit" class="run-limit-banner" data-theme-surface="card" role="alert" data-testid="run-limit-banner">
    <div class="run-limit-banner__text">
      <div class="run-limit-banner__title">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M12 3a9 9 0 1 0 9 9" />
          <path d="M12 12l5-5" />
          <path d="M21 3v6h-6" />
        </svg>
        <span>{{ t('runLimits.banner.title') }}</span>
      </div>
      <p class="run-limit-banner__sentence">{{ sentence }}</p>
      <code v-if="hit.kind === 'loop' && hit.detail" class="run-limit-banner__detail">{{ hit.detail }}</code>
      <p v-if="hit.via === 'gateway'" class="run-limit-banner__note">{{ t('runLimits.banner.gateway') }}</p>
    </div>
    <div class="run-limit-banner__actions">
      <NButton size="small" type="primary" :loading="busy === 'continue'" :disabled="!!busy" data-testid="run-limit-continue" @click="onContinue">
        {{ t('runLimits.banner.continue', { value: suggested }) }}
      </NButton>
      <NButton size="small" secondary :loading="busy === 'stop'" :disabled="!!busy" data-testid="run-limit-stop" @click="onStop">
        {{ t('runLimits.banner.stop') }}
      </NButton>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.run-limit-banner {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 0 auto 8px;
  width: min(860px, calc(100% - 32px));
  padding: 10px 14px;
  background: $bg-card;
  color: $text-primary;
  border: var(--border-width, 1px) solid $warning;
  border-radius: var(--radius-component, 8px);
}

.run-limit-banner__text {
  flex: 1;
  min-width: 0;
}

.run-limit-banner__title {
  display: flex;
  align-items: center;
  gap: 6px;
  color: $warning;
  font-size: calc(var(--font-size-base, 14px) * 12 / 14);
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.run-limit-banner__sentence {
  margin: 4px 0 0;
  font-size: calc(var(--font-size-base, 14px) * 13 / 14);
}

.run-limit-banner__detail {
  display: block;
  margin-top: 4px;
  overflow: hidden;
  font-family: $font-code;
  font-size: 12px;
  color: $text-secondary;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.run-limit-banner__note {
  margin: 4px 0 0;
  color: $text-secondary;
  font-size: 12px;
}

.run-limit-banner__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  justify-content: flex-end;
}

@media (max-width: 640px) {
  .run-limit-banner {
    flex-direction: column;
    align-items: stretch;
  }

  .run-limit-banner__actions {
    justify-content: flex-start;
  }
}
</style>
