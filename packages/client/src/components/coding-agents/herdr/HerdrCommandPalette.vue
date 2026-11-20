<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { paletteMatches, type PaletteItem } from './herdr-app-layout'

/**
 * The Herdr App layout's command palette (Ctrl+Shift+P): search spaces,
 * chats and actions; arrows move, Enter runs, Escape closes.
 */
const props = defineProps<{ items: PaletteItem[] }>()
const emit = defineEmits<{ run: [item: PaletteItem]; close: [] }>()
const { t } = useI18n()

const query = ref('')
const index = ref(0)
const field = ref<HTMLInputElement | null>(null)
const list = ref<HTMLElement | null>(null)
const matches = computed(() => paletteMatches(props.items, query.value))
watch(query, () => { index.value = 0 })

function move(step: number) {
  const count = matches.value.length
  if (!count) return
  index.value = (index.value + step + count) % count
  void nextTick(() => list.value?.querySelector<HTMLElement>(`[data-index="${index.value}"]`)?.scrollIntoView({ block: 'nearest' }))
}

function onKey(event: KeyboardEvent) {
  if (event.key === 'ArrowDown') { event.preventDefault(); move(1) }
  else if (event.key === 'ArrowUp') { event.preventDefault(); move(-1) }
  else if (event.key === 'Enter') {
    event.preventDefault()
    const item = matches.value[index.value]
    if (item) emit('run', item)
  } else if (event.key === 'Escape') { event.preventDefault(); emit('close') }
}

onMounted(() => field.value?.focus())
</script>

<template>
  <div class="pal-backdrop" data-testid="herdr-app-palette" @mousedown.self="emit('close')">
    <div class="pal" role="dialog" :aria-label="t('herdrApp.palette.title')" data-theme-surface="card">
      <input
        ref="field"
        v-model="query"
        class="pal-input"
        type="text"
        role="combobox"
        aria-expanded="true"
        aria-controls="herdr-palette-list"
        :aria-activedescendant="matches[index] ? `herdr-palette-${index}` : undefined"
        :placeholder="t('herdrApp.palette.placeholder')"
        data-testid="herdr-app-palette-input"
        @keydown="onKey"
      />
      <div id="herdr-palette-list" ref="list" class="pal-list" role="listbox">
        <p v-if="!matches.length" class="pal-empty">{{ t('herdrApp.palette.empty') }}</p>
        <button
          v-for="(item, i) in matches"
          :id="`herdr-palette-${i}`"
          :key="item.id"
          type="button"
          role="option"
          class="pal-item"
          :class="{ active: i === index }"
          :aria-selected="i === index"
          :data-index="i"
          :data-testid="`herdr-app-palette-item-${item.id}`"
          @mousemove="index = i"
          @click="emit('run', item)"
        >
          <span class="pal-kind">{{ t(`herdrApp.palette.${item.kind}`) }}</span>
          <span class="pal-label">{{ item.label }}</span>
          <span v-if="item.detail" class="pal-detail">{{ item.detail }}</span>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.pal-backdrop {
  position: fixed;
  z-index: 3000;
  inset: 0;
  display: flex;
  justify-content: center;
  align-items: flex-start;
  padding: 12vh 16px 16px;
  background: color-mix(in srgb, $text-primary 18%, transparent);
}

.pal {
  display: flex;
  flex-direction: column;
  width: min(600px, 100%);
  max-height: 60vh;
  overflow: hidden;
  border: var(--border-width, 1px) solid $border-light;
  border-radius: 12px;
  background: var(--theme-card-bg, $bg-card);
  box-shadow: 0 18px 50px color-mix(in srgb, $text-primary 22%, transparent);
}

.pal-input {
  flex: none;
  padding: 13px 16px;
  border: 0;
  border-bottom: var(--border-width, 1px) solid $border-light;
  background: transparent;
  color: $text-primary;
  font-size: 15px;
  outline: none;
}

.pal-list {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 6px;
}

.pal-empty {
  margin: 10px;
  font-size: 13px;
  color: $text-muted;
}

.pal-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  height: 34px;
  padding: 0 10px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: $text-primary;
  font-size: 13.5px;
  text-align: left;
  cursor: pointer;

  &.active {
    background: rgba(var(--accent-primary-rgb), 0.12);
  }
}

.pal-kind {
  flex: none;
  width: 56px;
  font-size: 11px;
  color: $text-muted;
}

.pal-label {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pal-detail {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: $text-muted;
  text-align: right;
}
</style>
