<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { NButton, NInput, NSpin, NSwitch, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import type { Socket } from 'socket.io-client'
import {
  connectAndroidDevice, connectAndroidSocket, disconnectAndroidDevice, fetchAndroidStatus, installAndroidApk,
  launchAndroidApp, pairAndroidDevice, saveAndroidSettings, startAndroidAvd, stopAndroidEmulator, studioOwnBridge,
  type AndroidDevice, type AndroidFrame, type AndroidStatus,
} from '@/api/studio/android'
import { keyboardInput, pointerGesture, type AndroidGesture, type AndroidKey } from '@/utils/android-input'
import { uploadRuntimeFiles } from '@/api/studio/files'

const { t } = useI18n()
const toast = useMessage()

const status = ref<AndroidStatus | null>(null)
const loading = ref(false)
const busy = ref('')
const selected = ref('')
const frameUrl = ref('')
const frameSource = ref<AndroidFrame['source'] | ''>('')
const screenError = ref('')
const connectEndpoint = ref('')
const pairEndpoint = ref('')
const pairCode = ref('')
const typed = ref('')
const lastPackage = ref('')
const apkInput = ref<HTMLInputElement | null>(null)
const screen = ref<HTMLImageElement | null>(null)
const phone = studioOwnBridge()
const termuxCommand = ref('')
const adbServer = ref('')
const termuxResult = ref('')

let socket: Socket | null = null
let watching = ''
let press: { x: number; y: number; t: number; id: number } | null = null
let pendingText = ''
let textTimer: ReturnType<typeof setTimeout> | null = null
let wheelDy = 0
let wheelTimer: ReturnType<typeof setTimeout> | null = null
let pollTimer: ReturnType<typeof setInterval> | null = null
const POLL_MS = 10_000

const devices = computed(() => status.value?.devices ?? [])
const ready = computed(() => devices.value.filter(device => device.state === 'device'))
const current = computed(() => devices.value.find(device => device.serial === selected.value) ?? null)

function deviceName(device: AndroidDevice) {
  return device.label || device.avd || device.model || device.serial
}

function deviceKind(device: AndroidDevice) {
  return t(`android.kind.${device.bluestacks ? 'bluestacks' : device.kind}`)
}

function failure(error: unknown) {
  toast.error((error as Error)?.message || String(error))
}

async function refresh(quiet = false) {
  if (!quiet) loading.value = true
  try {
    status.value = await fetchAndroidStatus()
    if (!quiet) adbServer.value = status.value.settings.adbServer
    if (!ready.value.some(device => device.serial === selected.value)) selected.value = ready.value[0]?.serial ?? ''
  } catch (error) {
    if (!quiet) failure(error)
  } finally {
    loading.value = false
  }
}

async function act(key: string, work: () => Promise<unknown>, done?: string) {
  busy.value = key
  try {
    await work()
    if (done) toast.success(done)
    await refresh()
  } catch (error) {
    failure(error)
  } finally {
    busy.value = ''
  }
}

const connect = () => act('connect', async () => {
  const result = await connectAndroidDevice(connectEndpoint.value)
  selected.value = result.serial
  connectEndpoint.value = ''
}, t('android.connected'))

const pair = () => act('pair', async () => {
  await pairAndroidDevice(pairEndpoint.value, pairCode.value)
  pairCode.value = ''
}, t('android.paired'))

const startAvd = (name: string) => act(`avd:${name}`, () => startAndroidAvd(name), t('android.emulatorStarting'))
const disconnect = (serial: string) => act(`dc:${serial}`, () => disconnectAndroidDevice(serial))
const stopEmulator = (serial: string) => act(`stop:${serial}`, () => stopAndroidEmulator(serial))
// While the page is open, keep the list current so remembered devices and BlueStacks reconnect on their own.
function poll() {
  if (document.visibilityState === 'visible' && !busy.value) void refresh(true)
}

const saveAdbServer = () => act('adbServer', async () => {
  await saveAndroidSettings({ adbServer: adbServer.value.trim() })
  selected.value = ''
})

const setDetectBlueStacks = (value: boolean) => act('detect', () => saveAndroidSettings({ detectBlueStacks: value }))
const forget = (endpoint: string) => act(`forget:${endpoint}`, () => saveAndroidSettings({
  autoConnect: (status.value?.settings.autoConnect ?? []).filter(item => item !== endpoint),
}))

function setFrame(frame: AndroidFrame) {
  if (frame.serial !== watching) return
  const url = URL.createObjectURL(new Blob([frame.data], { type: frame.mime }))
  const previous = frameUrl.value
  frameUrl.value = url
  frameSource.value = frame.source
  screenError.value = ''
  if (previous) setTimeout(() => URL.revokeObjectURL(previous), 1000)
}

function clearFrame() {
  if (frameUrl.value) URL.revokeObjectURL(frameUrl.value)
  frameUrl.value = ''
  frameSource.value = ''
}

function watchScreen(serial: string) {
  if (!socket) return
  if (watching && watching !== serial) socket.emit('screen.unwatch', { serial: watching })
  watching = serial
  clearFrame()
  if (!serial) return
  socket.emit('screen.watch', { serial }, (result: { ok: boolean; error?: string }) => {
    if (!result?.ok) screenError.value = result?.error || t('android.screenUnavailable')
  })
}

function send(gesture: AndroidGesture) {
  if (!socket || !selected.value) return
  socket.emit('input', { serial: selected.value, gesture }, (result: { ok: boolean; error?: string }) => {
    if (!result?.ok && result?.error) toast.warning(result.error)
  })
}

const pressKey = (key: AndroidKey) => send({ type: 'key', key })

function point(event: PointerEvent | WheelEvent) {
  const rect = screen.value!.getBoundingClientRect()
  return {
    x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
    y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)),
  }
}

