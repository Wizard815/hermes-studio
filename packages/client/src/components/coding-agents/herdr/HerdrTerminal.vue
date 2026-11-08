<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch, computed } from 'vue'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { useI18n } from 'vue-i18n'
import { useTheme } from '@/composables/useTheme'
import { terminalTheme } from '@/styles/theme-integrations'
import { useHerdrStore } from '@/stores/hermes/herdr'

/**
 * One live herdr stream rendered with xterm.js.
 * - client: herdr's own full UI (the "swap to herdr" view)
 * - observe: read-only view of a pane
 * - control: writable view of a pane (takes input ownership)
 */
const props = withDefaults(defineProps<{
  mode: 'client' | 'observe' | 'control'
  target?: string
  takeover?: boolean
  /**
   * Columns to hide at the left edge (herdr's collapsed sidebar rail, when
   * Studio shows its own spaces panel instead), while the terminal is wider
   * than `cropAbove` columns (herdr's phone layout has no rail).
   */
  cropLeft?: number
  cropAbove?: number
}>(), { target: '', takeover: false, cropLeft: 0, cropAbove: 0 })

const emit = defineEmits<{ closed: [reason: string]; error: [message: string] }>()

const { t } = useI18n()
const herdr = useHerdrStore()
const { customization, isDark } = useTheme()
const host = ref<HTMLDivElement | null>(null)
const state = ref<'connecting' | 'open' | 'closed'>('connecting')
const closedReason = ref('')
const streamId = `s${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`
const readOnly = computed(() => props.mode === 'observe')

let term: Terminal | null = null
let fit: FitAddon | null = null
let observer: ResizeObserver | null = null
let socket: ReturnType<typeof herdr.acquire> | null = null
let lastSize = ''

function decode(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function onData(payload: { streamId: string; bytes: string }) {
  if (payload?.streamId === streamId && term) term.write(decode(payload.bytes))
}

function onClosed(payload: { streamId: string; reason: string }) {
  if (payload?.streamId !== streamId) return
  state.value = 'closed'
  closedReason.value = payload.reason || ''
  emit('closed', closedReason.value)
}

/** Widen the terminal past the left edge so the cropped columns sit off screen. */
function applyCrop() {
  const el = host.value
  if (!el || !term) return
  const cell = (term as any)._core?._renderService?.dimensions?.css?.cell?.width || 0
  const visible = cell ? Math.floor((el.parentElement?.clientWidth || 0) / cell) : 0
  const crop = props.cropLeft > 0 && cell && visible + props.cropLeft > props.cropAbove ? props.cropLeft * cell : 0
  el.style.flex = crop ? `0 0 calc(100% + ${crop}px)` : ''
  el.style.transform = crop ? `translateX(-${crop}px)` : ''
  el.style.paddingLeft = crop ? '0' : ''
}

function sizeNow() {
  if (!fit || !term) return
  applyCrop()
  try { fit.fit() } catch { return }
  const key = `${term.cols}x${term.rows}`
  if (key === lastSize) return
  lastSize = key
  socket?.emit('terminal.resize', { streamId, cols: term.cols, rows: term.rows })
}

function open() {
  if (!socket || !term) return
  state.value = 'connecting'
  closedReason.value = ''
  term.reset()
  socket.emit('terminal.open', {
    streamId,
    mode: props.mode,
    target: props.target,
    takeover: props.takeover,
    cols: term.cols,
    rows: term.rows,
  }, (result: { ok: boolean; error?: string }) => {
    if (result?.ok) {
      state.value = 'open'
      return
    }
    state.value = 'closed'
    closedReason.value = result?.error || 'error'
    emit('error', closedReason.value)
  })
}

function reconnectOnSocket() {
  // The socket reconnected: server-side streams died with the old connection.
  if (state.value !== 'connecting') open()
}

onMounted(() => {
  term = new Terminal({
    cursorBlink: props.mode !== 'observe',
    disableStdin: readOnly.value,
    fontSize: customization.value.fontSize,
    fontFamily: 'Menlo, Monaco, "Courier New", monospace',
    allowTransparency: true,
    theme: terminalTheme(customization.value, isDark.value),
    scrollback: props.mode === 'client' ? 0 : 2000,
    convertEol: false,
  })
  fit = new FitAddon()
  term.loadAddon(fit)
  term.open(host.value!)
  try { fit.fit() } catch { /* hidden on mount */ }
  lastSize = `${term.cols}x${term.rows}`
  term.onData(data => {
    if (!readOnly.value && state.value === 'open') socket?.emit('terminal.input', { streamId, data })
  })
  socket = herdr.acquire()
  socket.on('terminal.data', onData)
  socket.on('terminal.closed', onClosed)
  socket.on('connect', reconnectOnSocket)
  observer = new ResizeObserver(() => sizeNow())
  // The frame, not the host: the host's width changes with the crop.
  observer.observe(host.value!.parentElement || host.value!)
  sizeNow()
  if (socket.connected) open()
  else socket.once('connect', open)
})

watch([customization, isDark], () => {
  if (!term) return
  term.options.theme = terminalTheme(customization.value, isDark.value)
  term.options.fontSize = customization.value.fontSize
  sizeNow()
})

watch(() => [props.cropLeft, props.cropAbove], () => sizeNow())

watch(() => [props.mode, props.target, props.takeover], () => {
  if (!socket || !term) return
  socket.emit('terminal.close', { streamId })
  if (term) term.options.disableStdin = readOnly.value
  open()
})

onBeforeUnmount(() => {
  observer?.disconnect()
  if (socket) {
    socket.emit('terminal.close', { streamId })
    socket.off('terminal.data', onData)
    socket.off('terminal.closed', onClosed)
    socket.off('connect', reconnectOnSocket)
    socket.off('connect', open)
    herdr.release()
  }
  term?.dispose()
  term = null
})

/** Type into the terminal as the user would (buttons that press herdr keys). False when it is not connected. */
function send(data: string): boolean {
  const sent = !readOnly.value && state.value === 'open' && !!socket
  if (sent) socket!.emit('terminal.input', { streamId, data })
  term?.focus()
  return sent
}

defineExpose({ reopen: open, focus: () => term?.focus(), send })
</script>

<template>
  <div class="herdr-terminal" data-theme-surface="card">
    <div ref="host" class="herdr-terminal-host" :data-mode="mode" />
    <div v-if="state !== 'open'" class="herdr-terminal-overlay">
      <span v-if="state === 'connecting'">{{ t('herdr.terminal.connecting') }}</span>
      <template v-else>
        <span>{{ t('herdr.terminal.closed') }}<template v-if="closedReason">: {{ closedReason }}</template></span>
        <button type="button" class="herdr-terminal-retry" @click="open">{{ t('herdr.terminal.reconnect') }}</button>
      </template>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.herdr-terminal {
  position: relative;
  display: flex;
  min-height: 0;
  flex: 1 1 auto;
  overflow: hidden;
  background: $bg-card;
  border: var(--border-width, 1px) solid $border-light;
  border-radius: var(--radius-component, 8px);
}

.herdr-terminal-host {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  padding: 6px;
}

.herdr-terminal-overlay {
  position: absolute;
  inset: auto 12px 12px auto;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-radius: var(--radius-component, 8px);
  border: var(--border-width, 1px) solid $border-light;
  background: var(--theme-card-bg, $bg-card);
  color: $text-secondary;
  font-size: 12px;
}

.herdr-terminal-retry {
  border: var(--border-width, 1px) solid $border-light;
  border-radius: var(--radius-component, 6px);
  background: transparent;
  color: $accent-primary;
  padding: 2px 8px;
  cursor: pointer;
}
</style>
