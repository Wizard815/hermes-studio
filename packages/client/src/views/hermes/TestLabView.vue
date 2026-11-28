<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { NButton, NCheckbox, NCollapse, NCollapseItem, NInput, NInputNumber, NModal, NPopconfirm, NSelect, NSpin, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import {
  fetchTestLab, fetchTestLabLog, fetchTestLabRun, fetchTestLabRuns, fetchTestLabScreenshot, fetchTestLabZip,
  removeTestLabRun, saveTestLabSettings, startTestLabRun, stopTestLabRun,
  type TestLabRun, type TestLabRunSummary, type TestLabSettings, type TestLabStatus,
} from '@/api/studio/test-lab'
import SandboxCard from '@/components/hermes/sandbox/SandboxCard.vue'
import SandboxNetworkCard from '@/components/hermes/sandbox/SandboxNetworkCard.vue'

/** Test Lab (docs/test-lab.md): throwaway app containers, one agent test, a report. Super admins only. */

const { t } = useI18n()
const toast = useMessage()

const status = ref<TestLabStatus | null>(null)
const loadError = ref('')
const runs = ref<TestLabRunSummary[]>([])
const selected = ref<TestLabRun | null>(null)
const busy = ref('')
const shots = ref<Record<string, string>>({})
const bigShot = ref('')
const logFor = ref('')
const logText = ref('')

const form = reactive({
  model: null as string | null,
  apps: [] as string[],
  instructions: '',
  capUsd: 0.5,
  minutes: 20,
  keepRunning: false,
  browser: true,
  builds: {} as Record<string, string>,
})
const settings = reactive<TestLabSettings>({ registryMirror: '', runnerImage: '', browserImage: '', defaultCapUsd: 0.5, defaultMinutes: 20, maxSteps: 40 })

let timer: ReturnType<typeof setTimeout> | null = null
let stopped = false

const modelOptions = computed(() => (status.value?.models ?? []).map(model => ({ label: model.id, value: model.id })))
const active = computed(() => !!selected.value && ['starting', 'running'].includes(selected.value.status))
const anyActive = computed(() => runs.value.some(run => ['starting', 'running'].includes(run.status)))
const missingBuild = computed(() => form.apps.filter(id => status.value?.templates.find(template => template.id === id)?.needsBuildUrl && !form.builds[id]?.trim()))
const canStart = computed(() => !!form.model && form.apps.length > 0 && !anyActive.value && busy.value === '')
const selectedSizeMb = computed(() => form.apps.reduce((sum, id) => sum + (status.value?.templates.find(template => template.id === id)?.sizeMb ?? 0), 0))

const money = (value: number | undefined) => value === undefined ? '—' : `$${value.toFixed(value < 0.1 ? 4 : 2)}`
const when = (at: number) => new Date(at).toLocaleString()

function statusText(run: { status: string; stopReason?: string }) {
  if (run.status === 'stopped' && run.stopReason) return t(`testLab.stopped.${run.stopReason}`)
  return t(`testLab.status.${run.status}`)
}

async function load() {
  try {
    status.value = await fetchTestLab()
    Object.assign(settings, status.value.settings)
    if (!form.model && status.value.models.length) form.model = status.value.models.find(model => /hy4-flash/.test(model.id))?.id ?? null
    form.capUsd = form.capUsd === 0.5 ? status.value.settings.defaultCapUsd : form.capUsd
    form.minutes = form.minutes === 20 ? status.value.settings.defaultMinutes : form.minutes
    loadError.value = ''
    if (status.value.docker.available) await loadRuns()
  } catch (error) {
    loadError.value = (error as Error).message
  }
}

async function loadRuns() {
  runs.value = (await fetchTestLabRuns()).runs
  if (!selected.value && runs.value[0]) await select(runs.value[0].id)
}

async function select(id: string) {
  for (const url of Object.values(shots.value)) URL.revokeObjectURL(url)
  shots.value = {}
  logFor.value = ''
  selected.value = await fetchTestLabRun(id)
  void loadShots()
}

async function loadShots() {
  const run = selected.value
  if (!run) return
  for (const name of run.screenshots) {
    if (shots.value[name]) continue
    try { shots.value = { ...shots.value, [name]: URL.createObjectURL(await fetchTestLabScreenshot(run.id, name)) } } catch { /* shown as missing */ }
  }
}

async function tick() {
  if (stopped) return
  try {
    if (selected.value && (active.value || selected.value.active)) {
      const before = selected.value.status
      selected.value = await fetchTestLabRun(selected.value.id)
      void loadShots()
      if (before !== selected.value.status) await loadRuns()
    } else if (anyActive.value) await loadRuns()
  } catch { /* try again */ }
  timer = setTimeout(tick, 2000)
}

async function start() {
  if (!form.model) return
  if (missingBuild.value.length) {
    toast.warning(t('testLab.needsBuildUrl', { apps: missingBuild.value.map(id => status.value?.templates.find(template => template.id === id)?.name).join(', ') }))
  }
  busy.value = 'start'
  try {
    const builds = Object.fromEntries(Object.entries(form.builds).filter(([id, url]) => form.apps.includes(id) && url.trim()).map(([id, url]) => [id, url.trim()]))
    const run = await startTestLabRun({ model: form.model, apps: form.apps, instructions: form.instructions, capUsd: form.capUsd, minutes: form.minutes, keepRunning: form.keepRunning, browser: form.browser, builds })
    toast.success(t('testLab.started'))
    selected.value = null
    await loadRuns()
    await select(run.id)
  } catch (error) {
    toast.error((error as Error).message)
  } finally { busy.value = '' }
}

async function stop() {
  if (!selected.value) return
  busy.value = 'stop'
  try { selected.value = await stopTestLabRun(selected.value.id); await loadRuns() } catch (error) { toast.error((error as Error).message) } finally { busy.value = '' }
}

async function remove() {
  if (!selected.value) return
  busy.value = 'remove'
  try { selected.value = await removeTestLabRun(selected.value.id); toast.success(t('testLab.removed')); await loadRuns() } catch (error) { toast.error((error as Error).message) } finally { busy.value = '' }
}

async function download() {
  if (!selected.value) return
  busy.value = 'zip'
  try {
    const blob = await fetchTestLabZip(selected.value.id)
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `test-lab-${selected.value.id}.zip`
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
  } catch (error) { toast.error((error as Error).message) } finally { busy.value = '' }
}

async function showLog(app: string) {
  if (!selected.value) return
  if (logFor.value === app) { logFor.value = ''; return }
  logFor.value = app
  logText.value = ''
  try { logText.value = await fetchTestLabLog(selected.value.id, app) } catch (error) { logText.value = (error as Error).message }
}

async function saveSettings() {
  busy.value = 'settings'
  try {
    Object.assign(settings, await saveTestLabSettings({ ...settings }))
    toast.success(t('testLab.settingsSaved'))
  } catch (error) { toast.error((error as Error).message) } finally { busy.value = '' }
}

watch(() => selected.value?.screenshots.length, () => { void loadShots() })

onMounted(async () => {
  await load()
  timer = setTimeout(tick, 2000)
})
onBeforeUnmount(() => {
  stopped = true
  if (timer) clearTimeout(timer)
  for (const url of Object.values(shots.value)) URL.revokeObjectURL(url)
})
</script>

<template>
  <div class="lab-view" data-testid="test-lab-view">
    <header class="lab-card lab-bar" data-theme-surface="card">
      <div class="lab-title">
        <h2>{{ t('testLab.title') }}</h2>
        <span class="lab-muted">{{ t('testLab.subtitle') }}</span>
      </div>
      <span v-if="status?.docker.available" class="lab-muted">{{ t('testLab.dockerVersion', { version: status.docker.version || '?' }) }}</span>
    </header>

    <p v-if="loadError" class="lab-error" role="alert">{{ t('testLab.loadFailed', { error: loadError }) }}</p>
    <div v-else-if="!status" class="lab-loading"><NSpin size="small" /></div>

    <section v-else-if="!status.docker.available" class="lab-card" data-theme-surface="card" data-testid="test-lab-requirements">
      <h3>{{ t('testLab.requirements.title') }}</h3>
      <p>{{ t('testLab.requirements.what') }}</p>
      <pre class="lab-code">environment:
  - STUDIO_SANDBOX_DOCKER_HOST=unix:///run/sandbox-docker/docker.sock
volumes:
  - sandbox-docker:/run/sandbox-docker</pre>
      <p>{{ t('testLab.requirements.permits') }}</p>
      <p>{{ t('testLab.requirements.labels') }}</p>
      <p v-if="status.docker.error" class="lab-muted">{{ t('testLab.requirements.error', { error: status.docker.error }) }}</p>
      <div><NButton secondary @click="load">{{ t('testLab.checkAgain') }}</NButton></div>
    </section>

    <template v-else>
      <div class="lab-grid">
        <section class="lab-card" data-theme-surface="card" data-testid="test-lab-form">
          <h3>{{ t('testLab.newRun') }}</h3>
          <label class="lab-field">
            <span>{{ t('testLab.model') }}</span>
            <NSelect v-model:value="form.model" :options="modelOptions" filterable :placeholder="t('testLab.modelPlaceholder')" data-testid="test-lab-model" />
            <small class="lab-muted">{{ status.models.length ? t('testLab.modelHint') : t('testLab.noModels') }}</small>
          </label>
          <fieldset class="lab-field lab-apps">
            <legend>{{ t('testLab.apps') }}</legend>
            <div v-for="template in status.templates" :key="template.id" class="lab-app-option" data-testid="test-lab-app-option">
              <NCheckbox :checked="form.apps.includes(template.id)" @update:checked="(on: boolean) => form.apps = on ? [...form.apps, template.id] : form.apps.filter(id => id !== template.id)">
                <span class="lab-name">{{ template.name }}</span>
              </NCheckbox>
              <span class="lab-muted">{{ template.description }}</span>
              <span class="lab-muted">
                {{ template.image ? template.image : t('testLab.buildsFromGit') }}<template v-if="template.sizeMb"> · {{ t('testLab.size', { mb: template.sizeMb }) }}</template><template v-if="template.source === 'custom'"> · {{ t('testLab.custom') }}</template>
              </span>
              <NInput v-if="template.build !== null && form.apps.includes(template.id)" v-model:value="form.builds[template.id]" size="small"
                :placeholder="template.build || t('testLab.gitPlaceholder')" :input-props="{ 'aria-label': t('testLab.gitFor', { app: template.name }) }" />
            </div>
            <small v-if="selectedSizeMb" class="lab-muted">{{ t('testLab.download', { mb: selectedSizeMb }) }}</small>
          </fieldset>
          <label class="lab-field">
            <span>{{ t('testLab.instructions') }}</span>
            <NInput v-model:value="form.instructions" type="textarea" :autosize="{ minRows: 3, maxRows: 8 }" :placeholder="t('testLab.instructionsPlaceholder')" data-testid="test-lab-instructions" />
          </label>
          <div class="lab-row">
            <label class="lab-field lab-narrow">
              <span>{{ t('testLab.cap') }}</span>
              <NInputNumber v-model:value="form.capUsd" :min="0.01" :max="100" :step="0.05" :precision="2" data-testid="test-lab-cap">
                <template #prefix>$</template>
              </NInputNumber>
            </label>
            <label class="lab-field lab-narrow">
              <span>{{ t('testLab.minutes') }}</span>
              <NInputNumber v-model:value="form.minutes" :min="1" :max="240" :step="5" />
            </label>
          </div>
          <NCheckbox v-model:checked="form.browser">{{ t('testLab.browser') }}</NCheckbox>
          <NCheckbox v-model:checked="form.keepRunning">{{ t('testLab.keepRunning') }}</NCheckbox>
          <p class="lab-muted">{{ t('testLab.safety') }}</p>
          <div class="lab-row">
            <NButton type="primary" :disabled="!canStart" :loading="busy === 'start'" data-testid="test-lab-start" @click="start">{{ t('testLab.start') }}</NButton>
            <span v-if="anyActive" class="lab-muted">{{ t('testLab.oneAtATime') }}</span>
          </div>
          <div v-if="status.problems.length" class="lab-problems" role="note">
            <strong>{{ t('testLab.brokenTemplates') }}</strong>
            <ul><li v-for="problem in status.problems" :key="problem.file">{{ problem.file }}: {{ problem.errors.join('; ') }}</li></ul>
          </div>
          <NCollapse>
            <NCollapseItem :title="t('testLab.settings')" name="settings">
              <div class="lab-settings">
                <label class="lab-field"><span>{{ t('testLab.mirror') }}</span><NInput v-model:value="settings.registryMirror" placeholder="mirror.gcr.io" /><small class="lab-muted">{{ t('testLab.mirrorHint') }}</small></label>
                <label class="lab-field"><span>{{ t('testLab.runnerImage') }}</span><NInput v-model:value="settings.runnerImage" /></label>
                <label class="lab-field"><span>{{ t('testLab.browserImage') }}</span><NInput v-model:value="settings.browserImage" /></label>
                <div class="lab-row">
                  <label class="lab-field lab-narrow"><span>{{ t('testLab.defaultCap') }}</span><NInputNumber v-model:value="settings.defaultCapUsd" :min="0.01" :max="100" :step="0.05" :precision="2" /></label>
                  <label class="lab-field lab-narrow"><span>{{ t('testLab.defaultMinutes') }}</span><NInputNumber v-model:value="settings.defaultMinutes" :min="1" :max="240" /></label>
                  <label class="lab-field lab-narrow"><span>{{ t('testLab.maxSteps') }}</span><NInputNumber v-model:value="settings.maxSteps" :min="1" :max="200" /></label>
                </div>
                <small class="lab-muted">{{ t('testLab.templateFolder', { dir: status.customTemplateDir }) }}</small>
                <div><NButton secondary :loading="busy === 'settings'" @click="saveSettings">{{ t('testLab.saveSettings') }}</NButton></div>
              </div>
            </NCollapseItem>
          </NCollapse>
        </section>

        <section class="lab-card" data-theme-surface="card" data-testid="test-lab-runs">
          <h3>{{ t('testLab.runs') }}</h3>
          <p v-if="!runs.length" class="lab-muted">{{ t('testLab.noRuns') }}</p>
          <ul v-else class="lab-list">
            <li v-for="run in runs" :key="run.id">
              <button type="button" class="lab-run-item" :aria-current="selected?.id === run.id ? 'true' : undefined" data-testid="test-lab-run-item" @click="select(run.id)">
                <span class="lab-name">{{ when(run.createdAt) }}</span>
                <span class="lab-badge" :data-state="run.status">{{ statusText(run) }}</span>
                <span class="lab-muted">{{ run.apps.join(', ') }} · {{ run.model.id }}</span>
                <span class="lab-muted">
                  <template v-if="run.passed !== undefined">{{ t('testLab.counts', { passed: run.passed, failed: run.failed ?? 0 }) }} · </template>{{ money(run.costUsd) }}<template v-if="!run.removed && !['starting', 'running'].includes(run.status)"> · {{ t('testLab.stillRunning') }}</template>
                </span>
              </button>
            </li>
          </ul>
        </section>
      </div>

      <SandboxCard />
      <SandboxNetworkCard />

      <section v-if="selected" class="lab-card" data-theme-surface="card" data-testid="test-lab-run">
        <div class="lab-run-head">
          <div class="lab-title">
            <h3>{{ t('testLab.run', { id: selected.id }) }}</h3>
            <span class="lab-badge" :data-state="selected.status" data-testid="test-lab-run-status">{{ statusText(selected) }}</span>
          </div>
          <div class="lab-row">
            <NButton v-if="active" type="error" secondary :loading="busy === 'stop'" data-testid="test-lab-stop" @click="stop">{{ t('testLab.stop') }}</NButton>
            <NPopconfirm v-if="!active && !selected.removed" @positive-click="remove">
              <template #trigger><NButton secondary :loading="busy === 'remove'" data-testid="test-lab-remove">{{ t('testLab.remove') }}</NButton></template>
              {{ t('testLab.removeConfirm') }}
            </NPopconfirm>
            <NButton v-if="!active" secondary :loading="busy === 'zip'" data-testid="test-lab-download" @click="download">{{ t('testLab.downloadZip') }}</NButton>
          </div>
        </div>
        <p class="lab-muted">{{ t('testLab.runMeta', { model: selected.model.id, cap: money(selected.capUsd), minutes: selected.minutes }) }}</p>
        <p v-if="selected.message" class="lab-warn" role="note">{{ selected.message }}</p>

        <div class="lab-grid">
          <div>
            <h4>{{ t('testLab.progress') }}</h4>
            <ol class="lab-steps" aria-live="polite" data-testid="test-lab-steps">
              <li v-for="step in selected.steps" :key="step.key" :data-state="step.state">
                <span>{{ t(`testLab.step.${step.key}`) }}</span>
                <span class="lab-badge" :data-state="step.state">{{ t(`testLab.stepState.${step.state}`) }}</span>
                <span v-if="step.detail" class="lab-muted">{{ step.detail }}</span>
              </li>
            </ol>
          </div>
          <div>
            <h4>{{ t('testLab.cost') }}</h4>
            <dl class="lab-cost" data-testid="test-lab-cost">
              <dt>{{ t('testLab.gatewayCost') }}</dt>
              <dd>{{ money(selected.cost.gatewayUsd) }} · {{ t('testLab.tokens', { tokens: selected.cost.tokens.toLocaleString() }) }}<template v-if="selected.cost.unpricedCalls"> · {{ t('testLab.unpriced', { n: selected.cost.unpricedCalls }) }}</template></dd>
              <template v-if="selected.cost.openrouterBefore !== undefined">
                <dt>{{ t('testLab.openrouter') }}</dt>
                <dd>{{ t('testLab.openrouterValues', { before: money(selected.cost.openrouterBefore), after: money(selected.cost.openrouterAfter), spent: money(selected.cost.openrouterUsd) }) }}</dd>
              </template>
              <dt>{{ t('testLab.capLabel') }}</dt>
              <dd>{{ money(selected.capUsd) }}</dd>
            </dl>
            <p v-if="selected.cost.openrouterError" class="lab-muted">{{ selected.cost.openrouterError }}</p>
          </div>
        </div>

        <h4>{{ t('testLab.appsTitle') }}</h4>
        <ul class="lab-list" data-testid="test-lab-apps">
          <li v-for="app in selected.apps" :key="app.id" class="lab-app" data-testid="test-lab-app">
            <div class="lab-app-head">
              <span class="lab-name">{{ app.name }}</span>
              <span class="lab-badge" :data-state="app.state">{{ t(`testLab.appState.${app.state}`) }}</span>
              <code class="lab-muted">{{ app.url }}</code>
              <NButton v-if="selected.logs.includes(app.id)" size="small" quaternary :aria-expanded="logFor === app.id" @click="showLog(app.id)">{{ t('testLab.log') }}</NButton>
            </div>
            <span v-if="app.message" class="lab-muted">{{ app.message }}</span>
            <span v-if="app.logins.length" class="lab-muted">{{ t('testLab.logins') }}: {{ app.logins.map(login => `${login.username} / ${login.password}`).join(', ') }}</span>
            <pre v-if="logFor === app.id" class="lab-code lab-log">{{ logText || '…' }}</pre>
          </li>
        </ul>

        <template v-if="selected.report">
          <h4>{{ t('testLab.report') }}</h4>
          <p class="lab-summary" data-testid="test-lab-summary">{{ selected.report.summary }}</p>
          <p class="lab-muted">{{ t('testLab.counts', { passed: selected.report.passed, failed: selected.report.failed }) }}<template v-if="selected.report.skipped"> · {{ t('testLab.skippedCount', { n: selected.report.skipped }) }}</template></p>
          <ul class="lab-list" data-testid="test-lab-checks">
            <li v-for="(check, index) in selected.report.checks" :key="index" class="lab-check">
              <span class="lab-badge" :data-state="check.result">{{ t(`testLab.result.${check.result}`) }}</span>
              <span class="lab-name">{{ check.name }}</span>
              <span v-if="check.detail" class="lab-muted">{{ check.detail }}</span>
            </li>
          </ul>
        </template>

        <template v-if="selected.screenshots.length">
          <h4>{{ t('testLab.screenshots') }}</h4>
          <div class="lab-shots">
            <button v-for="name in selected.screenshots" :key="name" type="button" class="lab-shot" :aria-label="t('testLab.openShot', { name })" @click="bigShot = name">
              <img v-if="shots[name]" :src="shots[name]" :alt="name">
              <span class="lab-muted">{{ name }}</span>
            </button>
          </div>
        </template>

        <NCollapse v-if="selected.transcript.length">
          <NCollapseItem :title="t('testLab.transcript', { n: selected.transcript.length })" name="transcript">
            <ol class="lab-transcript" data-testid="test-lab-transcript">
              <li v-for="(line, index) in selected.transcript" :key="index" :data-role="line.role">
                <strong>{{ line.tool || t(`testLab.role.${line.role}`) }}</strong>
                <span>{{ line.text }}</span>
              </li>
            </ol>
          </NCollapseItem>
        </NCollapse>
      </section>
    </template>

    <NModal :show="!!bigShot" preset="card" :style="{ width: 'min(1100px, 96vw)' }" :title="bigShot" @update:show="(open: boolean) => { if (!open) bigShot = '' }">
      <img v-if="shots[bigShot]" class="lab-big-shot" :src="shots[bigShot]" :alt="bigShot">
    </NModal>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.lab-view {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 12px;
  width: 100%;
  min-width: 0;
  height: 100%;
  min-height: 0;
  padding: 12px 16px 24px;
  overflow: auto;
  color: $text-primary;
}

.lab-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
  padding: 14px;
  background: $bg-card;
  border: var(--border-width, 1px) solid $border-light;
  border-radius: var(--radius-component, 8px);

  h2, h3, h4 {
    margin: 0;
    font-size: 15px;
    font-weight: 600;
  }

  h4 {
    margin-top: 4px;
    font-size: 14px;
  }

  p {
    margin: 0;
  }
}