function onPointerDown(event: PointerEvent) {
  if (event.button !== 0) return
  screen.value?.focus()
  screen.value?.setPointerCapture(event.pointerId)
  press = { ...point(event), t: performance.now(), id: event.pointerId }
}

function onPointerUp(event: PointerEvent) {
  if (!press || press.id !== event.pointerId) return
  const start = press
  press = null
  send(pointerGesture(start, { ...point(event), t: performance.now() }))
}

// Wheel and trackpad scrolling become one swipe once the wheel settles.
function onWheel(event: WheelEvent) {
  event.preventDefault()
  wheelDy += event.deltaY
  if (wheelTimer) clearTimeout(wheelTimer)
  const at = point(event)
  wheelTimer = setTimeout(() => {
    const dy = Math.max(-0.6, Math.min(0.6, wheelDy / 1000))
    wheelDy = 0
    if (Math.abs(dy) < 0.01) return
    send({ type: 'swipe', x1: at.x, y1: at.y, x2: at.x, y2: Math.min(1, Math.max(0, at.y - dy)), ms: 150 })
  }, 80)
}

function flushText() {
  if (textTimer) clearTimeout(textTimer)
  textTimer = null
  if (pendingText) send({ type: 'text', text: pendingText })
  pendingText = ''
}

function onKeyDown(event: KeyboardEvent) {
  const input = keyboardInput(event)
  if (!input) return
  event.preventDefault()
  if ('text' in input) {
    pendingText += input.text
    if (textTimer) clearTimeout(textTimer)
    textTimer = setTimeout(flushText, 150)
    return
  }
  flushText()
  pressKey(input.key)
}

function sendTyped() {
  if (!typed.value) return
  send({ type: 'text', text: typed.value })
  typed.value = ''
}

async function onApkChosen(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file || !selected.value) return
  const serial = selected.value
  await act('install', async () => {
    const [uploaded] = await uploadRuntimeFiles([file])
    const result = await installAndroidApk(serial, uploaded.path)
    lastPackage.value = result.packageName || lastPackage.value
  }, t('android.installed'))
}

const launch = () => act('launch', () => launchAndroidApp(selected.value, lastPackage.value.trim()))

function runInTermux(background: boolean) {
  if (!phone || !termuxCommand.value.trim()) return
  termuxResult.value = ''
  phone.runInTermux(termuxCommand.value, '', background)
}

function onTermuxResult(event: Event) {
  const detail = (event as CustomEvent<{ stdout?: string; stderr?: string; exitCode?: number; error?: string }>).detail || {}
  termuxResult.value = [
    detail.error,
    detail.stdout,
    detail.stderr,
    detail.exitCode != null ? `exit ${detail.exitCode}` : '',
  ].filter(Boolean).join('\n')
}

watch(selected, serial => watchScreen(serial))

onMounted(() => {
  socket = connectAndroidSocket()
  socket.on('screen.frame', (frame: AndroidFrame, ack?: () => void) => {
    setFrame(frame)
    ack?.()
  })
  socket.on('screen.ended', (data: { serial: string; reason: string }) => {
    if (data.serial !== watching) return
    watching = ''
    clearFrame()
    screenError.value = data.reason || t('android.screenUnavailable')
  })
  socket.on('connect', () => { if (selected.value) watchScreen(selected.value) })
  window.addEventListener('studio-own:termux-result', onTermuxResult)
  void refresh()
  pollTimer = setInterval(poll, POLL_MS)
})

