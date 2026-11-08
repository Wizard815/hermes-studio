<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { NButton, NInput, NPopconfirm, NSpin, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import SparkLine from '@/components/common/SparkLine.vue'
import {
  dockerAction, fetchDocker, fetchDockerLogs, fetchSystemSnapshot, signalProcess,
  type DockerContainer, type DockerStatus, type SystemProcess, type SystemSnapshot,
} from '@/api/studio/system-monitor'
import { formatBytes, formatRate, formatUptime, pushHistory, sortProcesses, type ProcessSortKey } from '@/utils/system-format'

const INTERVAL_SECONDS = 2
const DOCKER_EVERY = 3
const VISIBLE_PROCESSES = 150

const { t } = useI18n()
const toast = useMessage()

const snapshot = ref<SystemSnapshot | null>(null)
const docker = ref<DockerStatus | null>(null)
const error = ref('')
const paused = ref(false)
const cpuHistory = ref<number[]>([])
const rxHistory = ref<number[]>([])
const txHistory = ref<number[]>([])
const filter = ref('')
const sortKey = ref<ProcessSortKey>('cpuPercent')
const descending = ref(true)
const busy = ref('')
const logsFor = ref<DockerContainer | null>(null)
const logs = ref('')

let timer: ReturnType<typeof setTimeout> | null = null
let ticks = 0
let stopped = false

const memoryPercent = computed(() => {
  const m = snapshot.value?.memory
  return m && m.totalBytes ? (m.usedBytes / m.totalBytes) * 100 : 0
})
const swapPercent = computed(() => {
  const m = snapshot.value?.memory
  return m && m.swapTotalBytes ? (m.swapUsedBytes / m.swapTotalBytes) * 100 : 0
})
const totals = computed(() => (snapshot.value?.network ?? []).reduce(
  (sum, iface) => ({ rx: sum.rx + (iface.rxBytesPerSec ?? 0), tx: sum.tx + (iface.txBytesPerSec ?? 0) }), { rx: 0, tx: 0 }))
const processes = computed(() => sortProcesses(snapshot.value?.processes.list ?? [], sortKey.value, descending.value, filter.value))
const visibleProcesses = computed(() => processes.value.slice(0, VISIBLE_PROCESSES))

const percent = (value: number) => `${value.toFixed(1)}%`
const clamp = (value: number) => Math.min(100, Math.max(0, value || 0))

function sortBy(key: ProcessSortKey) {
  if (sortKey.value === key) descending.value = !descending.value
  else { sortKey.value = key; descending.value = key !== 'name' && key !== 'pid' }
}

function sortMark(key: ProcessSortKey) {
  return sortKey.value === key ? (descending.value ? ' ↓' : ' ↑') : ''
}

async function loadSnapshot() {
  try {
    const next = await fetchSystemSnapshot()
    snapshot.value = next
    cpuHistory.value = pushHistory(cpuHistory.value, next.cpu.percent)
    const rx = next.network.reduce((sum, iface) => sum + (iface.rxBytesPerSec ?? 0), 0)
    const tx = next.network.reduce((sum, iface) => sum + (iface.txBytesPerSec ?? 0), 0)
    rxHistory.value = pushHistory(rxHistory.value, rx)
    txHistory.value = pushHistory(txHistory.value, tx)
    error.value = ''
  } catch (err) {
    error.value = (err as Error).message
  }
}

async function loadDocker() {
  try { docker.value = await fetchDocker() } catch (err) { docker.value = { available: false, error: (err as Error).message, containers: [] } }
}

async function tick() {
  if (stopped) return
  if (!paused.value && document.visibilityState !== 'hidden') {
    await loadSnapshot()
    if (ticks % DOCKER_EVERY === 0) await loadDocker()
    ticks += 1
  }
  if (!stopped) timer = setTimeout(() => { void tick() }, INTERVAL_SECONDS * 1000)
}

async function act(key: string, work: () => Promise<unknown>, done?: string) {
  busy.value = key
  try {
    await work()
    if (done) toast.success(done)
  } catch (err) {
    toast.error((err as Error).message)
  } finally {
    busy.value = ''
  }
}

const endProcess = (process: SystemProcess, signal: 'SIGTERM' | 'SIGKILL') =>
  act(`${signal}:${process.pid}`, async () => { await signalProcess(process.pid, signal); await loadSnapshot() },
    t(signal === 'SIGKILL' ? 'system.killed' : 'system.ended', { name: process.name }))

const containerAction = (container: DockerContainer, action: 'start' | 'stop' | 'restart') =>
  act(`${action}:${container.id}`, async () => { await dockerAction(container.id, action); await loadDocker() })

async function showLogs(container: DockerContainer) {
  if (logsFor.value?.id === container.id) { logsFor.value = null; return }
  logsFor.value = container
  logs.value = ''
  await act(`logs:${container.id}`, async () => { logs.value = (await fetchDockerLogs(container.id)).logs })
}

onMounted(() => { void tick() })
onBeforeUnmount(() => {
  stopped = true
  if (timer) clearTimeout(timer)
})
</script>

<template>
  <div class="system-view" data-testid="system-view">
    <header class="system-bar system-card" data-theme-surface="card">
      <div class="system-title">
        <h2>{{ t('system.title') }}</h2>
        <span v-if="snapshot" class="system-muted">
          {{ snapshot.host.hostname }} · {{ snapshot.host.distro }} {{ snapshot.host.release }} · {{ t('system.uptime', { time: formatUptime(snapshot.host.uptimeSeconds) }) }}
        </span>
      </div>
      <NButton size="small" :type="paused ? 'primary' : 'default'" secondary data-testid="system-pause" @click="paused = !paused">
        {{ paused ? t('system.resume') : t('system.pause') }}
      </NButton>
    </header>

    <p v-if="error" class="system-error">{{ error }}</p>
    <NSpin v-if="!snapshot && !error" />

    <template v-if="snapshot">
      <section class="system-grid">
        <article class="system-card" data-theme-surface="card" data-testid="system-cpu">
          <header class="system-card-head">
            <h3>{{ t('system.cpu') }}</h3>
            <strong class="system-value">{{ percent(snapshot.cpu.percent) }}</strong>
          </header>
          <span class="system-muted">{{ snapshot.host.cpuModel }}</span>
          <SparkLine :values="cpuHistory" :max="100" :label="t('system.cpuHistory')" :format="percent" :interval-seconds="INTERVAL_SECONDS" />
          <ul class="system-cores">
            <li v-for="(load, index) in snapshot.cpu.cores" :key="index" :title="`${t('system.core', { n: index })}: ${percent(load)}`">
              <span class="system-core-label">{{ index }}</span>
              <svg class="system-meter" viewBox="0 0 100 6" preserveAspectRatio="none" aria-hidden="true">
                <rect class="system-meter-track" width="100" height="6" rx="3" />
                <rect class="system-meter-fill" :width="clamp(load)" height="6" rx="3" />
              </svg>
              <span class="system-core-value">{{ Math.round(load) }}</span>
            </li>
          </ul>
        </article>

        <article class="system-card" data-theme-surface="card" data-testid="system-memory">
          <header class="system-card-head">
            <h3>{{ t('system.memory') }}</h3>
            <strong class="system-value">{{ percent(memoryPercent) }}</strong>
          </header>
          <span class="system-muted">{{ formatBytes(snapshot.memory.usedBytes) }} / {{ formatBytes(snapshot.memory.totalBytes) }}</span>
          <svg class="system-meter system-meter-wide" viewBox="0 0 100 6" preserveAspectRatio="none" aria-hidden="true">
            <rect class="system-meter-track" width="100" height="6" rx="3" />
            <rect class="system-meter-fill" :width="clamp(memoryPercent)" height="6" rx="3" />
          </svg>
          <template v-if="snapshot.memory.swapTotalBytes">
            <span class="system-muted">{{ t('system.swap') }} {{ formatBytes(snapshot.memory.swapUsedBytes) }} / {{ formatBytes(snapshot.memory.swapTotalBytes) }}</span>
            <svg class="system-meter system-meter-wide" viewBox="0 0 100 6" preserveAspectRatio="none" aria-hidden="true">
              <rect class="system-meter-track" width="100" height="6" rx="3" />
              <rect class="system-meter-fill" :width="clamp(swapPercent)" height="6" rx="3" />
            </svg>
          </template>
          <h3 class="system-subhead">{{ t('system.disks') }}</h3>
          <ul class="system-list">
            <li v-for="disk in snapshot.disks" :key="disk.fs + disk.mount">
              <span class="system-row">
                <span class="system-name">{{ disk.mount }}</span>
                <span class="system-muted">{{ formatBytes(disk.usedBytes) }} / {{ formatBytes(disk.sizeBytes) }}</span>
              </span>
              <svg class="system-meter system-meter-wide" viewBox="0 0 100 6" preserveAspectRatio="none" aria-hidden="true">
                <rect class="system-meter-track" width="100" height="6" rx="3" />
                <rect class="system-meter-fill" :width="clamp(disk.percent)" height="6" rx="3" />
              </svg>
            </li>
          </ul>
        </article>

        <article class="system-card" data-theme-surface="card" data-testid="system-network">
          <header class="system-card-head">
            <h3>{{ t('system.network') }}</h3>
          </header>
          <span class="system-row"><span>{{ t('system.received') }}</span><strong class="system-value-sm">{{ formatRate(totals.rx) }}</strong></span>
          <SparkLine :values="rxHistory" :label="t('system.received')" :format="formatRate" :interval-seconds="INTERVAL_SECONDS" />
          <span class="system-row"><span>{{ t('system.sent') }}</span><strong class="system-value-sm">{{ formatRate(totals.tx) }}</strong></span>
          <SparkLine :values="txHistory" :label="t('system.sent')" :format="formatRate" :interval-seconds="INTERVAL_SECONDS" />
          <ul class="system-list">
            <li v-for="iface in snapshot.network" :key="iface.iface" class="system-row">
              <span class="system-name">{{ iface.iface }}</span>
              <span class="system-muted">↓ {{ formatRate(iface.rxBytesPerSec) }} · ↑ {{ formatRate(iface.txBytesPerSec) }}</span>
            </li>
          </ul>
        </article>
      </section>

      <section class="system-card" data-theme-surface="card" data-testid="system-processes">
        <header class="system-card-head">
          <h3>{{ t('system.processes') }}</h3>
          <span class="system-muted">{{ t('system.processCount', { total: snapshot.processes.total, running: snapshot.processes.running }) }}</span>
          <NInput v-model:value="filter" size="small" clearable class="system-filter" :placeholder="t('system.filter')" data-testid="system-filter" />
        </header>
        <div class="system-table-wrap">
          <table class="system-table">
            <thead>
              <tr>
                <th class="system-num"><button type="button" @click="sortBy('pid')">PID{{ sortMark('pid') }}</button></th>
                <th class="system-col-name"><button type="button" @click="sortBy('name')">{{ t('system.name') }}{{ sortMark('name') }}</button></th>
                <th>{{ t('system.user') }}</th>
                <th class="system-num"><button type="button" data-testid="system-sort-cpu" @click="sortBy('cpuPercent')">CPU{{ sortMark('cpuPercent') }}</button></th>
                <th class="system-num"><button type="button" data-testid="system-sort-mem" @click="sortBy('memRssBytes')">{{ t('system.mem') }}{{ sortMark('memRssBytes') }}</button></th>
                <th />
              </tr>
            </thead>
            <tbody>
              <tr v-for="process in visibleProcesses" :key="process.pid" :title="process.command" data-testid="system-process">
                <td class="system-num">{{ process.pid }}</td>
                <td class="system-col-name"><span class="system-name">{{ process.name }}</span></td>
                <td class="system-muted">{{ process.user }}</td>
                <td class="system-num">{{ process.cpuPercent.toFixed(1) }}</td>
                <td class="system-num">{{ formatBytes(process.memRssBytes) }}</td>
                <td class="system-actions">
                  <template v-if="process.pid !== snapshot.serverPid">
                    <NPopconfirm @positive-click="endProcess(process, 'SIGTERM')">
                      <template #trigger>
                        <NButton size="tiny" quaternary :loading="busy === `SIGTERM:${process.pid}`">{{ t('system.end') }}</NButton>
                      </template>
                      {{ t('system.endConfirm', { name: process.name, pid: process.pid }) }}
                    </NPopconfirm>
                    <NPopconfirm @positive-click="endProcess(process, 'SIGKILL')">
                      <template #trigger>
                        <NButton size="tiny" quaternary :loading="busy === `SIGKILL:${process.pid}`">{{ t('system.kill') }}</NButton>
                      </template>
                      {{ t('system.killConfirm', { name: process.name, pid: process.pid }) }}
                    </NPopconfirm>
                  </template>
                  <span v-else class="system-muted">{{ t('system.studio') }}</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-if="processes.length > VISIBLE_PROCESSES" class="system-muted">{{ t('system.moreProcesses', { n: processes.length - VISIBLE_PROCESSES }) }}</p>
      </section>

      <section class="system-card" data-theme-surface="card" data-testid="system-docker">
        <header class="system-card-head">
          <h3>Docker</h3>
          <span v-if="docker?.available" class="system-muted">{{ t('system.dockerVersion', { version: docker.version }) }}</span>
        </header>
        <p v-if="docker && !docker.available" class="system-muted">{{ docker.error || t('system.dockerUnavailable') }}</p>
        <p v-else-if="docker && !docker.containers.length" class="system-muted">{{ t('system.noContainers') }}</p>
        <ul class="system-list">
          <li v-for="container in docker?.containers ?? []" :key="container.id" class="system-container" data-testid="system-container">
            <div class="system-container-main">
              <span class="system-name">{{ container.name }}</span>
              <span class="system-state" :data-state="container.state">{{ container.state }}</span>
              <span class="system-muted">{{ container.image }}</span>
              <span class="system-muted">{{ container.status }}<template v-if="container.ports.length"> · {{ container.ports.join(', ') }}</template></span>
            </div>
            <div class="system-container-actions">
              <NButton v-if="container.state !== 'running'" size="tiny" :loading="busy === `start:${container.id}`" @click="containerAction(container, 'start')">{{ t('system.start') }}</NButton>
              <NButton v-else size="tiny" quaternary :loading="busy === `stop:${container.id}`" @click="containerAction(container, 'stop')">{{ t('system.stop') }}</NButton>
              <NButton size="tiny" quaternary :loading="busy === `restart:${container.id}`" @click="containerAction(container, 'restart')">{{ t('system.restart') }}</NButton>
              <NButton size="tiny" quaternary :loading="busy === `logs:${container.id}`" @click="showLogs(container)">{{ t('system.logs') }}</NButton>
            </div>
            <pre v-if="logsFor?.id === container.id" class="system-logs">{{ logs || '…' }}</pre>
          </li>
        </ul>
      </section>
    </template>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.system-view {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 12px;
  width: 100%;
  min-width: 0;
  height: 100%;
  min-height: 0;
  padding: 12px 16px 16px;
  overflow: auto;
  color: $text-primary;
}

.system-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
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

.system-bar {
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
}

.system-title {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 12px;
  min-width: 0;
}

.system-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 12px;
}

