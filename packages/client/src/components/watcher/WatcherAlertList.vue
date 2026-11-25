<script setup lang="ts">
import { computed, ref } from 'vue'
import { NButton, NPopconfirm, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useWatcher } from '@/composables/useWatcher'
import TrustRuleDialog from './TrustRuleDialog.vue'
import type { WatcherEvent } from '../../../../shared/watcher'

/** The bell's list (docs/watcher.md): newest first, with read, clear, open and "Trust this". */
const emit = defineEmits<{ navigate: [] }>()
const { t, locale } = useI18n()
const router = useRouter()
const message = useMessage()
const watcher = useWatcher()
const trusting = ref<WatcherEvent | null>(null)

const events = computed(() => watcher.events.value)
const unread = computed(() => watcher.unread.value)

function when(time: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - time) / 1000))
  const format = new Intl.RelativeTimeFormat(locale.value, { numeric: 'auto' })
  if (seconds < 60) return format.format(-seconds, 'second')
  if (seconds < 3600) return format.format(-Math.round(seconds / 60), 'minute')
  if (seconds < 86400) return format.format(-Math.round(seconds / 3600), 'hour')
  return new Date(time).toLocaleString(locale.value, { dateStyle: 'short', timeStyle: 'short' })
}

async function act(work: () => Promise<unknown>) {
  try { await work() } catch { message.error(t('watcher.actionFailed')) }
}

function open(event: WatcherEvent) {
  void act(() => watcher.markRead([event.id]))
  if (/^https?:\/\//.test(event.link)) { window.open(event.link, '_blank', 'noopener'); return }
  if (event.link) { void router.push(event.link); emit('navigate') }
}
</script>

<template>
  <div class="watcher-list" data-testid="watcher-list">
    <div class="watcher-list__head">
      <strong class="watcher-list__title">{{ t('watcher.title') }}</strong>
      <span class="watcher-list__count" role="status" aria-live="polite" data-testid="watcher-unread-text">{{ unread ? t('watcher.unread', { n: unread }) : t('watcher.allRead') }}</span>
      <div class="watcher-list__actions">
        <NButton size="tiny" quaternary :disabled="!unread" data-testid="watcher-mark-all" @click="act(watcher.markAll)">{{ t('watcher.markAllRead') }}</NButton>
        <NPopconfirm :positive-text="t('watcher.clear')" :negative-text="t('common.cancel')" @positive-click="act(() => watcher.clear())">
          <template #trigger>
            <NButton size="tiny" quaternary :disabled="!events.length" data-testid="watcher-clear">{{ t('watcher.clear') }}</NButton>
          </template>
          {{ t('watcher.clearConfirm') }}
        </NPopconfirm>
      </div>
    </div>
    <p v-if="watcher.failed.value" class="watcher-list__empty">{{ t('watcher.loadFailed') }}</p>
    <p v-else-if="!events.length" class="watcher-list__empty">{{ t('watcher.empty') }}</p>
    <ol v-else class="watcher-list__items">
      <li
        v-for="event in events"
        :key="event.id"
        class="watcher-item"
        :class="[`is-${event.severity}`, { 'is-unread': !event.read }]"
        data-testid="watcher-item"
        :data-kind="event.kind"
      >
        <span class="watcher-item__severity" :class="`is-${event.severity}`">
          <svg v-if="event.severity === 'block'" viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2" /><path d="M6 18 18 6" stroke="currentColor" stroke-width="2" /></svg>
          <svg v-else-if="event.severity === 'warn'" viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><path d="M12 3 2 21h20L12 3z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" /><path d="M12 10v5M12 18v.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" /></svg>
          <svg v-else viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2" /><path d="M12 11v6M12 7.5v.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" /></svg>
          {{ t(`watcher.severity.${event.severity}`) }}
        </span>
        <div class="watcher-item__body">
          <div class="watcher-item__meta">
            <span>{{ t(`watcher.kind.${event.kind}`) }}</span>
            <time :datetime="new Date(event.time).toISOString()">{{ when(event.time) }}</time>
            <span v-if="!event.read" class="watcher-item__new">{{ t('watcher.new') }}</span>
          </div>
          <p class="watcher-item__text">{{ event.text }}</p>
          <div class="watcher-item__buttons">
            <NButton v-if="event.link" size="tiny" secondary data-testid="watcher-open" @click="open(event)">{{ event.taskId && !event.sessionId ? t('watcher.openTask') : t('watcher.openChat') }}</NButton>
            <NButton v-if="event.action" size="tiny" secondary type="primary" data-testid="watcher-trust" @click="trusting = event">{{ t('watcher.trustThis') }}</NButton>
            <NButton v-if="event.trace" size="tiny" quaternary tag="a" :href="event.trace" target="_blank" rel="noopener">{{ t('watcher.langfuse') }}</NButton>
            <NButton v-if="!event.read" size="tiny" quaternary data-testid="watcher-mark-read" @click="act(() => watcher.markRead([event.id]))">{{ t('watcher.markRead') }}</NButton>
            <NButton size="tiny" quaternary :aria-label="t('watcher.clearOne')" @click="act(() => watcher.clear([event.id]))">{{ t('watcher.clearOne') }}</NButton>
          </div>
        </div>
      </li>
    </ol>
    <TrustRuleDialog v-if="trusting" :event="trusting" @close="trusting = null" />
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.watcher-list {
  display: flex;
  flex-direction: column;
  width: min(420px, calc(100vw - 32px));
  max-height: min(70vh, 560px);
  min-height: 0;
}

.watcher-list__head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px 10px;
  padding: 2px 2px 8px;
  border-bottom: var(--border-width, 1px) solid $border-light;
}

.watcher-list__title {
  color: $text-primary;
  font-size: 14px;
}

.watcher-list__count {
  color: $text-muted;
  font-size: 12px;
}

.watcher-list__actions {
  display: flex;
  gap: 4px;
  margin-inline-start: auto;
}

.watcher-list__empty {
  margin: 0;
  padding: 18px 6px;
  color: $text-muted;
  font-size: 13px;
  text-align: center;
}

.watcher-list__items {
  margin: 0;
  padding: 0;
  list-style: none;
  overflow-y: auto;
  min-height: 0;
}

.watcher-item {
  display: flex;
  gap: 10px;
  padding: 10px 4px;
  border-bottom: var(--border-width, 1px) solid $border-light;

  &:last-child { border-bottom: 0; }
  &.is-unread .watcher-item__text { color: $text-primary; font-weight: 500; }
}

.watcher-item__severity {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  flex-shrink: 0;
  align-self: flex-start;
  min-width: 64px;
  padding: 1px 6px;
  border: var(--border-width, 1px) solid currentColor;
  border-radius: 999px;
  font-size: 11px;
  line-height: 18px;

  &.is-block { color: $error; }
  &.is-warn { color: $warning; }
  &.is-info { color: $text-secondary; }
}

.watcher-item__body {
  flex: 1;
  min-width: 0;
}

.watcher-item__meta {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
  color: $text-muted;
  font-size: 11px;
}

.watcher-item__new {
  color: $accent-primary;
  font-weight: 600;
}

.watcher-item__text {
  margin: 3px 0 6px;
  color: $text-secondary;
  font-size: 13px;
  line-height: 1.4;
  overflow-wrap: anywhere;
}

.watcher-item__buttons {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
</style>
