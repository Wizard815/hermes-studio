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
  /** client mode: which sidebar Studio's page shows (herdr's own is hidden under Studio's Spaces). */
  sidebar?: 'studio' | 'herdr'
  /**
   * A pane inside Studio's Herdr App layout: no frame of its own (the pane
   * draws it), and the wheel scrolls herdr's history of the pane (its frames
   * are the screen; herdr keeps the scrollback).
   */
  bare?: boolean
}>(), { target: '', takeover: false, sidebar: undefined, bare: false })

const emit = defineEmits<{ closed: [reason: string]; error: [message: string]; focused: [] }>()

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

/**
 * Studio's terminal colors; a bare pane takes its pane's background (the
 * nearest `[data-herdr-pane]`), so the terminal and its padding are one color.
 */
function themeNow() {
  const theme = terminalTheme(customization.value, isDark.value)
  if (!props.bare) return theme
  const pane = host.value?.closest('[data-herdr-pane]') as HTMLElement | null
  const fill = pane ? getComputedStyle(pane).backgroundColor : ''
  return fill && !/^rgba\(.*,\s*0\)$/.test(fill) && fill !== 'transparent' ? { ...theme, background: fill } : theme
}

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

function sizeNow() {
  if (!fit || !term) return
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
    ...(props.sidebar ? { sidebar: props.sidebar } : {}),
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
    theme: themeNow(),
    scrollback: props.mode === 'client' || props.bare ? 0 : 2000,
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
  term.textarea?.addEventListener('focus', () => emit('focused'))
  if (props.bare) {
    // herdr scrolls the pane itself (a copy of its history); xterm keeps none here.
    let carry = 0
    term.attachCustomWheelEventHandler(event => {
      if (state.value !== 'open' || props.mode === 'client') return true
      carry += event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY
      const lines = Math.trunc(carry / 16)
      if (!lines) return false
      carry -= lines * 16
      socket?.emit('terminal.scroll', { streamId, direction: lines < 0 ? 'up' : 'down', lines: Math.min(Math.abs(lines), 50) })
      return false
    })
  }
  socket = herdr.acquire()
  socket.on('terminal.data', onData)
  socket.on('terminal.closed', onClosed)
  socket.on('connect', reconnectOnSocket)
  observer = new ResizeObserver(() => sizeNow())
  observer.observe(host.value!.parentElement || host.value!)
  sizeNow()
  if (socket.connected) open()
  else socket.once('connect', open)
})

watch([customization, isDark], () => {
  if (!term) return
  // The pane's colors follow the theme a moment later (CSS variables).
  if (props.bare) window.setTimeout(() => { if (term) term.options.theme = themeNow() }, 50)
  term.options.theme = themeNow()
  term.options.fontSize = customization.value.fontSize
  sizeNow()
})

watch(() => [props.mode, props.target, props.takeover, props.sidebar], () => {
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

defineExpose({ reopen: open, focus: () => term?.focus(), send, state })
</script>

<template>
  <div class="herdr-terminal" :class="{ 'is-bare': bare }" data-theme-surface="card">
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

// A pane of the Herdr App layout: the pane is the frame; terminal padding 14 x 12 (main-folders.json).
.herdr-terminal.is-bare {
  border: 0;
  border-radius: 0;
  background: transparent;

  .herdr-terminal-host {
    padding: 10px 12px 8px 14px;
  }

  // No xterm scrollback here (herdr scrolls the pane): no scrollbar to eat a column.
  :deep(.xterm-viewport) {
    overflow-y: hidden;
  }
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
