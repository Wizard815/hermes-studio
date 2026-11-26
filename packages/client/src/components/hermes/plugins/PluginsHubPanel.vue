<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import {
  NAlert, NButton, NEmpty, NInput, NModal, NPopconfirm, NSelect, NSpin, NSwitch, NTag, useDialog, useMessage,
} from 'naive-ui'
import { useI18n } from 'vue-i18n'
import {
  fetchPluginsAutoUpdate, fetchPluginsCatalog, filterPluginCatalog, installHubPlugin, installPluginFromSource,
  pluginActionProblem, removeHubPlugin, setPluginsAutoUpdate, updateAllHubPlugins, updateHubPlugin,
  type PluginActionResult, type PluginCatalogEntry,
} from '@/api/hermes/extensions'

/** Hermes's plugin hub on Studio's Plugins page: browse, install, update, remove. */
const emit = defineEmits<{ changed: [] }>()
const props = withDefaults(defineProps<{
  /** Catalog names Studio recommends (badge). */
  recommended?: string[]
  /** Required keys not set yet, by plugin name (installed plugins only). */
  missingEnv?: Record<string, string[]>
  envFile?: string
}>(), { recommended: () => [], missingEnv: () => ({}), envFile: '.env' })

const { t, te } = useI18n()
const message = useMessage()
const dialog = useDialog()

const PAGE = 60

const entries = ref<PluginCatalogEntry[]>([])
const loading = ref(false)
const loaded = ref(false)
const error = ref('')
const query = ref('')
const category = ref<string | null>(null)
const tier = ref<string | null>(null)
const show = ref<'all' | 'installed' | 'updates'>('all')
const limit = ref(PAGE)
const busy = ref<Record<string, string>>({})
const autoUpdate = ref<boolean | null>(null)
const autoUpdateBusy = ref(false)
const updatingAll = ref(false)
const showSource = ref(false)
const sourceText = ref('')
const sourceBusy = ref(false)

const filtered = computed(() => filterPluginCatalog(entries.value, { query: query.value, category: category.value, tier: tier.value, show: show.value }))
const visible = computed(() => filtered.value.slice(0, limit.value))
const updatesCount = computed(() => entries.value.filter(e => e.update_available).length)
const installedCount = computed(() => entries.value.filter(e => e.installed).length)

const categoryOptions = computed(() => Array.from(new Set(entries.value.map(e => e.category).filter(Boolean)))
  .sort().map(value => ({ value, label: label('category', value) })))
const tierOptions = computed(() => ['official', 'verified', 'community']
  .filter(value => entries.value.some(e => e.tier === value)).map(value => ({ value, label: label('tier', value) })))
const showOptions = computed(() => [
  { value: 'all', label: t('hermesExtensions.common.all') },
  { value: 'installed', label: `${t('hermesExtensions.common.installed')} (${installedCount.value})` },
  { value: 'updates', label: `${t('hermesExtensions.hub.updates')} (${updatesCount.value})` },
])

watch([query, category, tier, show], () => { limit.value = PAGE })

function label(group: 'category' | 'tier', value: string) {
  const key = `hermesExtensions.hub.${group}.${value}`
  return te(key) ? t(key) : value
}

function tierType(value: string): 'success' | 'info' | 'default' {
  return value === 'official' ? 'success' : value === 'verified' ? 'info' : 'default'
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    const [catalog, auto] = await Promise.all([
      fetchPluginsCatalog(),
      fetchPluginsAutoUpdate().catch(() => null),
    ])
    entries.value = catalog.entries || []
    autoUpdate.value = auto ? !!auto.auto_apply : null
    loaded.value = true
  } catch (err: any) {
    error.value = err?.message || t('hermesExtensions.hub.loadFailed')
  } finally {
    loading.value = false
  }
}

function setBusy(name: string, action: string | null) {
  const next = { ...busy.value }
  if (action) next[name] = action
  else delete next[name]
  busy.value = next
}

async function afterChange() {
  await load()
  emit('changed')
}

function reportInstalled(name: string, result: PluginActionResult) {
  const missing = result.missing_env || []
  if (missing.length) message.warning(t('hermesExtensions.hub.installedNeedsKeys', { name, keys: missing.join(', ') }), { duration: 8000 })
  else message.success(t('hermesExtensions.hub.installedOk', { name }))
  if (result.restart_required) message.info(t('hermesExtensions.hub.restartNeeded'), { duration: 6000 })
}