.lab-bar {
  flex-direction: row;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
}

.lab-title {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 12px;
  min-width: 0;
}

.lab-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
  gap: 12px;
  align-items: start;
}

.lab-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  margin: 0;
  padding: 0;
  border: none;

  > span, legend {
    font-size: 13px;
    font-weight: 600;
    color: $text-secondary;
  }
}

.lab-narrow {
  width: 150px;
}

.lab-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
}

.lab-apps {
  gap: 8px;
}

.lab-app-option {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding-bottom: 8px;
  border-bottom: var(--border-width, 1px) solid $border-light;
}

.lab-name {
  font-weight: 500;
  overflow-wrap: anywhere;
}

.lab-muted {
  font-size: 12px;
  color: $text-muted;
  overflow-wrap: anywhere;
}

.lab-error {
  margin: 0;
  color: $error;
}

.lab-warn {
  color: $warning;
}

.lab-loading {
  display: flex;
  justify-content: center;
  padding: 24px;
}

.lab-code {
  margin: 0;
  padding: 8px;
  overflow: auto;
  font-family: $font-code;
  font-size: 12px;
  white-space: pre-wrap;
  border: var(--border-width, 1px) solid $border-light;
  border-radius: $radius-sm;
}

.lab-log {
  max-height: 280px;
}

