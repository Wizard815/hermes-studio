<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { NButton, NInput, NRadioButton, NRadioGroup, useDialog, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import QRCode from 'qrcode'
import {
  fetchApprovalAlerts, pairingLink, removePhone, sendTestAlert, startPhonePairing, studioOwnAlerts,
  STUDIO_OWN_ALERTS_EVENT, type ApprovalAlertsStatus, type PairingCode, type StudioOwnAlertsState,
} from '@/api/studio/approval-alerts'
import { routeIncludes, type ApprovalDevice } from '../../../../../shared/approval-alerts'

/** Settings → Android app (docs/approval-alerts.md): pair Studio Own for approval notifications. */
const { t, locale } = useI18n()
const message = useMessage()
const dialog = useDialog()
const router = useRouter()

const status = ref<ApprovalAlertsStatus | null>(null)
const loadError = ref(false)
const deviceName = ref('')
const pairing = ref<PairingCode | null>(null)
const qr = ref('')
const now = ref(Date.now())
const busy = ref(false)
const testResult = ref('')
const bridge = studioOwnAlerts()
const phone = ref<StudioOwnAlertsState | null>(null)
const phoneMessage = ref('')
const typedCode = ref('')
let clock = 0

const devices = computed<ApprovalDevice[]>(() => status.value?.devices || [])
const routeOn = computed(() => !!status.value && routeIncludes(status.value.prefs.route, 'android'))
const expired = computed(() => !!pairing.value && pairing.value.expiresAt <= now.value)

async function load() {
  try {
    status.value = await fetchApprovalAlerts()
    loadError.value = false
  } catch {
    loadError.value = true
  }
}

function onPhoneState(event: Event) {
  const detail = (event as CustomEvent<StudioOwnAlertsState>).detail
  if (!detail || typeof detail !== 'object') return
  phone.value = detail
  if (detail.message) phoneMessage.value = detail.message
  if (detail.paired) void load()
}

onMounted(() => {
  void load()
  clock = window.setInterval(() => { now.value = Date.now() }, 5000)
  if (bridge) {
    window.addEventListener(STUDIO_OWN_ALERTS_EVENT, onPhoneState)
    bridge.status()
  }
})

onBeforeUnmount(() => {
  window.clearInterval(clock)
  window.removeEventListener(STUDIO_OWN_ALERTS_EVENT, onPhoneState)
})

async function makeCode() {
  busy.value = true
  try {
    pairing.value = await startPhonePairing(deviceName.value.trim())
    now.value = Date.now()
    qr.value = await QRCode.toDataURL(pairingLink(window.location.origin, pairing.value.code), { margin: 2, width: 220, errorCorrectionLevel: 'M' })
  } catch {
    message.error(t('androidApp.actionFailed'))
  } finally {
    busy.value = false
  }
}

/** Inside Studio Own: make a code and hand it straight to the app. */
async function pairHere() {
  if (!bridge) return
  busy.value = true
  phoneMessage.value = t('androidApp.pairing')
  try {
    const { code } = await startPhonePairing(deviceName.value.trim())
    bridge.pair(code, deviceName.value.trim())
  } catch {
    phoneMessage.value = ''
    message.error(t('androidApp.actionFailed'))
  } finally {
    busy.value = false
  }
}

/** Inside Studio Own: a code made on another screen (a computer's Settings → Android app). */
function pairWithCode() {
  const code = typedCode.value.trim()
  if (!bridge || !code) return
  phoneMessage.value = t('androidApp.pairing')
  bridge.pair(code, deviceName.value.trim())
}

async function copyCode() {
  if (!pairing.value) return
  try {
    await navigator.clipboard.writeText(pairing.value.code)
    message.success(t('androidApp.copied'))
  } catch {
    message.error(t('androidApp.actionFailed'))
  }
}

function confirmRemove(device: ApprovalDevice) {
  dialog.warning({
    title: t('androidApp.remove'),
    content: t('androidApp.removeConfirm', { name: device.name }),
    positiveText: t('androidApp.remove'),
    negativeText: t('common.cancel'),
    onPositiveClick: async () => {
      try {
        const result = await removePhone(device.id)
        if (status.value) status.value = { ...status.value, devices: result.devices }
        message.success(t('androidApp.removed'))
      } catch {
        message.error(t('androidApp.actionFailed'))
      }
    },
  })
}

async function test() {
  try {
    const { connected } = await sendTestAlert()
    testResult.value = connected ? t('androidApp.testSent', { n: connected }) : t('androidApp.testNone')
    await load()
  } catch {
    message.error(t('androidApp.actionFailed'))
  }
}

function when(at: number) {
  return new Date(at).toLocaleString(locale.value, { dateStyle: 'short', timeStyle: 'short' })
}
</script>

<template>
  <section class="settings-section android-app" data-testid="android-app-settings" aria-labelledby="android-app-title">
    <h3 id="android-app-title" class="section-title">{{ t('androidApp.title') }}</h3>
    <p class="section-hint">{{ t('androidApp.intro') }}</p>
    <p v-if="loadError" class="android-app__error" role="alert">{{ t('androidApp.loadFailed') }}</p>

    <div v-if="status" class="android-app__route" role="status" data-testid="android-app-route">
      <span class="android-app__badge" :class="{ 'is-on': routeOn }">{{ routeOn ? t('androidApp.routeOn') : t('androidApp.routeOff') }}</span>
      <NButton size="small" quaternary data-testid="android-app-open-watcher" @click="router.push({ query: { tab: 'watcher' } })">{{ t('androidApp.openWatcher') }}</NButton>
    </div>

    <!-- Inside Studio Own: this phone's own state and controls. -->
    <div v-if="bridge" class="android-app__card" data-theme-surface="card" data-testid="android-app-this-phone">
      <h4 class="sub-title">{{ t('androidApp.thisPhone') }}</h4>
      <p class="section-hint" role="status" aria-live="polite">
        {{ phone?.paired ? t('androidApp.thisPhonePaired', { name: phone.deviceName }) : t('androidApp.thisPhoneNotPaired') }}
        <template v-if="phoneMessage"> {{ phoneMessage }}</template>
      </p>
      <template v-if="phone?.paired">
        <span id="android-app-mode" class="android-app__label">{{ t('androidApp.mode') }}</span>
        <NRadioGroup :value="phone.mode" aria-labelledby="android-app-mode" @update:value="(mode: 'live' | 'saver' | 'off') => bridge?.setMode(mode)">
          <NRadioButton v-for="mode in (['live', 'saver', 'off'] as const)" :key="mode" :value="mode" :label="t(`androidApp.modes.${mode}`)" />
        </NRadioGroup>
        <p class="section-hint android-app__mode-hint">{{ t(`androidApp.modeHints.${phone.mode}`) }}</p>
        <p v-if="phone.notifications === 'denied'" class="android-app__error" role="alert">{{ t('androidApp.notificationsOff') }}</p>
        <div v-if="phone.mode === 'live' && !phone.unrestricted" class="android-app__row">
          <p class="section-hint">{{ t('androidApp.battery') }}</p>
          <NButton size="small" @click="bridge?.openBatterySettings()">{{ t('androidApp.batteryButton') }}</NButton>
        </div>
        <NButton size="small" quaternary @click="bridge?.unpair()">{{ t('androidApp.unpair') }}</NButton>
      </template>
      <template v-else>
        <NButton type="primary" :loading="busy" data-testid="android-app-pair-here" @click="pairHere">{{ t('androidApp.pairHere') }}</NButton>
        <p class="section-hint android-app__mode-hint">{{ t('androidApp.enterCodeHint') }}</p>
        <div class="android-app__row">
          <label for="android-app-typed-code" class="android-app__label">{{ t('androidApp.codeLabel') }}</label>
          <NInput :input-props="{ id: 'android-app-typed-code' }" v-model:value="typedCode" size="small" placeholder="ABCD-EFGH" :maxlength="12" class="android-app__name" />
          <NButton size="small" :disabled="!typedCode.trim()" @click="pairWithCode">{{ t('androidApp.enterCode') }}</NButton>
        </div>
      </template>
    </div>

    <h4 class="sub-title">{{ t('androidApp.pairTitle') }}</h4>
    <p class="section-hint">{{ t('androidApp.pairHint') }}</p>
    <div class="android-app__row">
      <label for="android-app-device-name" class="android-app__label">{{ t('androidApp.deviceName') }}</label>
      <NInput :input-props="{ id: 'android-app-device-name' }" v-model:value="deviceName" size="small" placeholder="Pixel 8" :maxlength="60" class="android-app__name" data-testid="android-app-device-name" />
      <NButton size="small" type="primary" :loading="busy && !bridge" data-testid="android-app-make-code" @click="makeCode">{{ t('androidApp.pair') }}</NButton>
    </div>

    <div v-if="pairing" class="android-app__card android-app__code" data-theme-surface="card" data-testid="android-app-code">
      <template v-if="!expired">
        <img v-if="qr" :src="qr" :alt="t('androidApp.qrAlt')" class="android-app__qr" width="220" height="220" data-testid="android-app-qr">
        <div class="android-app__code-text">
          <h5 class="android-app__label">{{ t('androidApp.codeTitle') }}</h5>
          <p class="section-hint">{{ t('androidApp.codeHint') }}</p>
          <p class="android-app__label">{{ t('androidApp.codeLabel') }}</p>
          <code class="android-app__pin" data-testid="android-app-pin">{{ pairing.code }}</code>
          <p class="section-hint">{{ t('androidApp.expires', { time: when(pairing.expiresAt) }) }}</p>
          <NButton size="small" @click="copyCode">{{ t('androidApp.copy') }}</NButton>
        </div>
      </template>
      <p v-else class="android-app__error" role="status">{{ t('androidApp.expired') }}</p>
    </div>

    <h4 class="sub-title">{{ t('androidApp.devicesTitle') }}</h4>
    <ul v-if="devices.length" class="android-app__devices" data-testid="android-app-devices">
      <li v-for="device in devices" :key="device.id" class="android-app__device" data-testid="android-app-device">
        <div class="android-app__device-text">
          <strong>{{ device.name }}</strong>
          <span>
            <span class="android-app__badge" :class="{ 'is-on': device.connected }">{{ device.connected ? t('androidApp.connected') : t('androidApp.notConnected') }}</span>
            · <code>{{ device.preview }}</code>
            · {{ device.lastUsedAt ? t('androidApp.lastUsed', { when: when(device.lastUsedAt) }) : t('androidApp.neverUsed') }}
          </span>
        </div>
        <NButton size="small" quaternary :aria-label="t('androidApp.removeLabel', { name: device.name })" data-testid="android-app-remove" @click="confirmRemove(device)">{{ t('androidApp.remove') }}</NButton>
      </li>
    </ul>
    <p v-else class="section-hint">{{ t('androidApp.noDevices') }}</p>
    <div class="android-app__row">
      <NButton size="small" :disabled="!devices.length" data-testid="android-app-test" @click="test">{{ t('androidApp.test') }}</NButton>
      <span class="section-hint" role="status" aria-live="polite" data-testid="android-app-test-result">{{ testResult }}</span>
    </div>

    <h4 class="sub-title">{{ t('androidApp.stepsTitle') }}</h4>
    <ol class="android-app__steps">
      <li>{{ t('androidApp.step1') }}</li>
      <li>{{ t('androidApp.step2') }}</li>
      <li>{{ t('androidApp.step3') }}</li>
      <li>{{ t('androidApp.step4') }}</li>
    </ol>
  </section>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.section-title {
  margin: 0 0 6px;
  font-size: calc(var(--font-size-base, 14px) * 15 / 14);
  font-weight: 600;
  color: $text-primary;
}

.sub-title {
  margin: 22px 0 4px;
  font-size: calc(var(--font-size-base, 14px) * 14 / 14);
  font-weight: 600;
  color: $text-primary;
}

.section-hint {
  margin: 0 0 10px;
  color: $text-secondary;
  font-size: calc(var(--font-size-base, 14px) * 13 / 14);
}

.android-app__label {
  display: block;
  margin: 0 0 6px;
  color: $text-primary;
  font-size: 13px;
  font-weight: 600;
}

.android-app__error {
  margin: 0 0 10px;
  color: $error;
  font-size: 13px;
}

.android-app__route {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 6px;
}

.android-app__badge {
  color: $text-muted;
  font-size: 12px;
  font-weight: 600;

  &.is-on { color: $success; }
}

.android-app__card {
  margin: 14px 0;
  padding: 14px 16px;
  background: $bg-card;
  color: $text-primary;
  border: var(--border-width, 1px) solid $border-light;
  border-radius: var(--radius-component, 8px);
}

.android-app__mode-hint { margin-top: 8px; }

.android-app__row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 10px;

  .android-app__label,
  .section-hint { margin: 0; }
}