async function install(entry: PluginCatalogEntry) {
  setBusy(entry.name, 'install')
  try {
    const result = await installHubPlugin(entry.name)
    const problem = pluginActionProblem(result)
    if (problem) message.error(problemText(problem))
    else reportInstalled(result.plugin_name || entry.name, result)
    await afterChange()
  } catch (err: any) {
    message.error(err?.message || t('hermesExtensions.hub.installFailed'))
  } finally {
    setBusy(entry.name, null)
  }
}

function problemText(problem: string) {
  if (problem === 'consent') return t('hermesExtensions.hub.needsConsent')
  if (problem === 'scan') return t('hermesExtensions.hub.scanBlocked')
  if (problem === 'failed') return t('hermesExtensions.hub.actionFailed')
  return problem
}

async function update(name: string, confirm: { accept_capabilities?: boolean; force?: boolean } = {}) {
  setBusy(name, 'update')
  try {
    const result = await updateHubPlugin(name, confirm)
    if (result.consent_required) {
      askToContinue(name, t('hermesExtensions.hub.consentQuestion'), result.delta, { accept_capabilities: true })
    } else if (result.scan_blocked) {
      if (result.scan_verdict === 'caution') askToContinue(name, t('hermesExtensions.hub.scanQuestion'), result.scan_findings, { force: true })
      else message.error(t('hermesExtensions.hub.scanBlocked'))
    } else {
      message.success(t('hermesExtensions.hub.updatedOk', { name }))
      await afterChange()
    }
  } catch (err: any) {
    message.error(err?.message || t('hermesExtensions.hub.actionFailed'))
  } finally {
    setBusy(name, null)
  }
}

function askToContinue(name: string, question: string, details: unknown, confirm: { accept_capabilities?: boolean; force?: boolean }) {
  const text = details ? JSON.stringify(details, null, 2).slice(0, 1500) : ''
  dialog.warning({
    title: t('hermesExtensions.hub.reviewTitle', { name }),
    content: text ? `${question}\n\n${text}` : question,
    style: { whiteSpace: 'pre-wrap' },
    positiveText: t('hermesExtensions.hub.updateAnyway'),
    negativeText: t('hermesExtensions.common.cancel'),
    onPositiveClick: () => { void update(name, confirm) },
  })
}

async function remove(entry: PluginCatalogEntry) {
  setBusy(entry.name, 'remove')
  try {
    await removeHubPlugin(entry.name)
    message.success(t('hermesExtensions.hub.removedOk', { name: entry.name }))
    await afterChange()
  } catch (err: any) {
    message.error(err?.message || t('hermesExtensions.hub.actionFailed'))
  } finally {
    setBusy(entry.name, null)
  }
}

async function updateAll() {
  updatingAll.value = true
  try {
    const outcome = await updateAllHubPlugins()
    const count = (status: string) => outcome.results.filter(r => r.status === status).length
    const failed = outcome.results.filter(r => r.status === 'failed').map(r => r.name)
    const review = outcome.results.filter(r => r.status === 'needs_review').map(r => r.name)
    message.info(t('hermesExtensions.hub.updateAllDone', { updated: count('updated'), current: count('current') + (outcome.current || 0) }), { duration: 6000 })
    if (failed.length) message.error(t('hermesExtensions.hub.updateAllFailed', { names: failed.join(', ') }), { duration: 8000 })
    if (review.length) message.warning(t('hermesExtensions.hub.updateAllReview', { names: review.join(', ') }), { duration: 8000 })
    await afterChange()
  } catch (err: any) {
    message.error(err?.message || t('hermesExtensions.hub.actionFailed'))
  } finally {
    updatingAll.value = false
  }
}

async function toggleAutoUpdate(value: boolean) {
  autoUpdateBusy.value = true
  try {
    const state = await setPluginsAutoUpdate(value)
    autoUpdate.value = !!state.auto_apply
    message.success(t(value ? 'hermesExtensions.hub.autoUpdateOn' : 'hermesExtensions.hub.autoUpdateOff'))
  } catch (err: any) {
    message.error(err?.message || t('hermesExtensions.hub.actionFailed'))
  } finally {
    autoUpdateBusy.value = false
  }
}