.system-card-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.system-card .system-subhead {
  margin-top: 6px;
}

.system-value {
  font-size: 20px;
  font-variant-numeric: tabular-nums;
}

.system-value-sm {
  font-variant-numeric: tabular-nums;
}

.system-muted {
  font-size: 12px;
  color: $text-muted;
  overflow-wrap: anywhere;
}

.system-error {
  margin: 0;
  color: $error;
}

.system-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
}

.system-name {
  overflow: hidden;
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.system-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.system-meter {
  display: block;
  width: 100%;
  height: 6px;
}

.system-meter-track {
  fill: $border-light;
}

.system-meter-fill {
  fill: $accent-primary;
}

.system-cores {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(96px, 1fr));
  gap: 4px 12px;
  margin: 0;
  padding: 0;
  list-style: none;

  li {
    display: grid;
    grid-template-columns: 18px 1fr 24px;
    align-items: center;
    gap: 4px;
  }
}

.system-core-label,
.system-core-value {
  font-size: 11px;
  color: $text-muted;
  font-variant-numeric: tabular-nums;
}

.system-core-value {
  text-align: right;
}

.system-filter {
  max-width: 240px;
}

.system-table-wrap {
  max-height: 480px;
  overflow: auto;
}

.system-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;

  th, td {
    padding: 4px 6px;
    text-align: left;
    white-space: nowrap;
    border-bottom: var(--border-width, 1px) solid $border-light;
  }

  th {
    color: $text-secondary;
    font-weight: 600;
  }

  th button {
    padding: 0;
    color: $text-secondary;
    font: inherit;
    font-weight: 600;
    background: none;
    border: none;
    cursor: pointer;
  }
}

.system-table .system-num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.system-col-name {
  max-width: 260px;
}

.system-table .system-actions {
  text-align: right;
}

.system-container {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 4px 12px;
  padding-bottom: 6px;
  border-bottom: var(--border-width, 1px) solid $border-light;
}

.system-container-main {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 2px 10px;
  min-width: 0;
}

.system-state {
  font-size: 12px;
  color: $text-secondary;

  &[data-state="running"] {
    color: $success;
  }
}

.system-container-actions {
  display: flex;
  gap: 2px;
}

.system-logs {
  flex-basis: 100%;
  max-height: 280px;
  margin: 0;
  overflow: auto;
  font-family: $font-code;
  font-size: 12px;
  white-space: pre-wrap;
}

@media (max-width: $breakpoint-mobile) {
  .system-view {
    padding: 8px;
  }

  .system-col-name {
    max-width: 140px;
  }
}
</style>
