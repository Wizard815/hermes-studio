<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { NButton, NInput, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useOrbConnection } from '../useMission'
import { callOrbTool, fetchOrbData, fetchOrbStatus, saveOrbSettings, type OrbChore, type OrbStatus, type OrbTask } from '@/api/studio/orb'
import { useHerdrStore } from '@/stores/hermes/herdr'
import { studioUrl } from '../useMission'

/**
 * The control page: the Pondering Orb connection, then one glance at upkeep,
 * uptime, hosts, chores and plans from Orb, and herdr's own health.
 */
const { t } = useI18n()
const toast = useMessage()
/** Saving an address here opens Mission's Orb sources. */
const orbConnection = useOrbConnection()
const herdr = useHerdrStore()
const orb = ref<OrbStatus | null>(null)
const url = ref('')
const token = ref('')
const saving = ref(false)
const monitors = ref<Array<{ name: string; status: string; group?: string }>>([])
const hosts = ref<any[]>([])
const requests = ref<any[]>([])
const chores = ref<OrbChore[]>([])
const tasks = ref<OrbTask[]>([])
const problems = ref<string[]>([])

const agentCounts = computed(() => {
  const counts = { working: 0, blocked: 0, done: 0, idle: 0 }
  for (const pane of herdr.bridge?.panes || []) {
    const status = pane.agent_status
    if (pane.agent && status && status in counts) counts[status as keyof typeof counts] += 1
  }
  return counts
})
const down = computed(() => monitors.value.filter(m => m.status === 'down'))
const overdue = computed(() => chores.value.filter(c => (c.daysLeft ?? 0) < 0))
const openTasks = computed(() => tasks.value.filter(task => !task.done))
const settingsHref = studioUrl('/herdr?tab=settings')

function percent(value: unknown): string {
  const n = Number(value)
  return Number.isFinite(n) ? `${Math.round(n <= 1 ? n * 100 : n)}%` : '—'
}

async function load() {
  try {
    orb.value = await fetchOrbStatus()
    url.value = orb.value.settings.url
  } catch (err: any) {
    problems.value = [err?.message || String(err)]
    return
  }
  if (!orb.value.connected) { problems.value = orb.value.error ? [orb.value.error] : []; return }
  const errs: string[] = []
  const settle = async <T,>(label: string, fn: () => Promise<T>, apply: (value: T) => void) => {
    try { apply(await fn()) } catch (err: any) { errs.push(`${label}: ${err?.message || err}`) }
  }
  await Promise.all([
    settle(t('mission.uptime'), () => fetchOrbData<{ monitors: any[] }>('uptime'), v => { monitors.value = v?.monitors || [] }),
    settle(t('mission.hosts'), () => fetchOrbData<{ hosts: any[] }>('system'), v => { hosts.value = v?.hosts || [] }),
    settle(t('mission.upkeepRequests'), () => fetchOrbData<any[]>('upkeep-requests'), v => { requests.value = Array.isArray(v) ? v : [] }),
    settle(t('mission.chores'), () => callOrbTool<OrbChore[]>('orb_list_chores'), v => { chores.value = v || [] }),
    settle(t('mission.tasks'), () => callOrbTool<OrbTask[]>('orb_list_tasks', {}), v => { tasks.value = v || [] }),
  ])
  problems.value = errs
}

async function save() {
  saving.value = true
  try {
    await saveOrbSettings({ url: url.value.trim(), ...(token.value.trim() ? { token: token.value.trim() } : {}) })
    token.value = ''
    await Promise.all([load(), orbConnection.refresh()])
    toast.success(orb.value?.connected ? t('mission.orbConnected') : t('mission.orbSaved'))
  } catch (err: any) {
    toast.error(err?.message || String(err))
  } finally {
    saving.value = false
  }
}

onMounted(load)
</script>

