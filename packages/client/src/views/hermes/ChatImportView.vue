<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { NButton, NCheckbox, NInput, NProgress, NRadioButton, NRadioGroup, NSelect } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import {
  discardChatImportScan,
  fetchChatImportJob,
  scanChatImportPath,
  startChatImport,
  uploadChatImportArchive,
  type ChatImportCandidate,
  type ChatImportJob,
  type ChatImportKind,
  type ChatImportScan,
} from '@/api/studio/chat-import'
import { fetchProfiles } from '@/api/hermes/profiles'
import { fetchSessionCategories, type SessionCategory } from '@/api/studio/sessions'

const PAGE = 200
const KINDS: ChatImportKind[] = ['hermes', 'claude-code', 'codex', 'openclaw']

const { t, locale } = useI18n()

const mode = ref<'path' | 'upload'>('path')
const path = ref('')
const file = ref<File | null>(null)
const busy = ref(false)
const error = ref('')
const scan = ref<ChatImportScan | null>(null)
const selected = ref<Set<string>>(new Set())
const shown = ref(PAGE)
const profiles = ref<Array<{ label: string; value: string }>>([{ label: 'default', value: 'default' }])
const profile = ref('default')
const folders = ref<SessionCategory[]>([])
const folder = ref<number | null>(null)
const job = ref<ChatImportJob | null>(null)
let poll: ReturnType<typeof setTimeout> | null = null

const importable = computed(() => (scan.value?.candidates ?? []).filter(c => !c.skipReason && !c.existingSessionId))
const visible = computed(() => (scan.value?.candidates ?? []).slice(0, shown.value))
const allSelected = computed(() => importable.value.length > 0 && importable.value.every(c => selected.value.has(c.key)))
const folderOptions = computed(() => [
  { label: t('chatImport.noFolder'), value: 0 },
  ...folders.value.map(item => ({ label: item.name, value: item.id })),
])
const progress = computed(() => job.value && job.value.total ? Math.round((job.value.done / job.value.total) * 100) : 0)
const running = computed(() => job.value?.status === 'running')

function plain(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  return message.replace(/^API Error \d+:\s*/, '') || t('chatImport.failedGeneric')
}

function date(seconds: number): string {
  if (!seconds) return '—'
  return new Date(seconds * 1000).toLocaleString(locale.value, { dateStyle: 'medium', timeStyle: 'short' })
}

function kindLabel(kind: ChatImportKind): string {
  return t(`chatImport.kind.${kind}`)
}

function status(candidate: ChatImportCandidate): string {
  if (candidate.existingSessionId) return t('chatImport.status.duplicate')
  if (candidate.skipReason) return t(`chatImport.status.${candidate.skipReason}`)
  if (candidate.kind === 'claude-code' || candidate.kind === 'codex') {
    return candidate.resumable ? t('chatImport.status.resumes') : t('chatImport.status.recap')
  }
  return t('chatImport.status.ready')
}

function toggle(key: string, on: boolean) {
  const next = new Set(selected.value)
  if (on) next.add(key)
  else next.delete(key)
  selected.value = next
}

function toggleAll(on: boolean) {
  selected.value = on ? new Set(importable.value.map(c => c.key)) : new Set()
}

function onFile(event: Event) {
  const input = event.target as HTMLInputElement
  file.value = input.files?.[0] ?? null
}

async function reset() {
  if (poll) clearTimeout(poll)
  poll = null
  const old = scan.value
  scan.value = null
  job.value = null
  selected.value = new Set()
  error.value = ''
  if (old && old.upload) await discardChatImportScan(old.id).catch(() => undefined)
}

async function runScan() {
  error.value = ''
  if (mode.value === 'path' && !path.value.trim()) { error.value = t('chatImport.needPath'); return }
  if (mode.value === 'upload' && !file.value) { error.value = t('chatImport.needFile'); return }
  busy.value = true
  try {
    await reset()
    const result = mode.value === 'path' ? await scanChatImportPath(path.value.trim()) : await uploadChatImportArchive(file.value!)
    scan.value = result
    shown.value = PAGE
    selected.value = new Set(result.candidates.filter(c => !c.skipReason && !c.existingSessionId).map(c => c.key))
    if (!result.candidates.length) error.value = t('chatImport.nothingFound')
  } catch (err) {
    error.value = plain(err)
  } finally {
    busy.value = false
  }
}

async function follow(id: string) {
  try {
    job.value = await fetchChatImportJob(id)
  } catch (err) {
    error.value = plain(err)
    return
  }
  if (job.value.status === 'running') poll = setTimeout(() => void follow(id), 700)
}