.android-app__name { width: 220px; }

.android-app__code {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 18px;
}

.android-app__qr {
  width: 220px;
  height: 220px;
  border-radius: var(--radius-component, 8px);
}

.android-app__code-text {
  flex: 1;
  min-width: 200px;
}

.android-app__pin {
  display: block;
  margin: 0 0 8px;
  color: $text-primary;
  font-family: $font-code;
  font-size: 26px;
  font-weight: 600;
  letter-spacing: 0.08em;
}

.android-app__devices {
  margin: 0 0 10px;
  padding: 0;
  list-style: none;
  border-top: var(--border-width, 1px) solid $border-light;
}

.android-app__device {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 0;
  border-bottom: var(--border-width, 1px) solid $border-light;
}

.android-app__device-text {
  display: flex;
  flex: 1;
  min-width: 0;
  flex-direction: column;
  gap: 2px;
  color: $text-muted;
  font-size: 12px;

  strong {
    color: $text-primary;
    font-size: 13px;
  }

  code { font-family: $font-code; overflow-wrap: anywhere; }
}

.android-app__steps {
  margin: 0;
  padding-inline-start: 20px;
  color: $text-secondary;
  font-size: 13px;

  li { margin-bottom: 4px; }
}

@media (max-width: 640px) {
  .android-app__name { width: 100%; }
}
</style>
