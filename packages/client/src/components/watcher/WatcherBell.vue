<script setup lang="ts">
import { computed, ref } from 'vue'
import { NPopover } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useWatcher } from '@/composables/useWatcher'
import WatcherAlertList from './WatcherAlertList.vue'

/**
 * The Watcher's bell (docs/watcher.md), like Unraid's notifications: unread
 * count, recent alerts, read/clear and "Trust this". `icon` sits in a top bar
 * or tab bar; `menu` is a full-width row for a phone's menu that opens the
 * list in a dialog (WatcherModal). Hidden for people who cannot see the feed.
 */
const props = withDefaults(defineProps<{ variant?: 'icon' | 'menu'; placement?: 'bottom-end' | 'bottom-start' | 'right-end' }>(), { variant: 'icon', placement: 'bottom-end' })
const emit = defineEmits<{ opened: [] }>()
const { t } = useI18n()
const watcher = useWatcher()
const open = ref(false)

const count = computed(() => watcher.unread.value)
const badge = computed(() => count.value > 99 ? '99+' : String(count.value))
const label = computed(() => count.value ? t('watcher.bellUnread', { n: count.value }) : t('watcher.bell'))

function show() {
  if (props.variant === 'menu') watcher.dialogOpen.value = true
  else open.value = true
  emit('opened')
  void watcher.refresh()
}
</script>

<template>
  <template v-if="watcher.available.value">
    <NPopover v-if="props.variant === 'icon'" v-model:show="open" trigger="click" :placement="props.placement" :show-arrow="false" class="watcher-popover" @update:show="(value: boolean) => { if (value) show() }">
      <template #trigger>
        <button
          type="button"
          class="watcher-bell"
          :class="{ 'has-unread': count > 0 }"
          :aria-label="label"
          :title="label"
          :aria-expanded="open"
          aria-haspopup="dialog"
          data-testid="watcher-bell"
        >
          <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15L6 16zM10 20.5a2 2 0 0 0 4 0" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" /></svg>
          <span v-if="count" class="watcher-bell__badge" data-testid="watcher-bell-count">{{ badge }}</span>
        </button>
      </template>
      <WatcherAlertList @navigate="open = false" />
    </NPopover>
    <template v-else>
      <button type="button" class="watcher-menu-row" :aria-label="label" data-testid="watcher-menu-row" @click="show">
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15L6 16zM10 20.5a2 2 0 0 0 4 0" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" /></svg>
        <span>{{ t('watcher.title') }}</span>
        <span v-if="count" class="watcher-bell__badge is-inline" data-testid="watcher-bell-count">{{ badge }}</span>
      </button>
    </template>
  </template>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.watcher-bell {
  position: relative;
  display: inline-grid;
  place-items: center;
  flex-shrink: 0;
  width: 32px;
  height: 32px;
  padding: 0;
  border: 0;
  border-radius: $radius-sm;
  color: $text-secondary;
  background: transparent;
  cursor: pointer;
  -webkit-app-region: no-drag;

  &:hover { color: $text-primary; background: $bg-card-hover; }
  &:focus-visible { outline: 2px solid $accent-primary; outline-offset: 1px; }
  &.has-unread { color: $text-primary; }
}

.watcher-bell__badge {
  position: absolute;
  top: 1px;
  inset-inline-end: 0;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  border-radius: 8px;
  background: $error;
  color: $bg-primary;
  font-size: 10px;
  font-weight: 700;
  line-height: 16px;
  text-align: center;

  &.is-inline {
    position: static;
    margin-inline-start: auto;
  }
}

.watcher-menu-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 36px;
  padding: 6px 10px;
  border: 0;
  border-radius: $radius-sm;
  color: $text-primary;
  background: transparent;
  font: inherit;
  font-size: 13px;
  text-align: start;
  cursor: pointer;

  &:hover { background: $bg-card-hover; }
  &:focus-visible { outline: 2px solid $accent-primary; }
}
</style>
