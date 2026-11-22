<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { NButton, NInput, NInputNumber, NSwitch, NTag, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { fetchGadgetStatus, gadgetDeviceUrl, gadgetState, updateGadgetPlatform, type GadgetStatus } from '@/api/hermes/gadget'
import { restartProfileGateway } from '@/api/hermes/profiles'

/** Hermes Gadget (Hermes plugin `gadget`): is it on, is the gateway listening, which devices are connected. */
const { t } = useI18n()
const message = useMessage()
const status = ref<GadgetStatus | null>(null)
const loading = ref(false)
const saving = ref(false)
const restarting = ref(false)
const host = ref('')
const port = ref<number | null>(null)
let timer: ReturnType<typeof setInterval> | null = null

const state = computed(() => status.value ? gadgetState(status.value) : null)
const url = computed(() => status.value ? gadgetDeviceUrl(status.value, window.location.hostname || 'this-host') : '')
const notice = computed(() => {
  switch (state.value) {
    case 'not-installed': return t('gadget.notInstalled')
    case 'plugin-off': return t('gadget.pluginOff')
    case 'platform-off': return t('gadget.platformOff')
    case 'gateway-stopped': return t('gadget.gatewayStopped')
    case 'restart': return t('gadget.needsRestart')
    case 'error': return t('gadget.gatewayError', { error: status.value?.gateway.error || '' })
    default: return ''
  }
})
const canConfigure = computed(() => !!status.value?.plugin.installed && !!status.value?.plugin.enabled)
const dirty = computed(() => !!status.value && (host.value.trim() !== status.value.platform.host || port.value !== status.value.platform.port))

async function load(quiet = false) {
  if (loading.value) return
  loading.value = !quiet
  try {
    const next = await fetchGadgetStatus()
    const first = !status.value
    status.value = next
    if (first || !dirty.value) {
      host.value = next.platform.host
      port.value = next.platform.port
    }
  } catch (error: any) {
    if (!quiet) message.error(error?.message || t('gadget.saveFailed'))
  } finally {
    loading.value = false
  }
}

async function save(change: { enabled?: boolean; host?: string; port?: number }) {
  saving.value = true
  try {
    await updateGadgetPlatform(change)
    message.success(t('gadget.saved'))
    await load(true)
    host.value = status.value?.platform.host || host.value
    port.value = status.value?.platform.port || port.value
  } catch (error: any) {
    message.error(error?.message || t('gadget.saveFailed'))
  } finally {
    saving.value = false
  }
}

function saveAddress() {
  void save({ host: host.value.trim(), port: port.value || undefined })
}

async function restart() {
  if (!status.value) return
  restarting.value = true
  try {
    await restartProfileGateway(status.value.profile)
    message.success(t('gadget.restarting'))
  } catch (error: any) {
    message.error(error?.message || t('gadget.restart'))
  } finally {
    restarting.value = false
    setTimeout(() => { void load(true) }, 4000)
  }
}

function seen(time: number | null): string {
  return time ? new Date(time * 1000).toLocaleString() : ''
}

onMounted(() => {
  void load()
  timer = setInterval(() => { void load(true) }, 10_000)
})
onBeforeUnmount(() => { if (timer) clearInterval(timer) })
</script>

<template>
  <section v-if="status" class="gadget-panel" data-theme-surface="card" data-testid="gadget-status">
    <header class="gadget-header">
      <div class="gadget-heading">
        <h3>{{ t('gadget.title') }}</h3>
        <p>{{ t('gadget.subtitle', { url }) }}</p>
      </div>
      <div class="gadget-actions">
        <NButton size="small" :loading="loading" @click="load()">{{ t('gadget.refresh') }}</NButton>
        <NButton
          v-if="canConfigure && status.platform.enabled"
          size="small"
          :type="state === 'restart' || state === 'gateway-stopped' ? 'primary' : 'default'"
          :loading="restarting"
          @click="restart"
        >
          {{ t('gadget.restart') }}
        </NButton>
      </div>
    </header>

    <div class="gadget-facts">
      <span class="gadget-fact">{{ t('gadget.plugin') }}
        <NTag size="small" round :bordered="false" :type="status.plugin.enabled ? 'success' : 'default'">{{ status.plugin.enabled ? t('gadget.on') : t('gadget.off') }}</NTag>
      </span>
      <span class="gadget-fact">{{ t('gadget.platform') }}
        <NTag size="small" round :bordered="false" :type="status.platform.enabled ? 'success' : 'default'">{{ status.platform.enabled ? t('gadget.on') : t('gadget.off') }}</NTag>
      </span>
      <span class="gadget-fact" data-testid="gadget-listening">{{ t('gadget.listening') }}
        <NTag size="small" round :bordered="false" :type="status.listening ? 'success' : 'warning'">{{ status.listening ? t('gadget.yes') : t('gadget.no') }}</NTag>
      </span>
      <span class="gadget-fact">{{ t('gadget.connected') }}
        <NTag size="small" round :bordered="false" :type="status.connected ? 'success' : 'default'">{{ status.connected }}</NTag>
      </span>
    </div>

    <p v-if="notice" class="gadget-notice" :class="{ 'is-error': state === 'error' }">{{ notice }}</p>

    <div v-if="canConfigure" class="gadget-config">
      <label class="gadget-field gadget-switch">
        <span>{{ t('gadget.platformSwitch') }}</span>
        <NSwitch :value="status.platform.enabled" :loading="saving" @update:value="value => save({ enabled: value })" />
      </label>
      <label class="gadget-field">
        <span>{{ t('gadget.bindAddress') }}</span>
        <NInput v-model:value="host" size="small" placeholder="0.0.0.0" :disabled="saving" />
      </label>
      <label class="gadget-field gadget-port">
        <span>{{ t('gadget.port') }}</span>
        <NInputNumber v-model:value="port" size="small" :min="1" :max="65535" :show-button="false" :disabled="saving" />
      </label>
      <NButton size="small" type="primary" :disabled="!dirty || !host.trim() || !port" :loading="saving" @click="saveAddress">{{ t('gadget.save') }}</NButton>
      <p class="gadget-hint">{{ t('gadget.bindHint', { port: status.platform.port }) }}</p>
    </div>

    <ul v-if="status.devices.length" class="gadget-devices">
      <li v-for="device in status.devices" :key="device.id" class="gadget-device">
        <div class="gadget-device-name">
          <strong>{{ device.name || device.id }}</strong>
          <span v-if="device.name" class="gadget-muted">{{ device.id }}</span>
        </div>
        <div class="gadget-device-meta">
          <NTag size="small" round :bordered="false" :type="device.online ? 'success' : 'default'">{{ device.online ? t('gadget.online') : t('gadget.offline') }}</NTag>
          <NTag v-if="device.pending" size="small" round :bordered="false" type="warning">{{ t('gadget.pending') }}</NTag>
          <span v-if="device.board" class="gadget-muted">{{ device.board }}<template v-if="device.firmware"> · {{ device.firmware }}</template></span>
          <span v-if="device.batteryPercent !== null" class="gadget-muted">{{ t('gadget.battery', { percent: Math.round(device.batteryPercent) }) }}</span>
          <span v-if="!device.online && device.lastSeen" class="gadget-muted">{{ t('gadget.lastSeen', { time: seen(device.lastSeen) }) }}</span>
        </div>
      </li>
    </ul>
    <p v-else-if="canConfigure" class="gadget-hint">{{ t('gadget.noDevices') }}</p>
  </section>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.gadget-panel {
  margin: calc(16px * var(--spacing-scale, 1)) calc(20px * var(--spacing-scale, 1)) 0;
  padding: calc(12px * var(--spacing-scale, 1)) calc(16px * var(--spacing-scale, 1));
  background: $bg-card;
  color: $text-primary;
  border: var(--border-width, 1px) solid $border-light;
  border-radius: var(--radius-component, 8px);
  display: flex;
  flex-direction: column;
  gap: calc(10px * var(--spacing-scale, 1));
}

.gadget-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: calc(12px * var(--spacing-scale, 1));
}

