<script setup lang="ts">
import { computed, defineAsyncComponent, onMounted, ref } from 'vue'
import { NButton, NEmpty, NInput, NSelect, NSpin, NTag, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import {
  getHubSources, getOfficialCatalog, hubInstalledEntry, installHubSkill, previewHubSkill, searchHub, uninstallHubSkill, waitForAction,
  type HubPreview, type HubSkill, type HubSources,
} from '@/api/hermes/agent-memory'

const MarkdownRenderer = defineAsyncComponent(async () => (await import('@/components/hermes/chat/MarkdownRenderer.vue')).default)

const emit = defineEmits<{ changed: [] }>()
const { t } = useI18n()
const message = useMessage()

const sources = ref<HubSources | null>(null)
const catalog = ref<HubSkill[]>([])
const installed = ref<HubSources['installed']>({})
const loading = ref(false)
const query = ref('')
const source = ref('all')
const searching = ref(false)
const searchResults = ref<HubSkill[] | null>(null)
const timedOut = ref<string[]>([])
const pending = ref<Record<string, 'install' | 'uninstall'>>({})
const preview = ref<HubPreview | null>(null)
const previewLoading = ref(false)

const sourceOptions = computed(() => [
  { label: t('hermesMemory.allSources'), value: 'all' },
  ...(sources.value?.sources || []).filter(s => s.searchable !== false && s.id !== 'url').map(s => ({ label: s.label, value: s.id })),
])

/** Without a search: the official catalog, filtered by the typed text. */
const officialFiltered = computed(() => {
  const q = query.value.trim().toLowerCase()
  if (!q) return catalog.value
  return catalog.value.filter(s => `${s.name} ${s.description} ${s.category || ''} ${(s.tags || []).join(' ')}`.toLowerCase().includes(q))
})
const rows = computed(() => searchResults.value ?? officialFiltered.value)

function errorText(err: any): string {
  return String(err?.message || err || '').replace(/^API Error \d+:\s*/, '') || t('hermesMemory.actionFailed')
}

function trustLabel(level: string) {
  if (level === 'builtin') return t('hermesMemory.trustBuiltin')
  if (level === 'trusted') return t('hermesMemory.trustTrusted')
  return t('hermesMemory.trustCommunity')
}

function isInstalled(skill: HubSkill) {
  return !!hubInstalledEntry(skill, installed.value)
}

async function load() {
  loading.value = true
  try {
    const [src, official] = await Promise.all([getHubSources(), getOfficialCatalog()])
    sources.value = src
    installed.value = src.installed || {}
    catalog.value = official.skills || []
  } catch (err) {
    message.error(errorText(err))
  } finally {
    loading.value = false
  }
}

async function refreshInstalled() {
  try {
    const src = await getHubSources()
    installed.value = src.installed || {}
    const official = await getOfficialCatalog()
    catalog.value = official.skills || []
  } catch { /* the list just stays as it was */ }
}

async function runSearch() {
  const q = query.value.trim()
  if (!q) {
    searchResults.value = null
    timedOut.value = []
    return
  }
  searching.value = true
  try {
    const res = await searchHub(q, source.value)
    searchResults.value = res.results || []
    timedOut.value = res.timed_out || []
    installed.value = { ...installed.value, ...(res.installed || {}) }
  } catch (err) {
    message.error(errorText(err))
  } finally {
    searching.value = false
  }
}

function onQueryInput(value: string) {
  query.value = value
  if (!value.trim()) {
    searchResults.value = null
    timedOut.value = []
  }
}

async function install(skill: HubSkill) {
  pending.value = { ...pending.value, [skill.identifier]: 'install' }
  try {
    const action = await installHubSkill(skill.identifier)
    const result = await waitForAction(action.name)
    if (result.exit_code) throw new Error(result.lines.slice(-3).join('\n'))
    message.success(t('hermesMemory.installDone', { name: skill.name }))
    await refreshInstalled()
    emit('changed')
  } catch (err) {
    message.error(errorText(err))
  } finally {
    const { [skill.identifier]: _, ...rest } = pending.value
    pending.value = rest
  }
}

async function uninstall(skill: HubSkill) {
  const entry = hubInstalledEntry(skill, installed.value)
  const name = (entry?.name as string | undefined) || skill.name
  pending.value = { ...pending.value, [skill.identifier]: 'uninstall' }
  try {
    const action = await uninstallHubSkill(name)
    const result = await waitForAction(action.name)
    if (result.exit_code) throw new Error(result.lines.slice(-3).join('\n'))
    message.success(t('hermesMemory.uninstallDone', { name }))
    await refreshInstalled()
    emit('changed')
  } catch (err) {
    message.error(errorText(err))
  } finally {
    const { [skill.identifier]: _, ...rest } = pending.value
    pending.value = rest
  }
}

async function openPreview(skill: HubSkill) {
  previewLoading.value = true
  preview.value = { ...skill, skill_md: '', files: [] }
  try {
    preview.value = await previewHubSkill(skill.identifier)
  } catch (err) {
    message.error(errorText(err))
    preview.value = null
  } finally {
    previewLoading.value = false
  }
}

onMounted(load)
</script>

<template>
  <div class="hub-panel">
    <template v-if="preview">
      <div class="preview-head">
        <NButton size="tiny" quaternary @click="preview = null">‹ {{ t('hermesMemory.back') }}</NButton>
        <span class="row-name">{{ preview.name }}</span>
        <NTag size="tiny" :bordered="false">{{ trustLabel(preview.trust_level) }}</NTag>
        <span class="spacer" />
        <NButton v-if="isInstalled(preview)" size="small" :loading="pending[preview.identifier] === 'uninstall'" :disabled="!!pending[preview.identifier]" @click="uninstall(preview)">
          {{ t('hermesMemory.uninstall') }}
        </NButton>
        <NButton v-else size="small" type="primary" :loading="pending[preview.identifier] === 'install'" :disabled="!!pending[preview.identifier]" @click="install(preview)">
          {{ pending[preview.identifier] === 'install' ? t('hermesMemory.installing') : t('hermesMemory.install') }}
        </NButton>
      </div>
      <p class="row-desc">{{ preview.description }}</p>
      <NSpin :show="previewLoading">
        <div class="preview-body">
          <MarkdownRenderer v-if="preview.skill_md" :content="preview.skill_md" />
          <p v-if="preview.files.length > 1" class="row-meta">{{ preview.files.join(' · ') }}</p>
        </div>
      </NSpin>
    </template>

    <template v-else>
      <div class="hub-search">
        <NInput :value="query" size="small" clearable :placeholder="t('hermesMemory.hubSearch')" @update:value="onQueryInput" @keydown.enter="runSearch" />
        <NSelect v-model:value="source" size="small" :options="sourceOptions" class="source-select" />
        <NButton size="small" :loading="searching" :disabled="!query.trim()" @click="runSearch">{{ t('hermesMemory.search') }}</NButton>
      </div>
      <div class="hub-section-title">{{ searchResults ? t('hermesMemory.results') : t('hermesMemory.official') }}</div>
      <p v-if="timedOut.length" class="row-meta">{{ t('hermesMemory.timedOut', { sources: timedOut.join(', ') }) }}</p>
      <NSpin :show="loading || searching">
        <div class="hub-list">
          <div v-for="skill in rows" :key="skill.identifier" class="hub-row">
            <div class="row-main" role="button" tabindex="0" @click="openPreview(skill)" @keydown.enter="openPreview(skill)">
              <div class="row-title">
                <span class="row-name">{{ skill.name }}</span>
                <NTag size="tiny" :bordered="false" :type="skill.trust_level === 'builtin' ? 'success' : skill.trust_level === 'trusted' ? 'info' : 'default'">
                  {{ trustLabel(skill.trust_level) }}
                </NTag>
                <span class="row-meta">{{ skill.category || skill.source }}</span>
              </div>
              <div class="row-desc">{{ skill.description }}</div>
            </div>
            <NButton v-if="isInstalled(skill)" size="tiny" :loading="pending[skill.identifier] === 'uninstall'" :disabled="!!pending[skill.identifier]" @click="uninstall(skill)">
              {{ t('hermesMemory.uninstall') }}
            </NButton>
            <NButton v-else size="tiny" type="primary" secondary :loading="pending[skill.identifier] === 'install'" :disabled="!!pending[skill.identifier]" @click="install(skill)">
              {{ t('hermesMemory.install') }}
            </NButton>
          </div>
          <NEmpty v-if="!loading && !searching && !rows.length" :description="t('hermesMemory.noResults')" size="small" />
        </div>
      </NSpin>
    </template>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.hub-panel {
  display: flex;
  flex-direction: column;
  gap: calc(10px * var(--spacing-scale, 1));
}

.hub-search {
  display: flex;
  gap: 8px;
}

.source-select {
  width: 140px;
  flex-shrink: 0;
}

.hub-section-title {
  font-size: calc(var(--font-size-base, 14px) * 12 / 14);
  font-weight: 600;
  color: $text-secondary;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.hub-list {
  display: flex;
  flex-direction: column;
  min-height: 80px;
}

.hub-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: calc(8px * var(--spacing-scale, 1)) 0;
  border-bottom: var(--border-width, 1px) solid $border-color;
}

.row-main {
  flex: 1;
  min-width: 0;
  cursor: pointer;

  &:hover .row-name {
    color: $accent-primary;
  }
}

.row-title {
  display: flex;
  align-items: center;
  gap: 6px;
}

.row-name {
  font-weight: 500;
  color: $text-primary;
}

.row-meta {
  margin: 0;
  font-size: calc(var(--font-size-base, 14px) * 11 / 14);
  color: $text-muted;
}

.row-desc {
  margin: 2px 0 0;
  font-size: calc(var(--font-size-base, 14px) * 12 / 14);
  color: $text-secondary;
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.preview-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.spacer {
  flex: 1;
}

.preview-body {
  min-height: 120px;
}
</style>
