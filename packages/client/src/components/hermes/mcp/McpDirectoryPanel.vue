<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { NAlert, NButton, NCheckbox, NEmpty, NInput, NModal, NSelect, NSpin, NTag, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { fetchMcpServers, mcpServerAdd } from '@/api/hermes/mcp'
import {
  directoryServerName, directorySetupPrompt, fetchMcpDirectory,
  type McpDirectoryConfig, type McpDirectoryEntry, type McpDirectoryResponse, type McpRecommendedEntry,
} from '@/api/hermes/extensions'
import { COMPOSE_QUERY_KEY } from '@/utils/compose-link'

/**
 * MCP directory (docs/mcp-directory.md): the community list
 * punkpeye/awesome-mcp-servers, searched on the server, plus recommended
 * servers with a pinned config. Add asks first; "Set up with Hermes" opens a
 * new chat with a setup request in the composer.
 */
const emit = defineEmits<{ changed: [server?: string] }>()

const { t } = useI18n()
const message = useMessage()
const router = useRouter()

const PAGE = 60
const query = ref('')
const category = ref<string | null>(null)
const scope = ref<'' | 'local' | 'cloud'>('')
const official = ref(false)
const ready = ref(false)
const data = ref<McpDirectoryResponse | null>(null)
const entries = ref<McpDirectoryEntry[]>([])
const loading = ref(false)
const error = ref('')
const added = ref<Set<string>>(new Set())

const categoryOptions = computed(() => (data.value?.categories || [])
  .map(item => ({ label: `${item.name} (${item.count})`, value: item.name })))
const scopeOptions = computed(() => [
  { label: t('mcpDirectory.scopeAny'), value: '' },
  { label: t('mcpDirectory.scopeLocal'), value: 'local' },
  { label: t('mcpDirectory.scopeCloud'), value: 'cloud' },
])
const recommended = computed(() => {
  const q = query.value.trim().toLowerCase()
  return (data.value?.recommended || []).filter(item => !q || `${item.title} ${item.description}`.toLowerCase().includes(q))
})
const fetchedAt = computed(() => data.value?.fetchedAt ? new Date(data.value.fetchedAt).toLocaleString() : '')
const more = computed(() => (data.value?.total || 0) > entries.value.length)

let seq = 0
async function load(options: { append?: boolean; refresh?: boolean } = {}) {
  const mine = ++seq
  loading.value = true
  error.value = ''
  try {
    const result = await fetchMcpDirectory({
      q: query.value, category: category.value || '', scope: scope.value, official: official.value, ready: ready.value,
      offset: options.append ? entries.value.length : 0, limit: PAGE, refresh: options.refresh,
    })
    if (mine !== seq) return
    data.value = result
    entries.value = options.append ? [...entries.value, ...result.entries] : result.entries
  } catch (err: any) {
    if (mine !== seq) return
    error.value = err?.message || t('mcpDirectory.loadFailed')
  } finally {
    if (mine === seq) loading.value = false
  }
}

let timer: ReturnType<typeof setTimeout> | undefined
watch(query, () => { clearTimeout(timer); timer = setTimeout(() => void load(), 250) })
watch([category, scope, official, ready], () => void load())

async function loadAdded() {
  try {
    const servers = await fetchMcpServers()
    added.value = new Set((servers.servers || []).map(server => server.name))
  } catch { /* the list still works without it */ }
}

// ---- Add (asks first: it runs code from npm or PyPI on the Hermes host) ----

interface Pending { name: string; title: string; url: string; config: McpDirectoryConfig; needs?: string; reviewed: boolean }
const pending = ref<Pending | null>(null)
const pendingName = ref('')
const adding = ref(false)
const nameTaken = computed(() => added.value.has(pendingName.value.trim()))
const nameValid = computed(() => /^[a-z0-9][a-z0-9_-]{0,63}$/.test(pendingName.value.trim()))

function askAddRecommended(item: McpRecommendedEntry) {
  pending.value = { name: item.name, title: item.title, url: item.url, config: item.config, needs: item.needs, reviewed: true }
  pendingName.value = item.name
}

function askAdd(entry: McpDirectoryEntry) {
  if (!entry.config) return
  pending.value = { name: directoryServerName(entry.name), title: entry.name, url: entry.url, config: entry.config, reviewed: false }
  pendingName.value = pending.value.name
}

async function confirmAdd() {
  const item = pending.value
  if (!item || !nameValid.value || nameTaken.value) return
  adding.value = true
  try {
    const name = pendingName.value.trim()
    const result = await mcpServerAdd(name, { command: item.config.command, args: item.config.args })
    if (result.error || result.ok === false) throw new Error(result.error || t('mcpDirectory.addFailed'))
    message.success(t('mcpDirectory.added', { name }))
    pending.value = null
    await loadAdded()
    emit('changed', name)
  } catch (err: any) {
    message.error(err?.message || t('mcpDirectory.addFailed'))
  } finally {
    adding.value = false
  }
}

function setUpWithHermes(entry: McpDirectoryEntry | McpRecommendedEntry) {
  const text = directorySetupPrompt({ name: 'title' in entry ? entry.title : entry.name, url: entry.url, description: entry.description, install: 'install' in entry ? entry.install : undefined })
  void router.push({ name: 'hermes.chat', query: { [COMPOSE_QUERY_KEY]: text } })
}

const commandLine = (config: McpDirectoryConfig) => [config.command, ...config.args].join(' ')

defineExpose({ load })
void load()
void loadAdded()
</script>

<template>
  <div class="directory-panel" data-testid="mcp-directory">
    <NAlert type="info" :bordered="false" class="mcp-notice">
      {{ t('mcpDirectory.intro') }}
      <a v-if="data" :href="data.source.repo" target="_blank" rel="noopener" class="directory-link">awesome-mcp-servers</a>
    </NAlert>
    <NAlert v-if="error" type="error" class="mcp-notice">{{ error }}</NAlert>

    <section v-if="recommended.length" class="directory-group" data-testid="mcp-directory-recommended">
      <h3 class="group-title">{{ t('mcpDirectory.recommendedTitle') }}</h3>
      <p class="group-hint">{{ t('mcpDirectory.recommendedHint') }}</p>
      <div class="directory-grid">
        <div v-for="item in recommended" :key="item.name" class="directory-card" :class="{ installed: added.has(item.name) }" :data-testid="`mcp-recommended-${item.name}`">
          <div class="directory-head">
            <h4>{{ item.title }}</h4>
            <div class="directory-tags">
              <NTag v-if="added.has(item.name)" size="small" type="success" round>{{ t('mcpDirectory.addedTag') }}</NTag>
              <NTag size="small" round>{{ item.licence }}</NTag>
            </div>
          </div>
          <p class="directory-desc">{{ item.description }}</p>
          <p class="directory-note">{{ item.needs }}</p>
          <code class="directory-command">{{ commandLine(item.config) }}</code>
          <div class="directory-actions">
            <a :href="item.url" target="_blank" rel="noopener" class="directory-link">{{ t('mcpDirectory.source') }}</a>
            <span class="spacer" />
            <NButton size="tiny" :disabled="added.has(item.name)" type="primary" @click="askAddRecommended(item)">{{ t('mcpDirectory.add') }}</NButton>
          </div>
        </div>
      </div>
    </section>

    <h3 class="group-title">{{ t('mcpDirectory.communityTitle') }}</h3>
    <div class="toolbar-row directory-filters">
      <NInput v-model:value="query" :placeholder="t('mcpDirectory.search')" clearable size="small" class="search-input" :input-props="{ 'aria-label': t('mcpDirectory.search') }" />
      <NSelect v-model:value="category" :options="categoryOptions" :placeholder="t('mcpDirectory.allCategories')" clearable filterable size="small" class="directory-select" />
      <NSelect v-model:value="scope" :options="scopeOptions" size="small" class="directory-scope" />
      <NCheckbox v-model:checked="official" size="small">{{ t('mcpDirectory.officialOnly') }}</NCheckbox>
      <NCheckbox v-model:checked="ready" size="small">{{ t('mcpDirectory.readyOnly') }}</NCheckbox>
      <NButton size="small" quaternary :loading="loading" @click="load({ refresh: true })">{{ t('mcpDirectory.refresh') }}</NButton>
    </div>
    <p v-if="data" class="group-hint" role="status" aria-live="polite">
      {{ t('mcpDirectory.count', { shown: entries.length, total: data.total }) }}
      <span v-if="fetchedAt"> · {{ t('mcpDirectory.fetchedAt', { time: fetchedAt }) }}</span>
    </p>

    <div v-if="loading && !entries.length" class="directory-loading"><NSpin /></div>
    <div v-else-if="entries.length" class="directory-grid">
      <div v-for="entry in entries" :key="entry.url + entry.name" class="directory-card" data-testid="mcp-directory-entry">
        <div class="directory-head">
          <h4>{{ entry.name }}</h4>
          <div class="directory-tags">
            <NTag v-if="entry.official" size="small" type="info" round>{{ t('mcpDirectory.official') }}</NTag>
            <NTag v-for="item in entry.scopes" :key="item" size="small" round>{{ t(`mcpDirectory.scopeTag.${item}`) }}</NTag>
            <NTag v-for="lang in entry.languages" :key="lang" size="small" round>{{ lang }}</NTag>
          </div>
        </div>
        <p class="directory-category">{{ entry.category }}</p>
        <p class="directory-desc">{{ entry.description }}</p>
        <code v-if="entry.install" class="directory-command">{{ entry.install }}</code>
        <div class="directory-actions">
          <a :href="entry.url" target="_blank" rel="noopener" class="directory-link">{{ t('mcpDirectory.source') }}</a>
          <span class="spacer" />
          <NButton size="tiny" secondary @click="setUpWithHermes(entry)">{{ t('mcpDirectory.setUp') }}</NButton>
          <NButton v-if="entry.config" size="tiny" type="primary" @click="askAdd(entry)">{{ t('mcpDirectory.add') }}</NButton>
        </div>
      </div>
    </div>
    <NEmpty v-else-if="data" :description="t('mcpDirectory.noMatch')" />
    <div v-if="more" class="directory-more">
      <NButton size="small" :loading="loading" @click="load({ append: true })">{{ t('mcpDirectory.showMore') }}</NButton>
    </div>

    <NModal
      :show="!!pending"
      preset="card"
      :title="t('mcpDirectory.addTitle', { name: pending?.title || '' })"
      :style="{ width: 'min(560px, calc(100vw - 32px))' }"
      @update:show="(value: boolean) => { if (!value) pending = null }"
    >
      <div v-if="pending" class="add-body">
        <NAlert v-if="!pending.reviewed" type="warning" :bordered="false">{{ t('mcpDirectory.unreviewed') }}</NAlert>
        <p v-if="pending.needs" class="directory-note">{{ pending.needs }}</p>
        <div class="add-field">
          <span class="label">{{ t('mcpDirectory.runs') }}</span>
          <code class="directory-command">{{ commandLine(pending.config) }}</code>
        </div>
        <label class="add-field">
          <span class="label">{{ t('mcpDirectory.serverName') }}</span>
          <NInput v-model:value="pendingName" size="small" :status="nameValid && !nameTaken ? undefined : 'error'" />
          <span v-if="nameTaken" class="add-error">{{ t('mcpDirectory.nameTaken') }}</span>
          <span v-else-if="!nameValid" class="add-error">{{ t('mcpDirectory.nameInvalid') }}</span>
        </label>
        <div class="modal-actions">
          <NButton @click="pending = null">{{ t('mcpDirectory.cancel') }}</NButton>
          <NButton type="primary" :loading="adding" :disabled="!nameValid || nameTaken" @click="confirmAdd">{{ t('mcpDirectory.add') }}</NButton>
        </div>
      </div>
    </NModal>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;
@use '@/styles/mcp-manager' as mcp-manager;

@include mcp-manager.layout;

.directory-panel { display: flex; flex-direction: column; gap: calc(8px * var(--spacing-scale, 1)); }
.directory-group { display: flex; flex-direction: column; gap: calc(8px * var(--spacing-scale, 1)); }
.group-title { margin: calc(8px * var(--spacing-scale, 1)) 0 0; font-size: calc(var(--font-size-base, 14px) * 14 / 14); font-weight: 600; }
.group-hint { margin: 0; color: $text-muted; font-size: calc(var(--font-size-base, 14px) * 12 / 14); }
.directory-filters { flex-wrap: wrap; }
.directory-select { width: min(100%, 260px); }
.directory-scope { width: 140px; }
.directory-loading { display: grid; place-items: center; padding: 40px 0; }
.directory-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 300px), 1fr)); gap: calc(12px * var(--spacing-scale, 1)); }
.directory-card {
  display: flex; flex-direction: column; gap: calc(6px * var(--spacing-scale, 1));
  padding: calc(14px * var(--spacing-scale, 1));
  border: var(--border-width, 1px) solid $border-color; border-radius: $radius-md;
  background: var(--theme-card-bg, $bg-card);
}
.directory-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
.directory-head h4 { margin: 0; font-size: calc(var(--font-size-base, 14px) * 14 / 14); font-weight: 600; word-break: break-word; }
.directory-tags { display: flex; gap: 4px; flex-wrap: wrap; justify-content: flex-end; }
.directory-category { margin: 0; color: $text-muted; font-size: calc(var(--font-size-base, 14px) * 11 / 14); }
.directory-desc { margin: 0; color: $text-secondary; font-size: calc(var(--font-size-base, 14px) * 13 / 14); flex: 1; }
.directory-note { margin: 0; color: $text-muted; font-size: calc(var(--font-size-base, 14px) * 12 / 14); }
.directory-command { font-size: calc(var(--font-size-base, 14px) * 11 / 14); word-break: break-all; color: $text-muted; }
.directory-actions { display: flex; align-items: center; gap: 8px; }
.directory-link { color: $accent-primary; font-size: calc(var(--font-size-base, 14px) * 12 / 14); text-decoration: none; }
.directory-more { display: flex; justify-content: center; padding: 8px 0; }
.spacer { flex: 1; }
.add-body { display: flex; flex-direction: column; gap: calc(12px * var(--spacing-scale, 1)); }
.add-field { display: flex; flex-direction: column; gap: 4px; }
.label { color: $text-muted; font-size: calc(var(--font-size-base, 14px) * 12 / 14); }
.add-error { color: $error; font-size: calc(var(--font-size-base, 14px) * 12 / 14); }
</style>
