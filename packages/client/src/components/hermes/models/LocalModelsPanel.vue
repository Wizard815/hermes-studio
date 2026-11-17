<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { NButton, NInput, NProgress, NSpin, NTag, useDialog, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import {
  activateLocalModel, deleteLocalModel, downloadBrowsedModel, downloadLocalModel, ejectLocalModel,
  formatBytes, formatEta, getLocalCatalog, getLocalHardware, getLocalJobs, getLocalStatus, hasActiveJob,
  installLocalRuntime, listHuggingFaceFiles, localQuickstart, pauseLocalJob, resumeLocalJob, searchHuggingFace,
  setLocalServer, sideloadLocalModel, syncLocalProvider, getLocalProvider, visibleJobs,
  type HfFileGroup, type LocalProviderInfo, type HfModelHit, type LocalCatalogModel, type LocalHardware, type LocalJob, type LocalModelsStatus,
} from '@/api/hermes/local-models'

const props = defineProps<{ profile?: string }>()
const emit = defineEmits<{ changed: [] }>()
const { t } = useI18n()
const message = useMessage()
const dialog = useDialog()

const status = ref<LocalModelsStatus | null>(null)
/** Studio's `custom:hermes-local` gateway Provider for these models. */
const localProvider = ref<LocalProviderInfo | null>(null)
/** A model being loaded to become the profile's default once its job finishes. */
const pendingDefault = new Map<string, string>()
const hardware = ref<LocalHardware | null>(null)
const catalog = ref<LocalCatalogModel[]>([])
const jobs = ref<LocalJob[]>([])
const loading = ref(false)
const loadError = ref('')
const busy = ref<string | null>(null)

const query = ref('')
const searching = ref(false)
const hits = ref<HfModelHit[] | null>(null)
const openRepo = ref('')
const repoFiles = ref<HfFileGroup[] | null>(null)
const filesLoading = ref(false)
const sideloadPath = ref('')

let pollTimer: ReturnType<typeof setTimeout> | null = null
let alive = true

const shownJobs = computed(() => visibleJobs(jobs.value))
const engineLabel = computed(() => status.value?.runtime_installed
  ? t('hermesModels.engineInstalled', { tag: status.value.tag || '', backend: status.value.runtime_backend || '' })
  : t('hermesModels.engineNotInstalled'))

function fail(err: any) { message.error(err?.message || String(err)) }

async function loadAll() {
  loading.value = true
  loadError.value = ''
  try {
    const [s, h, c, j] = await Promise.all([
      getLocalStatus(props.profile), getLocalHardware(props.profile), getLocalCatalog(props.profile), getLocalJobs(props.profile),
    ])
    status.value = s
    hardware.value = h
    catalog.value = c.models
    jobs.value = j.jobs
    schedulePoll()
    void refreshProvider()
  } catch (err: any) {
    loadError.value = t('hermesModels.loadFailed', { error: err?.message || String(err) })
  } finally {
    loading.value = false
  }
}

// Keep the gateway Provider's model list in step with the downloaded models
// (this also moves a profile Hermes had set to its own `llamacpp` onto it).
async function refreshProvider(defaultModel?: string) {
  try {
    localProvider.value = await syncLocalProvider(props.profile, defaultModel)
  } catch (err) {
    if (defaultModel) throw err
    try { localProvider.value = await getLocalProvider(props.profile) } catch { /* not available */ }
  }
}

async function refreshState() {
  const [s, c] = await Promise.all([getLocalStatus(props.profile), getLocalCatalog(props.profile)])
  status.value = s
  catalog.value = c.models
}

function schedulePoll() {
  if (pollTimer || !alive || !hasActiveJob(jobs.value)) return
  pollTimer = setTimeout(async () => {
    pollTimer = null
    try {
      const before = new Set(jobs.value.filter(job => job.status === 'running').map(job => job.job_id))
      jobs.value = (await getLocalJobs(props.profile)).jobs
      const finished = jobs.value.filter(job => before.has(job.job_id) && job.status !== 'running')
      if (finished.length) {
        for (const job of finished) {
          if (job.status === 'error') message.error(`${job.target}: ${job.error || t('hermesModels.failed')}`)
          else if (job.status === 'done') message.success(job.detail || t('hermesModels.done'))
        }
        await refreshState()
        let madeDefault = false
        for (const job of finished) {
          const model = pendingDefault.get(job.job_id)
          pendingDefault.delete(job.job_id)
          if (model && job.status === 'done') { madeDefault = true; await refreshProvider(model).catch(fail) }
        }
        if (!madeDefault) await refreshProvider()
        emit('changed')
      }
    } catch { /* try again next tick */ }
    schedulePoll()
  }, 1500)
}

async function trackJob(start: () => Promise<{ job_id?: string | null; already_downloaded?: boolean } | unknown>, key: string, makeDefault?: string) {
  busy.value = key
  try {
    const result = await start() as { job_id?: string | null; already_downloaded?: boolean }
    if (makeDefault) {
      if (result?.job_id) pendingDefault.set(result.job_id, makeDefault)
      else { await refreshProvider(makeDefault); emit('changed') }
    }
    if (result?.already_downloaded) message.info(t('hermesModels.alreadyDownloaded'))
    else message.success(t('hermesModels.started'))
    jobs.value = (await getLocalJobs(props.profile)).jobs
    schedulePoll()
  } catch (err) {
    fail(err)
  } finally {
    busy.value = null
  }
}

async function act(key: string, run: () => Promise<unknown>) {
  busy.value = key
  try {
    await run()
    await refreshState()
    await refreshProvider()
    emit('changed')
  } catch (err) {
    fail(err)
  } finally {
    busy.value = null
  }
}

const installEngine = () => trackJob(() => installLocalRuntime(props.profile), 'engine')
const quickstart = () => trackJob(() => localQuickstart(props.profile), 'quickstart')
const download = (model: LocalCatalogModel) => trackJob(() => downloadLocalModel(model.id, props.profile), `dl:${model.id}`)
// Hermes loads the model into its llama.cpp server; then Studio makes it the
// profile's default model through its model gateway Provider `custom:hermes-local`,
// so new chats, Hermes runs, herdr panes and jobs all use it the same way.
const activate = (id: string) => trackJob(() => activateLocalModel(id, props.profile), `act:${id}`, id)
const isProfileDefault = (id: string | null | undefined) => !!id && localProvider.value?.default_model === id
const profileName = computed(() => props.profile || 'default')
const eject = (id: string) => act(`ej:${id}`, () => ejectLocalModel(id, props.profile))

function toggleServer() {
  if (!status.value) return
  if (!status.value.server_running) { void act('server', () => setLocalServer('start', props.profile)); return }
  dialog.warning({
    title: t('hermesModels.stopServer'),
    content: t('hermesModels.stopServerConfirm'),
    positiveText: t('hermesModels.stopServer'),
    negativeText: t('hermesModels.cancel'),
    onPositiveClick: () => { void act('server', () => setLocalServer('stop', props.profile)) },
  })
}

function remove(id: string) {
  dialog.warning({
    title: t('hermesModels.delete'),
    content: t('hermesModels.deleteConfirm', { model: id }),
    positiveText: t('hermesModels.delete'),
    negativeText: t('hermesModels.cancel'),
    onPositiveClick: () => { void act(`del:${id}`, () => deleteLocalModel(id, props.profile)) },
  })
}

async function pause(job: LocalJob) {
  try { await pauseLocalJob(job.job_id, props.profile); jobs.value = (await getLocalJobs(props.profile)).jobs; schedulePoll() } catch (err) { fail(err) }
}
async function resume(job: LocalJob) {
  try { await resumeLocalJob(job.job_id, props.profile); jobs.value = (await getLocalJobs(props.profile)).jobs; schedulePoll() } catch (err) { fail(err) }
}

async function search() {
  const q = query.value.trim()
  if (!q) return
  searching.value = true
  openRepo.value = ''
  repoFiles.value = null
  try { hits.value = (await searchHuggingFace(q, props.profile)).hits } catch (err) { fail(err) } finally { searching.value = false }
}

async function toggleRepo(repo: string) {
  if (openRepo.value === repo) { openRepo.value = ''; repoFiles.value = null; return }
  openRepo.value = repo
  repoFiles.value = null
  filesLoading.value = true
  try { repoFiles.value = (await listHuggingFaceFiles(repo, props.profile)).files } catch (err) { fail(err); openRepo.value = '' } finally { filesLoading.value = false }
}

const downloadFile = (repo: string, group: HfFileGroup) => trackJob(() => downloadBrowsedModel(repo, group.paths, props.profile), `hf:${repo}:${group.label}`)

async function sideload() {
  const path = sideloadPath.value.trim()
  if (!path) return
  await act('sideload', async () => {
    const result = await sideloadLocalModel(path, props.profile)
    message.success(result.already_present ? t('hermesModels.alreadyDownloaded') : t('hermesModels.sideloaded'))
    sideloadPath.value = ''
  })
}

function modelState(id: string): 'loaded' | 'loading' | null {
  const value = status.value?.loaded_models?.[id]
  if (value === 'loading') return 'loading'
  return value ? 'loaded' : null
}

function jobState(job: LocalJob) {
  if (job.status === 'paused') return t('hermesModels.paused')
  if (job.status === 'error') return t('hermesModels.failed')
  if (job.status === 'done') return t('hermesModels.done')
  return ''
}

function jobProgressText(job: LocalJob) {
  const parts: string[] = []
  if (job.total_bytes) parts.push(`${formatBytes(job.done_bytes)} / ${formatBytes(job.total_bytes)}`)
  if (job.bytes_per_sec) parts.push(`${formatBytes(job.bytes_per_sec)}/s`)
  const eta = formatEta(job.eta_seconds)
  if (eta) parts.push(t('hermesModels.eta', { eta }))
  return parts.join(' · ')
}

watch(() => props.profile, () => { void loadAll() })
onMounted(loadAll)
onUnmounted(() => { alive = false; if (pollTimer) clearTimeout(pollTimer) })
</script>

<template>
  <section class="local-models">
    <header class="lm-header">
      <div>
        <h3>{{ t('hermesModels.localTitle') }}</h3>
        <p>{{ t('hermesModels.localDesc') }}</p>
      </div>
      <NButton size="small" :loading="loading" @click="loadAll">{{ t('hermesModels.refresh') }}</NButton>
    </header>

    <p v-if="loadError" class="lm-error" role="alert">{{ loadError }}</p>

    <NSpin :show="loading && !status">
      <template v-if="status">
        <div class="lm-summary">
          <div v-if="hardware" class="lm-card">
            <h4>{{ t('hermesModels.hardware') }}</h4>
            <p v-if="hardware.gpu_name" class="lm-strong">{{ hardware.gpu_name }}</p>
            <p>{{ t('hermesModels.gpuMemory') }}: <strong>{{ hardware.vram_label }}</strong>
              ({{ formatBytes(hardware.vram_usable_bytes) }} {{ t('hermesModels.usableGpu') }})</p>
            <p>{{ t('hermesModels.systemMemory') }}: <strong>{{ formatBytes(hardware.ram_total_bytes) }}</strong>
              ({{ formatBytes(hardware.ram_available_bytes) }} {{ t('hermesModels.available') }})</p>
            <p v-if="hardware.uma" class="lm-muted">{{ t('hermesModels.sharedMemory') }}</p>
            <p v-if="hardware.gpu_util_percent !== null">{{ t('hermesModels.gpuUse') }}: {{ hardware.gpu_util_percent }}%</p>
          </div>
          <div class="lm-card">
            <h4>{{ t('hermesModels.engine') }}</h4>
            <p>{{ engineLabel }}</p>
            <p v-if="status.runtime_installed">
              <NTag size="small" :type="status.server_running ? 'success' : 'default'" round>
                {{ status.server_running ? t('hermesModels.serverRunning') : t('hermesModels.serverStopped') }}
              </NTag>
            </p>
            <div class="lm-actions">
              <NButton v-if="!status.runtime_installed || status.update_available" size="small" type="primary"
                :loading="busy === 'engine'" @click="installEngine">
                {{ status.runtime_installed ? t('hermesModels.updateEngine') : t('hermesModels.installEngine') }}
              </NButton>
              <NButton v-if="status.runtime_installed" size="small" :loading="busy === 'server'" @click="toggleServer">
                {{ status.server_running ? t('hermesModels.stopServer') : t('hermesModels.startServer') }}
              </NButton>
            </div>
          </div>
        </div>

        <div v-if="status.models.length === 0" class="lm-quickstart">
          <p>{{ t('hermesModels.quickstartHint') }}</p>
          <NButton size="small" type="primary" :loading="busy === 'quickstart'" @click="quickstart">{{ t('hermesModels.quickstart') }}</NButton>
        </div>

        <section v-if="shownJobs.length" class="lm-section" aria-live="polite">
          <h4>{{ t('hermesModels.jobs') }}</h4>
          <ul class="lm-list">
            <li v-for="job in shownJobs" :key="job.job_id" class="lm-row lm-job">
              <div class="lm-row-main">
                <strong dir="auto">{{ job.target }}</strong>
                <small>{{ job.status === 'error' ? job.error : job.detail }}<template v-if="jobState(job)"> · {{ jobState(job) }}</template></small>
                <NProgress v-if="job.status === 'running' || job.status === 'paused'" type="line" :percentage="job.percent ?? 0"
                  :show-indicator="false" :processing="job.status === 'running'" :height="6" />
                <small v-if="jobProgressText(job)" class="lm-muted">{{ jobProgressText(job) }}</small>
              </div>
              <NButton v-if="job.can_pause" size="tiny" @click="pause(job)">{{ t('hermesModels.pause') }}</NButton>
              <NButton v-if="job.can_resume" size="tiny" type="primary" @click="resume(job)">{{ t('hermesModels.resume') }}</NButton>
            </li>
          </ul>
        </section>

        <section class="lm-section">
          <h4>{{ t('hermesModels.myModels') }}</h4>
          <p v-if="status.models.length === 0" class="lm-muted">{{ t('hermesModels.noModels') }}</p>
          <ul v-else class="lm-list">
            <li v-for="model in status.models" :key="model.id" class="lm-row">
              <div class="lm-row-main">
                <strong dir="auto">{{ model.id }}</strong>
                <small>{{ model.size_label }}</small>
              </div>
              <NTag v-if="isProfileDefault(model.id)" size="small" type="success" round>{{ t('hermesModels.profileDefault', { profile: profileName }) }}</NTag>
              <NTag v-if="modelState(model.id)" size="small" type="info" round>
                {{ modelState(model.id) === 'loading' ? t('hermesModels.loading') : t('hermesModels.loaded') }}
              </NTag>
              <NButton v-if="!isProfileDefault(model.id)" size="tiny" :loading="busy === `act:${model.id}`" @click="activate(model.id)">
                {{ t('hermesModels.makeProfileDefault', { profile: profileName }) }}
              </NButton>
              <NButton v-if="modelState(model.id) === 'loaded'" size="tiny" :loading="busy === `ej:${model.id}`" @click="eject(model.id)">
                {{ t('hermesModels.eject') }}
              </NButton>
              <NButton size="tiny" quaternary type="error" :loading="busy === `del:${model.id}`" @click="remove(model.id)">
                {{ t('hermesModels.delete') }}
              </NButton>
            </li>
          </ul>
        </section>

        <section class="lm-section">
          <h4>{{ t('hermesModels.catalog') }}</h4>
          <ul class="lm-list">
            <li v-for="model in catalog" :key="model.id" class="lm-row">
              <div class="lm-row-main">
                <strong dir="auto">{{ model.display_name }}
                  <NTag v-if="model.recommended" size="tiny" type="success" round>{{ t('hermesModels.recommended') }}</NTag>
                  <NTag v-if="model.vision" size="tiny" round>{{ t('hermesModels.vision') }}</NTag>
                  <NTag v-if="model.downloaded" size="tiny" type="info" round>{{ t('hermesModels.downloaded') }}</NTag>
                </strong>
                <small>{{ model.description }}</small>
                <small class="lm-muted">{{ t('hermesModels.contextLabel', { size: model.size_label, context: model.native_context_label }) }} · {{ model.fit_summary }}</small>
                <small v-if="model.needs_engine" class="lm-warn">{{ t('hermesModels.needsEngine', { version: model.min_engine || '' }) }}</small>
              </div>
              <NButton v-if="model.downloaded && model.downloaded_model_id && !isProfileDefault(model.downloaded_model_id)" size="tiny"
                :loading="busy === `act:${model.downloaded_model_id}`" @click="activate(model.downloaded_model_id)">
                {{ t('hermesModels.makeProfileDefault', { profile: profileName }) }}
              </NButton>
              <NButton v-else-if="!model.downloaded" size="tiny" type="primary" :disabled="!model.fits || model.needs_engine"
                :title="model.fits ? undefined : model.fit_detail" :loading="busy === `dl:${model.id}`" @click="download(model)">
                {{ t('hermesModels.download') }}
              </NButton>
            </li>
          </ul>
        </section>

        <section class="lm-section">
          <h4>{{ t('hermesModels.browse') }}</h4>
          <form class="lm-inline" @submit.prevent="search">
            <NInput v-model:value="query" size="small" :placeholder="t('hermesModels.searchPlaceholder')" clearable />
            <NButton size="small" attr-type="submit" :loading="searching" :disabled="!query.trim()">{{ t('hermesModels.search') }}</NButton>
          </form>
          <p v-if="hits && hits.length === 0" class="lm-muted">{{ t('hermesModels.noHits') }}</p>
          <ul v-else-if="hits" class="lm-list">
            <li v-for="hit in hits" :key="hit.repo" class="lm-hit">
              <button type="button" class="lm-row lm-row-button" :aria-expanded="openRepo === hit.repo" @click="toggleRepo(hit.repo)">
                <span class="lm-row-main">
                  <strong dir="ltr">{{ hit.repo }}</strong>
                  <small>{{ t('hermesModels.downloadsLikes', { downloads: hit.downloads.toLocaleString(), likes: hit.likes.toLocaleString() }) }}<template v-if="hit.gated"> · {{ t('hermesModels.gated') }}</template></small>
                </span>
                <span aria-hidden="true">{{ openRepo === hit.repo ? '▾' : '▸' }}</span>
              </button>
              <NSpin v-if="openRepo === hit.repo" :show="filesLoading" size="small">
                <p v-if="repoFiles && repoFiles.length === 0" class="lm-muted lm-files">{{ t('hermesModels.noFiles') }}</p>
                <ul v-else-if="repoFiles" class="lm-list lm-files">
                  <li v-for="group in repoFiles" :key="group.label" class="lm-row">
                    <div class="lm-row-main">
                      <strong dir="ltr">{{ group.label }}</strong>
                      <small>{{ formatBytes(group.total_bytes) }} · {{ t(`hermesModels.fit_${['fits-gpu', 'needs-ram', 'too-big'].includes(group.fit) ? group.fit : 'unknown'}`) }}</small>
                    </div>
                    <NButton size="tiny" :type="group.fit === 'fits-gpu' ? 'primary' : 'default'" :disabled="group.fit === 'too-big'"
                      :loading="busy === `hf:${hit.repo}:${group.label}`" @click="downloadFile(hit.repo, group)">
                      {{ t('hermesModels.download') }}
                    </NButton>
                  </li>
                </ul>
              </NSpin>
            </li>
          </ul>
        </section>

        <section class="lm-section">
          <h4>{{ t('hermesModels.sideload') }}</h4>
          <form class="lm-inline" @submit.prevent="sideload">
            <NInput v-model:value="sideloadPath" size="small" :placeholder="t('hermesModels.sideloadPlaceholder')" />
            <NButton size="small" attr-type="submit" :loading="busy === 'sideload'" :disabled="!sideloadPath.trim()">{{ t('hermesModels.add') }}</NButton>
          </form>
          <p class="lm-muted lm-path" dir="ltr">{{ status.models_dir }}</p>
        </section>
      </template>
    </NSpin>
  </section>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.local-models { padding: calc(4px * var(--spacing-scale, 1)) 0; display: flex; flex-direction: column; gap: calc(16px * var(--spacing-scale, 1)); }

.lm-header {
  display: flex; align-items: flex-start; justify-content: space-between; gap: calc(16px * var(--spacing-scale, 1));
  h3 { margin: 0 0 4px; font-size: calc(var(--font-size-base, 14px) * 15 / 14); color: $text-primary; }
  p { margin: 0; font-size: calc(var(--font-size-base, 14px) * 12 / 14); color: $text-secondary; }
}

.lm-summary { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 320px), 1fr)); gap: calc(12px * var(--spacing-scale, 1)); }