async function installFromSource() {
  const identifier = sourceText.value.trim()
  if (!identifier) return
  sourceBusy.value = true
  try {
    const result = await installPluginFromSource(identifier)
    const problem = pluginActionProblem(result)
    if (problem) { message.error(problemText(problem)); return }
    reportInstalled(result.plugin_name || identifier, result)
    showSource.value = false
    sourceText.value = ''
    await afterChange()
  } catch (err: any) {
    message.error(err?.message || t('hermesExtensions.hub.installFailed'))
  } finally {
    sourceBusy.value = false
  }
}

defineExpose({ load })
void load()
</script>

<template>
  <div class="hub-panel">
    <NAlert type="info" :bordered="false" class="plugins-notice">{{ t('hermesExtensions.hub.intro') }}</NAlert>
    <NAlert v-if="error" type="error" class="plugins-notice">{{ error }}</NAlert>

    <div class="hub-toolbar">
      <div class="hub-auto">
        <NSwitch :value="!!autoUpdate" :loading="autoUpdateBusy" :disabled="autoUpdate === null" size="small" @update:value="toggleAutoUpdate" />
        <span>{{ t('hermesExtensions.hub.autoUpdate') }}</span>
      </div>
      <span class="spacer" />
      <NButton size="small" :loading="updatingAll" :disabled="!installedCount" @click="updateAll">
        {{ t('hermesExtensions.hub.updateAll') }}<template v-if="updatesCount"> ({{ updatesCount }})</template>
      </NButton>
      <NButton size="small" @click="showSource = true">{{ t('hermesExtensions.hub.installFromSource') }}</NButton>
      <NButton size="small" quaternary :loading="loading" @click="load">{{ t('hermesExtensions.common.refresh') }}</NButton>
    </div>

    <div class="filter-row">
      <NInput v-model:value="query" :placeholder="t('hermesExtensions.hub.search')" clearable />
      <NSelect v-model:value="category" :options="categoryOptions" :placeholder="t('hermesExtensions.hub.categoryTitle')" clearable />
      <NSelect v-model:value="tier" :options="tierOptions" :placeholder="t('hermesExtensions.hub.tierTitle')" clearable />
      <NSelect v-model:value="show" :options="showOptions" />
    </div>

    <div v-if="loading && !loaded" class="hub-loading"><NSpin /></div>
    <template v-else-if="filtered.length">
      <div class="hub-count">{{ t('hermesExtensions.hub.count', { shown: visible.length, total: filtered.length }) }}</div>
      <div class="hub-grid">
        <div v-for="entry in visible" :key="entry.name" class="hub-card">
          <div class="hub-head">
            <div class="hub-title">
              <strong>{{ entry.title || entry.name }}</strong>
              <span v-if="entry.title && entry.title !== entry.name" class="hub-sub">{{ entry.name }}</span>
            </div>
            <div class="hub-tags">
              <NTag v-if="props.recommended.includes(entry.name)" size="small" type="info" round>{{ t('recommendedPlugins.badge') }}</NTag>
              <NTag v-if="entry.installed" size="small" type="success" round>{{ t('hermesExtensions.common.installed') }}</NTag>
              <NTag v-if="entry.update_available" size="small" type="warning" round>{{ t('hermesExtensions.hub.updateAvailable') }}</NTag>
              <NTag size="small" round :type="tierType(entry.tier)">{{ label('tier', entry.tier) }}</NTag>
            </div>
          </div>
          <p class="hub-desc" :title="entry.description">{{ entry.description }}</p>
          <div class="hub-meta">
            <span>{{ label('category', entry.category) }}</span>
            <span v-if="entry.maintainer">{{ entry.maintainer }}</span>
            <span v-if="entry.version">v{{ entry.version }}</span>
            <span v-if="entry.capabilities?.requires_env?.length">{{ t('hermesExtensions.hub.needsKeys', { keys: entry.capabilities.requires_env.join(', ') }) }}</span>
          </div>
          <div v-if="entry.installed && props.missingEnv[entry.name]?.length" class="hub-issues">
            {{ t('recommendedPlugins.missingEnv', { keys: props.missingEnv[entry.name].join(', '), file: props.envFile }) }}
          </div>
          <div v-if="entry.known_issues?.length" class="hub-issues">{{ t('hermesExtensions.hub.knownIssues') }}: {{ entry.known_issues.join(' · ') }}</div>
          <div class="hub-actions">
            <a v-if="entry.docs_url || entry.repo" :href="entry.docs_url || entry.repo" target="_blank" rel="noopener" class="hub-link">{{ t('hermesExtensions.common.docs') }}</a>
            <span class="spacer" />
            <template v-if="entry.installed">
              <NButton v-if="entry.update_available" size="tiny" type="primary" secondary :loading="busy[entry.name] === 'update'" @click="update(entry.name)">
                {{ t('hermesExtensions.hub.update') }}
              </NButton>
              <NPopconfirm @positive-click="remove(entry)">
                <template #trigger>
                  <NButton size="tiny" quaternary type="error" :loading="busy[entry.name] === 'remove'">{{ t('hermesExtensions.hub.uninstall') }}</NButton>
                </template>
                {{ t('hermesExtensions.hub.uninstallConfirm', { name: entry.name }) }}
              </NPopconfirm>
            </template>
            <NButton v-else size="tiny" type="primary" :loading="busy[entry.name] === 'install'" @click="install(entry)">
              {{ t('hermesExtensions.common.install') }}
            </NButton>
          </div>
        </div>
      </div>
      <div v-if="filtered.length > visible.length" class="hub-more">
        <NButton size="small" @click="limit += PAGE">{{ t('hermesExtensions.hub.showMore') }}</NButton>
      </div>
    </template>
    <NEmpty v-else-if="loaded" :description="t('hermesExtensions.common.noMatch')" />

    <NModal v-model:show="showSource" preset="card" :title="t('hermesExtensions.hub.installFromSource')" :style="{ width: 'min(520px, calc(100vw - 32px))' }">
      <p class="source-help">{{ t('hermesExtensions.hub.sourceHelp') }}</p>
      <NInput v-model:value="sourceText" placeholder="https://github.com/owner/plugin" @keydown.enter="installFromSource" />
      <div class="source-actions">
        <NButton @click="showSource = false">{{ t('hermesExtensions.common.cancel') }}</NButton>
        <NButton type="primary" :loading="sourceBusy" :disabled="!sourceText.trim()" @click="installFromSource">{{ t('hermesExtensions.common.install') }}</NButton>
      </div>
    </NModal>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;