async function runImport() {
  if (!scan.value || !selected.value.size) return
  error.value = ''
  busy.value = true
  try {
    job.value = await startChatImport(scan.value.id, { keys: [...selected.value], profile: profile.value, categoryId: folder.value || null })
    void follow(job.value.id)
  } catch (err) {
    error.value = plain(err)
  } finally {
    busy.value = false
  }
}

async function again() {
  await reset()
  file.value = null
}

onMounted(async () => {
  const [loadedProfiles, loadedFolders] = await Promise.allSettled([fetchProfiles(), fetchSessionCategories()])
  if (loadedProfiles.status === 'fulfilled' && loadedProfiles.value.length) {
    profiles.value = loadedProfiles.value.map(item => ({ label: item.alias || item.name, value: item.name }))
    profile.value = loadedProfiles.value.find(item => item.active)?.name || loadedProfiles.value[0].name
  }
  if (loadedFolders.status === 'fulfilled') folders.value = loadedFolders.value
})

onBeforeUnmount(() => {
  if (poll) clearTimeout(poll)
})
</script>

<template>
  <div class="import-view" data-testid="chat-import-view">
    <header class="import-card import-head" data-theme-surface="card">
      <div>
        <h2>{{ t('chatImport.title') }}</h2>
        <p class="import-muted">{{ t('chatImport.subtitle') }}</p>
      </div>
      <RouterLink class="import-link" :to="{ name: 'hermes.chat' }">{{ t('chatImport.backToChats') }}</RouterLink>
    </header>

    <section class="import-card" data-theme-surface="card" :aria-label="t('chatImport.whatTitle')">
      <h3>{{ t('chatImport.whatTitle') }}</h3>
      <div class="import-what">
        <div>
          <strong>{{ t('chatImport.importedTitle') }}</strong>
          <ul>
            <li>{{ t('chatImport.imported1') }}</li>
            <li>{{ t('chatImport.imported2') }}</li>
            <li>{{ t('chatImport.imported3') }}</li>
          </ul>
        </div>
        <div>
          <strong>{{ t('chatImport.notImportedTitle') }}</strong>
          <ul>
            <li>{{ t('chatImport.notImported1') }}</li>
            <li>{{ t('chatImport.notImported2') }}</li>
            <li>{{ t('chatImport.notImported3') }}</li>
          </ul>
        </div>
      </div>
    </section>

    <section v-if="!job" class="import-card" data-theme-surface="card" data-testid="chat-import-source">
      <h3>{{ t('chatImport.step1') }}</h3>
      <NRadioGroup v-model:value="mode" :aria-label="t('chatImport.step1')" :disabled="busy">
        <NRadioButton value="path" data-testid="chat-import-mode-path">{{ t('chatImport.fromPath') }}</NRadioButton>
        <NRadioButton value="upload" data-testid="chat-import-mode-upload">{{ t('chatImport.fromUpload') }}</NRadioButton>
      </NRadioGroup>
      <div v-if="mode === 'path'" class="import-field">
        <label for="chat-import-path">{{ t('chatImport.pathLabel') }}</label>
        <div class="import-row">
          <NInput
            v-model:value="path"
            :input-props="{ id: 'chat-import-path' }"
            :placeholder="t('chatImport.pathPlaceholder')"
            :disabled="busy"
            @keyup.enter="runScan"
          />
          <NButton secondary :disabled="busy" @click="path = '~'">{{ t('chatImport.useHome') }}</NButton>
        </div>
        <span class="import-muted">{{ t('chatImport.pathHint') }}</span>
      </div>
      <div v-else class="import-field">
        <label for="chat-import-file">{{ t('chatImport.fileLabel') }}</label>
        <input
          id="chat-import-file"
          class="import-file"
          type="file"
          accept=".zip,.tar,.tgz,.gz"
          data-testid="chat-import-file"
          data-theme-surface="input"
          :disabled="busy"
          @change="onFile"
        >
        <span class="import-muted">{{ t('chatImport.fileHint') }}</span>
      </div>
      <div class="import-row">
        <NButton type="primary" :loading="busy && !scan" :disabled="busy" data-testid="chat-import-scan" @click="runScan">
          {{ mode === 'path' ? t('chatImport.scan') : t('chatImport.uploadScan') }}
        </NButton>
      </div>
    </section>

    <p v-if="error" class="import-error" role="alert" data-testid="chat-import-error">{{ error }}</p>
    <p class="import-sr" role="status" aria-live="polite">
      {{ busy && !scan ? t('chatImport.scanning') : scan && !job ? t('chatImport.found', { count: scan.candidates.length }) : '' }}
    </p>

    <section v-if="scan && !job && scan.candidates.length" class="import-card" data-theme-surface="card" data-testid="chat-import-preview">
      <div class="import-section-head">
        <h3>{{ t('chatImport.step2') }}</h3>
        <span class="import-muted">{{ scan.label }}</span>
      </div>
      <ul class="import-counts">
        <li v-for="kind in KINDS" :key="kind" :data-testid="`chat-import-count-${kind}`">
          <span class="import-badge">{{ kindLabel(kind) }}</span> {{ t('chatImport.chats', { count: scan.counts[kind] }) }}
        </li>
      </ul>
      <p class="import-muted">
        {{ t('chatImport.summary', { ready: importable.length, duplicates: scan.candidates.filter(c => c.existingSessionId).length, skipped: scan.candidates.filter(c => c.skipReason && !c.existingSessionId).length }) }}
        <template v-if="scan.skippedFiles"> {{ t('chatImport.skippedFiles', { count: scan.skippedFiles }) }}</template>
      </p>
      <p v-if="scan.truncated" class="import-warning">{{ t('chatImport.truncated', { count: scan.candidates.length }) }}</p>
      <p v-for="item in scan.errors.slice(0, 5)" :key="item" class="import-warning">{{ item }}</p>
      <NCheckbox :checked="allSelected" :disabled="!importable.length" data-testid="chat-import-all" @update:checked="toggleAll">
        {{ t('chatImport.selectAll', { count: importable.length }) }}
      </NCheckbox>
      <ul class="import-list">
        <li v-for="candidate in visible" :key="candidate.key" class="import-item" :data-testid="`chat-import-item-${candidate.kind}`">
          <NCheckbox
            :checked="selected.has(candidate.key)"
            :disabled="!!candidate.skipReason || !!candidate.existingSessionId"
            :aria-label="t('chatImport.selectChat', { title: candidate.title })"
            @update:checked="on => toggle(candidate.key, on)"
          />
          <div class="import-item-body">
            <div class="import-item-title">
              <span class="import-badge">{{ kindLabel(candidate.kind) }}</span>
              <span class="import-title-text">{{ candidate.title }}</span>
            </div>
            <div class="import-muted import-item-meta">
              <span>{{ date(candidate.lastActive || candidate.startedAt) }}</span>
              <span>{{ t('chatImport.messages', { count: candidate.messageCount }) }}</span>
              <span v-if="candidate.sourceProfile">{{ t('chatImport.fromProfile', { name: candidate.sourceProfile }) }}</span>
              <span v-if="candidate.cwd" class="import-path">{{ candidate.cwd }}{{ candidate.cwdExists ? '' : ` (${t('chatImport.folderMissing')})` }}</span>
            </div>
            <div class="import-status" :class="{ 'is-skip': candidate.skipReason || candidate.existingSessionId }">
              {{ status(candidate) }}
              <RouterLink v-if="candidate.existingSessionId" class="import-link" :to="{ name: 'hermes.session', params: { sessionId: candidate.existingSessionId } }">
                {{ t('chatImport.open') }}
              </RouterLink>
            </div>
          </div>
        </li>
      </ul>
      <NButton v-if="scan.candidates.length > shown" secondary @click="shown += PAGE">
        {{ t('chatImport.showMore', { count: scan.candidates.length - shown }) }}
      </NButton>

      <h3>{{ t('chatImport.step3') }}</h3>
      <div class="import-targets">
        <div class="import-field">
          <span class="import-label">{{ t('chatImport.profile') }}</span>
          <NSelect v-model:value="profile" :options="profiles" :aria-label="t('chatImport.profile')" data-testid="chat-import-profile" />
        </div>
        <div class="import-field">
          <span class="import-label">{{ t('chatImport.folder') }}</span>
          <NSelect :value="folder ?? 0" :options="folderOptions" :aria-label="t('chatImport.folder')" data-testid="chat-import-folder" @update:value="(value: number) => folder = value || null" />
        </div>
      </div>
      <div class="import-row">
        <NButton type="primary" :disabled="!selected.size || busy" :loading="busy" data-testid="chat-import-start" @click="runImport">
          {{ t('chatImport.import', { count: selected.size }) }}
        </NButton>
        <NButton secondary :disabled="busy" @click="again">{{ t('chatImport.cancel') }}</NButton>
      </div>
    </section>

    <section v-if="job" class="import-card" data-theme-surface="card" data-testid="chat-import-result">
      <h3>{{ running ? t('chatImport.importing') : t('chatImport.done') }}</h3>
      <NProgress type="line" :percentage="progress" :show-indicator="false" :aria-label="t('chatImport.progress')" />
      <p role="status" aria-live="polite" data-testid="chat-import-progress">
        {{ t('chatImport.progressText', { done: job.done, total: job.total }) }}
      </p>
      <template v-if="!running">
        <p data-testid="chat-import-summary">
          {{ t('chatImport.resultSummary', { imported: job.imported.length, skipped: job.skipped.length, failed: job.failed.length }) }}
        </p>
        <p v-if="job.error" class="import-error" role="alert">{{ job.error }}</p>
        <ul v-if="job.imported.length" class="import-results">
          <li v-for="item in job.imported.slice(0, 100)" :key="item.key">
            <span class="import-badge">{{ kindLabel(item.kind) }}</span>
            <RouterLink v-if="item.sessionId" class="import-link" :to="{ name: 'hermes.session', params: { sessionId: item.sessionId } }">{{ item.title }}</RouterLink>
          </li>
        </ul>
        <template v-if="job.failed.length">
          <h4>{{ t('chatImport.failedTitle') }}</h4>
          <ul class="import-results">
            <li v-for="item in job.failed" :key="item.key">{{ item.title }}: {{ item.reason }}</li>
          </ul>
        </template>
        <div class="import-row">
          <RouterLink class="import-link" :to="{ name: 'hermes.chat' }">{{ t('chatImport.backToChats') }}</RouterLink>
          <NButton secondary data-testid="chat-import-again" @click="again">{{ t('chatImport.again') }}</NButton>
        </div>
      </template>
    </section>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.import-view {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 12px;
  width: 100%;
  max-width: 1000px;
  min-width: 0;
  height: 100%;
  min-height: 0;
  margin: 0 auto;
  padding: 12px 16px 24px;
  overflow: auto;
  color: $text-primary;
}