<template>
  <section class="source" data-testid="mission-control-panel">
    <div class="control-grid">
      <article class="source-card" data-theme-surface="card">
        <h4 class="control-title">Pondering Orb</h4>
        <div class="source-card-meta">
          <span class="source-chip" :class="orb?.connected ? 'is-good' : 'is-warn'">{{ orb?.connected ? t('mission.connected', { version: orb.version }) : t('mission.notConnected') }}</span>
        </div>
        <template v-if="!orb?.settings.fromEnv">
          <NInput v-model:value="url" size="small" placeholder="http://pondering-orb:8080" data-testid="mission-orb-url" />
          <NInput v-model:value="token" size="small" type="password" :placeholder="orb?.settings.hasToken ? t('mission.tokenKept') : t('mission.orbToken')" />
          <NButton size="small" type="primary" :loading="saving" data-testid="mission-orb-save" @click="save">{{ t('mission.connect') }}</NButton>
        </template>
        <p v-else class="source-card-meta">{{ t('mission.orbFromEnv') }}</p>
        <p class="source-card-meta">{{ t('mission.orbHint') }}</p>
      </article>

      <article class="source-card" data-theme-surface="card">
        <h4 class="control-title">herdr</h4>
        <div class="source-card-meta">
          <span class="source-chip" :class="herdr.connected ? 'is-good' : 'is-warn'">{{ herdr.connected ? t('herdr.connected') : t('herdr.disconnected') }}</span>
          <span v-if="herdr.status?.version" class="source-chip">{{ herdr.status.version }}</span>
        </div>
        <div class="source-card-meta">
          <span class="source-chip is-warn">◐ {{ agentCounts.working }}</span>
          <span class="source-chip is-bad">× {{ agentCounts.blocked }}</span>
          <span class="source-chip">✓ {{ agentCounts.done }}</span>
          <span class="source-chip is-good">○ {{ agentCounts.idle }}</span>
        </div>
        <a v-if="settingsHref" class="source-link" :href="settingsHref">{{ t('mission.herdrSettings') }}</a>
      </article>

      <template v-if="orb?.connected">
        <article class="source-card" data-theme-surface="card">
          <h4 class="control-title">{{ t('mission.upkeep') }}</h4>
          <span class="control-figure">{{ requests.length }}</span>
          <span class="source-card-meta">{{ t('mission.requestsWaiting') }}</span>
          <span class="source-card-meta">{{ t('mission.overdueChores', { n: overdue.length }) }}</span>
        </article>
        <article class="source-card" data-theme-surface="card">
          <h4 class="control-title">{{ t('mission.tasks') }}</h4>
          <span class="control-figure">{{ openTasks.length }}</span>
          <span class="source-card-meta">{{ t('mission.openTasksLabel') }}</span>
        </article>
        <article class="source-card" data-theme-surface="card">
          <h4 class="control-title">{{ t('mission.uptime') }}</h4>
          <span class="control-figure">{{ monitors.length - down.length }}/{{ monitors.length }}</span>
          <span class="source-card-meta">{{ t('mission.monitorsUp') }}</span>
          <span v-for="monitor in down" :key="monitor.name" class="source-chip is-bad">{{ monitor.name }}</span>
        </article>
        <article v-for="host in hosts" :key="host.name" class="source-card" data-theme-surface="card">
          <h4 class="control-title">{{ host.name }}</h4>
          <div class="source-card-meta">
            <span v-if="host.cpu != null" class="source-chip">CPU {{ percent(host.cpu?.usage ?? host.cpu) }}</span>
            <span v-if="host.mem != null || host.memory != null" class="source-chip">{{ t('mission.memory') }} {{ percent((host.mem ?? host.memory)?.used / ((host.mem ?? host.memory)?.total || 1)) }}</span>
            <span class="source-chip">{{ t('mission.containers', { n: (host.containers || []).length }) }}</span>
          </div>
        </article>
      </template>
    </div>
    <p v-for="problem in problems" :key="problem" class="source-error">{{ problem }}</p>
  </section>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;
@use './source';

.control-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 10px;
  align-items: start;
}

.control-title {
  margin: 0;
  font-size: 13px;
}

.control-figure {
  font-size: 26px;
  font-weight: 600;
  line-height: 1.1;
}
</style>