onBeforeUnmount(() => {
  window.removeEventListener('studio-own:termux-result', onTermuxResult)
  if (pollTimer) clearInterval(pollTimer)
  if (textTimer) clearTimeout(textTimer)
  if (wheelTimer) clearTimeout(wheelTimer)
  socket?.disconnect()
  socket = null
  clearFrame()
})
</script>

<template>
  <div class="android-view" data-testid="android-view">
    <aside class="android-side">
      <section class="android-card" data-theme-surface="card">
        <header class="android-card-head">
          <h2>{{ t('android.title') }}</h2>
          <NButton size="small" quaternary :loading="loading" @click="refresh()">{{ t('android.refresh') }}</NButton>
        </header>
        <p v-if="status && !status.adb" class="android-notice" data-testid="android-no-adb">{{ t('android.noAdb') }}</p>
        <p v-else-if="status?.adbVersion" class="android-muted">
          adb {{ status.adbVersion }}<template v-if="status.settings.adbServer"> · {{ t('android.usingServer', { server: status.settings.adbServer }) }}</template>
        </p>
        <p v-if="status?.error" class="android-error">{{ status.error }}</p>
        <NSpin v-if="loading && !status" size="small" />
        <p v-else-if="status?.adb && !devices.length" class="android-muted">{{ t('android.noDevices') }}</p>
        <ul class="android-list" data-testid="android-devices">
          <li v-for="device in devices" :key="device.serial">
            <button
              type="button"
              class="android-device"
              :data-active="device.serial === selected"
              :disabled="device.state !== 'device'"
              @click="selected = device.serial"
            >
              <span class="android-device-name">{{ deviceName(device) }}</span>
              <span class="android-device-meta">
                {{ deviceKind(device) }} · {{ device.state === 'device' ? device.serial : device.state }}
              </span>
            </button>
            <NButton
              v-if="device.kind === 'network'"
              size="tiny" quaternary
              :loading="busy === `dc:${device.serial}`"
              @click="disconnect(device.serial)"
            >{{ t('android.disconnect') }}</NButton>
            <NButton
              v-else-if="device.avd && device.state === 'device'"
              size="tiny" quaternary
              :loading="busy === `stop:${device.serial}`"
              @click="stopEmulator(device.serial)"
            >{{ t('android.shutDown') }}</NButton>
          </li>
        </ul>
        <p v-if="devices.some(device => device.state === 'unauthorized')" class="android-muted">{{ t('android.unauthorized') }}</p>
      </section>

      <section v-if="status?.avds.length" class="android-card" data-theme-surface="card">
        <h3>{{ t('android.emulators') }}</h3>
        <ul class="android-list">
          <li v-for="avd in status.avds" :key="avd.name">
            <span class="android-device-name">{{ avd.name }}</span>
            <NButton v-if="!avd.running" size="tiny" :loading="busy === `avd:${avd.name}`" @click="startAvd(avd.name)">{{ t('android.start') }}</NButton>
            <span v-else class="android-running">{{ t('android.running') }}</span>
          </li>
        </ul>
      </section>

      <section v-if="status?.bluestacks.length" class="android-card" data-theme-surface="card" data-testid="android-bluestacks">
        <h3>{{ t('android.bluestacks') }}</h3>
        <ul class="android-list">
          <li v-for="instance in status.bluestacks" :key="instance.id">
            <span class="android-device-name">{{ instance.name }}</span>
            <span :class="instance.running ? 'android-running' : 'android-muted'">
              {{ instance.running ? t('android.bluestacksRunning', { port: instance.port }) : t('android.bluestacksStopped') }}
            </span>
          </li>
        </ul>
        <p v-if="status.bluestacks.some(instance => !instance.adbEnabled)" class="android-notice">{{ t('android.bluestacksAdbOff') }}</p>
      </section>

      <section class="android-card" data-theme-surface="card">
        <h3>{{ t('android.connectTitle') }}</h3>
        <p class="android-muted">{{ t('android.connectHint') }}</p>
        <form class="android-row" @submit.prevent="connect">
          <NInput v-model:value="connectEndpoint" size="small" placeholder="192.168.1.20:5555" data-testid="android-connect-endpoint" />
          <NButton size="small" attr-type="submit" :disabled="!connectEndpoint.trim()" :loading="busy === 'connect'">{{ t('android.connect') }}</NButton>
        </form>
        <h3>{{ t('android.pairTitle') }}</h3>
        <p class="android-muted">{{ t('android.pairHint') }}</p>
        <form class="android-row" @submit.prevent="pair">
          <NInput v-model:value="pairEndpoint" size="small" placeholder="192.168.1.20:37123" />
          <NInput v-model:value="pairCode" size="small" :placeholder="t('android.pairCode')" maxlength="6" />
          <NButton size="small" attr-type="submit" :disabled="!pairEndpoint.trim() || pairCode.length !== 6" :loading="busy === 'pair'">{{ t('android.pair') }}</NButton>
        </form>
      </section>

      <section v-if="status" class="android-card" data-theme-surface="card" data-testid="android-settings">
        <h3>{{ t('android.settingsTitle') }}</h3>
        <label class="android-row">
          <NSwitch
            size="small"
            :value="status.settings.detectBlueStacks"
            :loading="busy === 'detect'"
            data-testid="android-detect-bluestacks"
            @update:value="setDetectBlueStacks"
          />
          <span>{{ t('android.detectBluestacks') }}</span>
        </label>
        <h3>{{ t('android.adbServer') }}</h3>
        <p class="android-muted">{{ t('android.adbServerHint') }}</p>
        <form class="android-row" @submit.prevent="saveAdbServer">
          <NInput v-model:value="adbServer" size="small" placeholder="192.168.1.30:5037" clearable data-testid="android-adb-server" />
          <NButton size="small" attr-type="submit" :disabled="adbServer.trim() === status.settings.adbServer" :loading="busy === 'adbServer'">{{ t('android.save') }}</NButton>
        </form>
        <h3>{{ t('android.remembered') }}</h3>
        <p class="android-muted">{{ t('android.rememberedHint') }}</p>
        <ul class="android-list" data-testid="android-remembered">
          <li v-for="endpoint in status.settings.autoConnect" :key="endpoint">
            <span class="android-device-meta">{{ endpoint }}</span>
            <NButton size="tiny" quaternary :loading="busy === `forget:${endpoint}`" @click="forget(endpoint)">{{ t('android.forget') }}</NButton>
          </li>
        </ul>
      </section>

      <section v-if="phone" class="android-card" data-theme-surface="card" data-testid="android-this-phone">
        <h3>{{ t('android.thisPhone') }}</h3>
        <p class="android-muted">{{ phone.isTermuxInstalled() ? t('android.termuxHint') : t('android.termuxMissing') }}</p>
        <template v-if="phone.isTermuxInstalled()">
          <NInput v-model:value="termuxCommand" type="textarea" size="small" :autosize="{ minRows: 2, maxRows: 6 }" placeholder="pkg install android-tools" />
          <div class="android-row">
            <NButton size="small" :disabled="!termuxCommand.trim()" @click="runInTermux(true)">{{ t('android.runBackground') }}</NButton>
            <NButton size="small" quaternary :disabled="!termuxCommand.trim()" @click="runInTermux(false)">{{ t('android.openInTermux') }}</NButton>
          </div>
          <pre v-if="termuxResult" class="android-output">{{ termuxResult }}</pre>
        </template>
        <p class="android-muted">{{ t('android.phoneApkHint') }}</p>
      </section>
    </aside>

    <main class="android-main android-card" data-theme-surface="card">
      <template v-if="current">
        <header class="android-toolbar">
          <span class="android-device-name">{{ deviceName(current) }}</span>
          <span v-if="frameSource" class="android-muted">{{ t(`android.source.${frameSource}`) }}</span>
          <div class="android-toolbar-buttons">
            <NButton size="small" quaternary @click="pressKey('back')">{{ t('android.keys.back') }}</NButton>
            <NButton size="small" quaternary @click="pressKey('home')">{{ t('android.keys.home') }}</NButton>
            <NButton size="small" quaternary @click="pressKey('recents')">{{ t('android.keys.recents') }}</NButton>
            <NButton size="small" quaternary @click="pressKey('volume_down')">{{ t('android.keys.volumeDown') }}</NButton>
            <NButton size="small" quaternary @click="pressKey('volume_up')">{{ t('android.keys.volumeUp') }}</NButton>
            <NButton size="small" quaternary @click="pressKey('power')">{{ t('android.keys.power') }}</NButton>
            <NButton size="small" quaternary @click="send({ type: 'rotate' })">{{ t('android.keys.rotate') }}</NButton>
          </div>
        </header>
        <div class="android-stage">
          <img
            v-if="frameUrl"
            ref="screen"
            class="android-screen"
            :src="frameUrl"
            :alt="t('android.screenAlt', { name: deviceName(current) })"
            tabindex="0"
            draggable="false"
            data-testid="android-screen"
            @pointerdown="onPointerDown"
            @pointerup="onPointerUp"
            @pointercancel="() => (press = null)"
            @wheel="onWheel"
            @keydown="onKeyDown"
          />
          <p v-else-if="screenError" class="android-error">{{ screenError }}</p>
          <NSpin v-else />
        </div>
        <footer class="android-footer">
          <form class="android-row" @submit.prevent="sendTyped">
            <NInput v-model:value="typed" size="small" :placeholder="t('android.typePlaceholder')" />
            <NButton size="small" attr-type="submit" :disabled="!typed">{{ t('android.send') }}</NButton>
          </form>
          <div class="android-row">
            <input ref="apkInput" class="android-file" type="file" accept=".apk,application/vnd.android.package-archive" @change="onApkChosen" />
            <NButton size="small" :loading="busy === 'install'" @click="apkInput?.click()">{{ t('android.installApk') }}</NButton>
            <NInput v-model:value="lastPackage" size="small" placeholder="com.example.app" />
            <NButton size="small" quaternary :disabled="!lastPackage.trim()" :loading="busy === 'launch'" @click="launch">{{ t('android.open') }}</NButton>
          </div>
        </footer>
      </template>
      <p v-else class="android-empty">{{ t('android.pickDevice') }}</p>
    </main>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.android-view {
  display: flex;
  flex: 1;
  gap: 12px;
  width: 100%;
  min-width: 0;
  height: 100%;
  min-height: 0;
  padding: 12px 16px 16px;
  color: $text-primary;
  overflow: auto;
}

