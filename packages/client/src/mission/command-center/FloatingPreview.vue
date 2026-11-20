<script setup lang="ts">
import { defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { NSpin } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useFilesStore } from '@/stores/hermes/files'
import { fetchSessionWorkspaceFileText } from '@/api/studio/sessions'
import { tsvToCsv } from './files'

const FilePreview = defineAsyncComponent(async () => (await import('@/components/hermes/files/FilePreview.vue')).default)
const SpreadsheetFilePreview = defineAsyncComponent(async () => (await import('@/components/hermes/files/SpreadsheetFilePreview.vue')).default)

/**
 * Roundup's floating preview: a file from the Files tab over the page, with
 * Studio's own previews (Markdown, images, PDF, CSV and spreadsheets, code
 * and JSON). TSV is shown as a table too. Drag it by its header, resize it
 * from the corner; Esc closes it. On a phone it fills the screen.
 */
const props = defineProps<{ sessionId: string; path: string; name: string; size: number; phone: boolean }>()
const emit = defineEmits<{ close: [] }>()
const { t } = useI18n()
const files = useFilesStore()
const tsv = ref('')
const loading = ref(false)
const error = ref('')
const closeButton = ref<HTMLButtonElement | null>(null)
const position = ref<{ x: number; y: number } | null>(null)

async function load() {
  error.value = ''
  tsv.value = ''
  if (/\.tsv$/i.test(props.name)) {
    loading.value = true
    try { tsv.value = tsvToCsv((await fetchSessionWorkspaceFileText(props.sessionId, props.path)).content) } catch (err: any) { error.value = err?.message || String(err) } finally { loading.value = false }
    return
  }
  try { await files.openSessionWorkspacePreview(props.sessionId, props.path, props.name, props.size) } catch (err: any) { error.value = err?.message || String(err) }
}

function close() {
  files.closePreview()
  emit('close')
}

function onKey(event: KeyboardEvent) {
  if (event.key === 'Escape') { event.stopPropagation(); close() }
}

let drag: { dx: number; dy: number } | null = null
function startDrag(event: PointerEvent) {
  if (props.phone || (event.target as HTMLElement).closest('button')) return
  const panel = (event.currentTarget as HTMLElement).parentElement!
  const rect = panel.getBoundingClientRect()
  drag = { dx: event.clientX - rect.left, dy: event.clientY - rect.top }
  window.addEventListener('pointermove', onDrag)
  window.addEventListener('pointerup', endDrag, { once: true })
}
function onDrag(event: PointerEvent) {
  if (!drag) return
  position.value = {
    x: Math.max(0, Math.min(window.innerWidth - 120, event.clientX - drag.dx)),
    y: Math.max(0, Math.min(window.innerHeight - 60, event.clientY - drag.dy)),
  }
}
function endDrag() {
  drag = null
  window.removeEventListener('pointermove', onDrag)
}

watch(() => `${props.sessionId}|${props.path}`, () => { void load() })
onMounted(() => {
  void load()
  void nextTick(() => closeButton.value?.focus())
})
onBeforeUnmount(() => {
  endDrag()
  files.closePreview()
})
</script>

<template>
  <Teleport to="body">
    <div
      class="cc-float"
      :class="{ 'is-phone': phone }"
      role="dialog"
      :aria-label="name"
      data-theme-surface="card"
      data-testid="cc-float-preview"
      :style="position && !phone ? { left: `${position.x}px`, top: `${position.y}px`, right: 'auto' } : undefined"
      @keydown="onKey"
    >
      <header class="cc-float-head" @pointerdown="startDrag">
        <span class="cc-float-name" :title="path">{{ name }}</span>
        <button ref="closeButton" type="button" class="cc-float-close" :aria-label="t('files.closePreview')" :title="t('files.closePreview')" data-testid="cc-float-close" @click="close">×</button>
      </header>
      <div class="cc-float-body">
        <NSpin v-if="loading" size="small" />
        <p v-else-if="error" class="cc-float-error">{{ error }}</p>
        <SpreadsheetFilePreview v-else-if="tsv" kind="csv" :source="tsv" />
        <FilePreview v-else :custom-close="close" />
      </div>
    </div>
  </Teleport>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.cc-float {
  position: fixed;
  z-index: 2000;
  top: 72px;
  right: 24px;
  display: flex;
  flex-direction: column;
  width: min(760px, 60vw);
  height: min(640px, 78vh);
  min-width: 320px;
  min-height: 240px;
  max-width: 96vw;
  max-height: 92vh;
  resize: both;
  overflow: hidden;
  background: $bg-card;
  color: $text-primary;
  border: var(--border-width, 1px) solid $border-light;
  border-radius: var(--radius-component, 10px);
  box-shadow: 0 18px 48px rgba(var(--shadow-rgb, 0, 0, 0), 0.28);

  &.is-phone {
    inset: 0;
    width: auto;
    height: auto;
    min-width: 0;
    max-width: none;
    max-height: none;
    resize: none;
    border-radius: 0;
  }
}

.cc-float-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px 6px 12px;
  border-bottom: var(--border-width, 1px) solid $border-light;
  cursor: move;
  user-select: none;
  touch-action: none;

  .is-phone & {
    cursor: default;
  }
}

.cc-float-name {
  flex: 1 1 auto;
  overflow: hidden;
  font-size: 13px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cc-float-close {
  flex: none;
  width: 28px;
  height: 28px;
  border: 0;
  border-radius: 999px;
  background: transparent;
  color: $text-secondary;
  font-size: 18px;
  cursor: pointer;

  &:hover,
  &:focus-visible {
    color: $text-primary;
    background: rgba(var(--accent-primary-rgb), 0.12);
    outline: none;
  }
}

.cc-float-body {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  min-height: 0;
  overflow: auto;

  :deep(.file-preview) {
    flex: 1 1 auto;
    min-height: 0;
  }
}

.cc-float-error {
  margin: 12px;
  color: $error;
  font-size: 13px;
}
</style>