.lab-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.lab-run-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: 100%;
  min-height: 44px;
  padding: 8px;
  color: inherit;
  font: inherit;
  text-align: left;
  background: transparent;
  border: var(--border-width, 1px) solid $border-light;
  border-radius: $radius-sm;
  cursor: pointer;

  &:hover {
    background: $bg-card-hover;
  }

  &[aria-current="true"] {
    border-color: $accent-primary;
  }

  &:focus-visible {
    outline: 2px solid $accent-primary;
    outline-offset: 2px;
  }
}

.lab-badge {
  align-self: flex-start;
  padding: 0 6px;
  font-size: 12px;
  font-weight: 600;
  line-height: 18px;
  color: $text-secondary;
  border: var(--border-width, 1px) solid $border-light;
  border-radius: 9px;

  &[data-state="passed"], &[data-state="pass"], &[data-state="done"], &[data-state="healthy"] {
    color: $success;
  }

  &[data-state="failed"], &[data-state="fail"], &[data-state="error"], &[data-state="unhealthy"] {
    color: $error;
  }

  &[data-state="stopped"], &[data-state="skipped"], &[data-state="skip"] {
    color: $warning;
  }

  &[data-state="running"], &[data-state="starting"], &[data-state="pulling"], &[data-state="building"] {
    color: $accent-primary;
  }
}