.gadget-heading {
  min-width: 0;

  h3 {
    margin: 0;
    font-size: calc(var(--font-size-base, 14px) * 15 / 14);
    font-weight: 650;
  }

  p {
    margin: 2px 0 0;
    color: $text-muted;
    font-size: calc(var(--font-size-base, 14px) * 12 / 14);
    word-break: break-word;
  }
}

.gadget-actions {
  display: flex;
  gap: calc(8px * var(--spacing-scale, 1));
  flex-wrap: wrap;
  justify-content: flex-end;
}

.gadget-facts {
  display: flex;
  flex-wrap: wrap;
  gap: calc(8px * var(--spacing-scale, 1)) calc(18px * var(--spacing-scale, 1));
}

.gadget-fact {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: $text-secondary;
  font-size: calc(var(--font-size-base, 14px) * 13 / 14);
}

.gadget-notice {
  margin: 0;
  color: $warning;
  font-size: calc(var(--font-size-base, 14px) * 13 / 14);

  &.is-error { color: $error; }
}

.gadget-config {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: calc(10px * var(--spacing-scale, 1)) calc(14px * var(--spacing-scale, 1));
}

.gadget-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 160px;
  color: $text-secondary;
  font-size: calc(var(--font-size-base, 14px) * 12 / 14);
}

.gadget-switch { min-width: auto; }
.gadget-port { min-width: 96px; width: 96px; }

.gadget-hint {
  flex-basis: 100%;
  margin: 0;
  color: $text-muted;
  font-size: calc(var(--font-size-base, 14px) * 12 / 14);
}

.gadget-devices {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.gadget-device {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 6px 12px;
  padding: 6px 0;
  border-top: var(--border-width, 1px) solid $border-light;
}

.gadget-device-name {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
  word-break: break-all;
}

.gadget-device-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 10px;
}

.gadget-muted {
  color: $text-muted;
  font-size: calc(var(--font-size-base, 14px) * 12 / 14);
}

@media (max-width: $breakpoint-mobile) {
  .gadget-panel { margin: calc(12px * var(--spacing-scale, 1)) calc(12px * var(--spacing-scale, 1)) 0; }
  .gadget-header { flex-direction: column; }
  .gadget-actions { justify-content: flex-start; }
  .gadget-field { min-width: 0; flex: 1 1 140px; }
}
</style>