.lm-card {
  padding: calc(12px * var(--spacing-scale, 1));
  background: $bg-secondary; border: var(--border-width, 1px) solid $border-color; border-radius: $radius-sm;
  h4 { margin: 0 0 6px; font-size: calc(var(--font-size-base, 14px) * 13 / 14); color: $text-primary; }
  p { margin: 0 0 4px; font-size: calc(var(--font-size-base, 14px) * 12 / 14); color: $text-secondary; }
}

.lm-strong { color: $text-primary !important; }
.lm-actions { display: flex; gap: calc(8px * var(--spacing-scale, 1)); flex-wrap: wrap; margin-top: 8px; }

.lm-quickstart {
  display: flex; align-items: center; justify-content: space-between; gap: calc(12px * var(--spacing-scale, 1));
  padding: calc(12px * var(--spacing-scale, 1)); border: var(--border-width, 1px) dashed $border-color; border-radius: $radius-sm;
  p { margin: 0; font-size: calc(var(--font-size-base, 14px) * 12 / 14); color: $text-secondary; }
}

.lm-section h4 { margin: 0 0 8px; font-size: calc(var(--font-size-base, 14px) * 13 / 14); color: $text-primary; }

.lm-list { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: calc(6px * var(--spacing-scale, 1)); }

.lm-row {
  display: flex; align-items: center; gap: calc(10px * var(--spacing-scale, 1));
  padding: calc(10px * var(--spacing-scale, 1)) calc(12px * var(--spacing-scale, 1));
  background: $bg-secondary; border: var(--border-width, 1px) solid $border-color; border-radius: $radius-sm;
}