.import-card {
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

  h3 { font-size: 14px; }
}

.import-head {
  flex-direction: row;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;

  p { margin: 4px 0 0; }
}

.import-muted {
  color: $text-secondary;
  font-size: 13px;
}

.import-what {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 12px;
  font-size: 13px;

  ul {
    margin: 6px 0 0;
    padding-left: 18px;
    color: $text-secondary;
  }
}

.import-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;

  label, .import-label { font-size: 13px; font-weight: 600; }
}

.import-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;

  > :first-child { flex: 1 1 260px; }
  > .n-button:first-child { flex: 0 0 auto; }
}

.import-file {
  min-height: 44px;
  padding: 8px;
  color: $text-primary;
  border: var(--border-width, 1px) solid $border-light;
  border-radius: var(--radius-component, 8px);

  &:focus-visible { outline: 2px solid $accent-primary; outline-offset: 2px; }
}

.import-error {
  margin: 0;
  padding: 10px 12px;
  color: $error;
  border: var(--border-width, 1px) solid $error;
  border-radius: var(--radius-component, 8px);
}

.import-warning {
  margin: 0;
  color: $warning;
  font-size: 13px;
}

.import-sr {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
}

.import-section-head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: 4px 12px;
}

.import-counts {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 16px;
  margin: 0;
  padding: 0;
  list-style: none;
  font-size: 13px;
}

.import-badge {
  display: inline-block;
  padding: 1px 8px;
  color: $text-primary;
  font-size: 12px;
  border: var(--border-width, 1px) solid $border-light;
  border-radius: 999px;
}

.import-list {
  display: flex;
  flex-direction: column;
  margin: 0;
  padding: 0;
  list-style: none;
}

.import-item {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  min-height: 44px;
  padding: 8px 0;
  border-top: var(--border-width, 1px) solid $border-light;
}

.import-item-body {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.import-item-title {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.import-title-text {
  min-width: 0;
  overflow: hidden;
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.import-item-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 2px 12px;
}

.import-path {
  overflow-wrap: anywhere;
  font-family: $font-code;
  font-size: 12px;
}

.import-status {
  font-size: 13px;

  &.is-skip { color: $text-secondary; }
}

.import-targets {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 12px;
}

.import-link {
  display: inline-flex;
  align-items: center;
  min-height: 32px;
  color: $accent-primary;

  &:focus-visible { outline: 2px solid $accent-primary; outline-offset: 2px; }
}

.import-results {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;

  li { display: flex; align-items: center; gap: 8px; }
}
</style>