.android-side {
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: 320px;
  flex-shrink: 0;
}

.android-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  background: $bg-card;
  border: var(--border-width, 1px) solid $border-light;
  border-radius: var(--radius-component, 8px);

  h2, h3 {
    margin: 0;
    font-size: 14px;
    font-weight: 600;
  }
}

.android-card-head,
.android-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
}

.android-toolbar-buttons {
  display: flex;
  flex-wrap: wrap;
  gap: 2px;
}

.android-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;

  li {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
  }
}

.android-device {
  display: flex;
  flex: 1;
  flex-direction: column;
  align-items: flex-start;
  min-width: 0;
  padding: 6px 8px;
  color: inherit;
  font: inherit;
  text-align: left;
  background: transparent;
  border: var(--border-width, 1px) solid transparent;
  border-radius: var(--radius-component, 8px);
  cursor: pointer;

  &[data-active="true"] {
    border-color: $accent-primary;
  }

  &:disabled {
    cursor: default;
    color: $text-muted;
  }
}

.android-device-name {
  overflow: hidden;
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.android-device-meta,
.android-muted {
  margin: 0;
  font-size: 12px;
  color: $text-muted;
  overflow-wrap: anywhere;
}

.android-running {
  font-size: 12px;
  color: $success;
}

.android-notice {
  margin: 0;
  font-size: 13px;
  color: $warning;
}

.android-error {
  margin: 0;
  font-size: 13px;
  color: $error;
  overflow-wrap: anywhere;
}

.android-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;

  > .n-input {
    flex: 1;
    min-width: 120px;
  }
}

.android-main {
  flex: 1;
  min-width: 0;
  min-height: 0;
}

.android-stage {
  display: flex;
  flex: 1;
  align-items: center;
  justify-content: center;
  min-height: 320px;
}

.android-screen {
  max-width: 100%;
  max-height: calc(100vh - 220px);
  height: auto;
  border-radius: var(--radius-component, 8px);
  outline: none;
  cursor: pointer;
  touch-action: none;
  user-select: none;

  &:focus-visible {
    box-shadow: 0 0 0 2px $accent-primary;
  }
}

.android-footer {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.android-file {
  display: none;
}

.android-output {
  max-height: 200px;
  margin: 0;
  overflow: auto;
  font-family: $font-code;
  font-size: 12px;
  white-space: pre-wrap;
}

.android-empty {
  margin: auto;
  color: $text-muted;
}

@media (max-width: $breakpoint-mobile) {
  .android-view {
    flex-direction: column;
    padding: 8px;
  }

  .android-side {
    width: 100%;
  }
}
</style>