@use '@/styles/plugins-page' as plugins-page;
@include plugins-page.layout;

.hub-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: calc(8px * var(--spacing-scale, 1)); margin-bottom: 12px; }
.hub-auto { display: flex; align-items: center; gap: 8px; font-size: calc(var(--font-size-base, 14px) * 13 / 14); }
.spacer { flex: 1; }
.hub-loading { display: grid; place-items: center; padding: 40px 0; }
.hub-count { color: $text-muted; font-size: calc(var(--font-size-base, 14px) * 12 / 14); margin-bottom: 8px; }
.hub-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 320px), 1fr)); gap: calc(12px * var(--spacing-scale, 1)); }
.hub-card {
  display: flex; flex-direction: column; gap: calc(8px * var(--spacing-scale, 1));
  padding: calc(14px * var(--spacing-scale, 1));
  border: var(--border-width, 1px) solid $border-color; border-radius: $radius-md;
  background: var(--theme-card-bg, $bg-card);
}
.hub-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 8px; }
.hub-title { display: flex; flex-direction: column; min-width: 0; word-break: break-word; }
.hub-sub { color: $text-muted; font-size: calc(var(--font-size-base, 14px) * 12 / 14); }
.hub-tags { display: flex; gap: 4px; flex-wrap: wrap; justify-content: flex-end; }
.hub-desc {
  margin: 0; flex: 1; color: $text-secondary; font-size: calc(var(--font-size-base, 14px) * 13 / 14);
  display: -webkit-box; -webkit-line-clamp: 4; line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden;
}
.hub-meta { display: flex; flex-wrap: wrap; gap: 4px 12px; color: $text-muted; font-size: calc(var(--font-size-base, 14px) * 12 / 14); }
.hub-issues { color: $warning; font-size: calc(var(--font-size-base, 14px) * 12 / 14); }
.hub-actions { display: flex; align-items: center; gap: 6px; }
.hub-link { color: $accent-primary; font-size: calc(var(--font-size-base, 14px) * 12 / 14); text-decoration: none; }
.hub-more { display: flex; justify-content: center; margin-top: 16px; }
.source-help { margin: 0 0 10px; color: $text-secondary; font-size: calc(var(--font-size-base, 14px) * 13 / 14); }
.source-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
</style>