.lab-run-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.lab-steps {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 6px 0 0;
  padding-left: 20px;

  li > span {
    margin-right: 8px;
  }
}

.lab-cost {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 4px 12px;
  margin: 6px 0 0;

  dt {
    color: $text-secondary;
  }

  dd {
    margin: 0;
    font-variant-numeric: tabular-nums;
  }
}

.lab-app {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding-bottom: 6px;
  border-bottom: var(--border-width, 1px) solid $border-light;
}

.lab-app-head, .lab-check {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 10px;
}

.lab-summary {
  white-space: pre-wrap;
}

.lab-shots {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 8px;
}

.lab-shot {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 4px;
  color: inherit;
  font: inherit;
  background: transparent;
  border: var(--border-width, 1px) solid $border-light;
  border-radius: $radius-sm;
  cursor: zoom-in;

  img {
    width: 100%;
    aspect-ratio: 16 / 10;
    object-fit: cover;
    object-position: top;
  }

  &:focus-visible {
    outline: 2px solid $accent-primary;
    outline-offset: 2px;
  }
}

.lab-big-shot {
  width: 100%;
}

.lab-transcript {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 420px;
  margin: 0;
  padding-left: 20px;
  overflow: auto;
  font-size: 13px;

  li {
    overflow-wrap: anywhere;
  }

  strong {
    margin-right: 6px;
    color: $text-secondary;
  }
}

.lab-problems ul {
  margin: 4px 0 0;
  padding-left: 18px;
  font-size: 12px;
}

@media (max-width: $breakpoint-mobile) {
  .lab-view {
    padding: 8px;
  }

  // Room for the floating menu button.
  .lab-bar {
    padding-left: 52px;
    min-height: 52px;
  }

  .lab-grid {
    grid-template-columns: minmax(0, 1fr);
  }

  .lab-narrow {
    width: calc(50% - 6px);
  }
}
</style>