.lm-row-button { width: 100%; text-align: start; font: inherit; color: inherit; cursor: pointer; }
.lm-row-button:focus-visible { outline: 2px solid $accent-muted; outline-offset: 1px; }

.lm-row-main {
  flex: 1; min-width: 0; display: flex; flex-direction: column; gap: calc(3px * var(--spacing-scale, 1));
  strong { font-size: calc(var(--font-size-base, 14px) * 13 / 14); font-weight: 500; color: $text-primary; overflow-wrap: anywhere; display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  small { font-size: calc(var(--font-size-base, 14px) * 11 / 14); color: $text-secondary; overflow-wrap: anywhere; }
}

.lm-files { margin: 6px 0 0 calc(16px * var(--spacing-scale, 1)); }
.lm-inline { display: flex; gap: calc(8px * var(--spacing-scale, 1)); margin-bottom: 8px; }
.lm-muted { color: $text-muted !important; font-size: calc(var(--font-size-base, 14px) * 11 / 14); margin: 0; }
.lm-warn { color: var(--warning-color, #d97706) !important; }
.lm-path { margin-top: 4px; overflow-wrap: anywhere; }
.lm-error { margin: 0; color: var(--error-color, #d03050); font-size: calc(var(--font-size-base, 14px) * 12 / 14); }

@media (max-width: 640px) {
  .lm-row { flex-wrap: wrap; }
  .lm-quickstart { flex-direction: column; align-items: flex-start; }
}
</style>
