<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { NButton, NInput, NInputNumber, NModal, NSelect, NSpin, NSwitch, NTag, useDialog, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import {
  buildSubmitValues, fieldVisible, getMemoryOverview, getMemoryProviderConfig, initialFieldValue, providerLabel,
  providerStatusType, resetBuiltinMemory, runMemoryProviderSetup, saveMemoryProviderConfig, setMemoryProvider,
  type MemoryOverview, type MemoryProviderConfig, type MemoryProviderRow, type MemoryProviderSetupResult,
} from '@/api/hermes/agent-memory'

const emit = defineEmits<{ filesCleared: [] }>()

const BUILTIN = ''
const { t } = useI18n()
const message = useMessage()
const dialog = useDialog()

const overview = ref<MemoryOverview | null>(null)
const loadError = ref(false)
const showModal = ref(false)
const selected = ref<string>(BUILTIN)
const config = ref<MemoryProviderConfig | null>(null)
const configLoading = ref(false)
const values = ref<Record<string, any>>({})
const busy = ref<'' | 'save' | 'setup' | 'use' | 'clear'>('')
const setupResult = ref<MemoryProviderSetupResult | null>(null)

const active = computed(() => overview.value?.active || BUILTIN)
const activeRow = computed(() => overview.value?.providers.find(p => p.name === active.value) || null)
const selectedRow = computed<MemoryProviderRow | null>(() => overview.value?.providers.find(p => p.name === selected.value) || null)
const visibleFields = computed(() => (config.value?.fields || []).filter(f => fieldVisible(f, values.value)))
const requirements = computed(() => {
  const setup = selectedRow.value?.setup
  if (!setup) return [] as string[]
  return [
    ...(setup.external_dependencies || []).map(d => d.name),
    ...(setup.pip_dependencies || []),
    ...(setup.required_env || []),
  ]
})
const canInstall = computed(() => selectedRow.value?.setup?.dependencies_installed === false)

function statusLabel(status: string): string {
  switch (status) {
    case 'ready': return t('hermesMemory.statusReady')
    case 'needs_config': return t('hermesMemory.statusNeedsConfig')
    case 'unavailable': return t('hermesMemory.statusUnavailable')
    case 'missing': return t('hermesMemory.statusMissing')
    default: return status.replace(/_/g, ' ')
  }
}

function errorText(err: any): string {
  return String(err?.message || err || '').replace(/^API Error \d+:\s*/, '') || t('hermesMemory.actionFailed')
}

async function load() {
  try {
    overview.value = await getMemoryOverview()
    loadError.value = false
  } catch (err) {
    console.error('Failed to load memory providers:', err)
    loadError.value = true
  }
}

async function selectProvider(name: string) {
  selected.value = name
  setupResult.value = null
  config.value = null
  values.value = {}
  if (name === BUILTIN) return
  configLoading.value = true
  try {
    const loaded = await getMemoryProviderConfig(name)
    if (selected.value !== name) return
    config.value = loaded
    values.value = Object.fromEntries(loaded.fields.map(f => [f.key, initialFieldValue(f)]))
  } catch (err) {
    message.error(errorText(err))
  } finally {
    configLoading.value = false
  }
}

function openManage() {
  showModal.value = true
  void selectProvider(active.value)
}

async function useSelected() {
  busy.value = 'use'
  try {
    await setMemoryProvider(selected.value)
    message.success(t('hermesMemory.switched', { name: selected.value ? providerLabel(selected.value) : t('hermesMemory.builtin') }))
    await load()
  } catch (err) {
    message.error(errorText(err))
  } finally {
    busy.value = ''
  }
}

async function saveAndUse() {
  if (!config.value) return
  busy.value = 'save'
  try {
    await saveMemoryProviderConfig(config.value.name, config.value.surface, buildSubmitValues(config.value.fields, values.value))
    message.success(t('hermesMemory.switched', { name: providerLabel(config.value.name) }))
    await load()
    await selectProvider(config.value.name)
  } catch (err) {
    message.error(errorText(err))
    await load()
  } finally {
    busy.value = ''
  }
}

async function installRequirements() {
  const name = selected.value
  busy.value = 'setup'
  setupResult.value = null
  try {
    const result = await runMemoryProviderSetup(name)
    setupResult.value = result
    if (result.ok) message.success(t('hermesMemory.setupDone'))
    else message.error(t('hermesMemory.setupFailed'))
    await load()
  } catch (err) {
    message.error(errorText(err))
  } finally {
    busy.value = ''
  }
}

function clearFiles() {
  dialog.warning({
    title: t('hermesMemory.clearFiles'),
    content: t('hermesMemory.clearConfirm'),
    positiveText: t('hermesMemory.clearFiles'),
    negativeText: t('common.cancel'),
    onPositiveClick: async () => {
      busy.value = 'clear'
      try {
        await resetBuiltinMemory('all')
        message.success(t('hermesMemory.cleared'))
        emit('filesCleared')
        await load()
      } catch (err) {
        message.error(errorText(err))
      } finally {
        busy.value = ''
      }
    },
  })
}

function selectOptions(field: MemoryProviderConfig['fields'][number]) {
  return (field.options || []).map(o => ({ label: o.label || o.value, value: o.value }))
}

onMounted(load)
defineExpose({ load })
</script>

<template>
  <div v-if="overview || loadError" class="provider-bar">
    <div class="provider-bar-main">
      <span class="provider-icon">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <ellipse cx="12" cy="5" rx="9" ry="3" /><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" /><path d="M3 12c0 1.66 4 3 9 3s9-1.34 9-3" />
        </svg>
      </span>
      <span class="provider-caption">{{ t('hermesMemory.provider') }}</span>
      <template v-if="overview">
        <span class="provider-name">{{ active ? providerLabel(active) : t('hermesMemory.builtin') }}</span>
        <NTag v-if="activeRow && activeRow.status !== 'ready'" size="small" round :bordered="false" :type="providerStatusType(activeRow.status)">
          {{ statusLabel(activeRow.status) }}
        </NTag>
        <span class="provider-desc">{{ activeRow?.description || t('hermesMemory.builtinDesc') }}</span>
      </template>
      <span v-else class="provider-desc">{{ t('hermesMemory.loadFailed') }}</span>
    </div>
    <NButton size="tiny" quaternary :disabled="!overview" @click="openManage">{{ t('hermesMemory.manage') }}</NButton>
  </div>

  <NModal v-model:show="showModal" preset="card" :title="t('hermesMemory.provider')" class="memory-provider-modal" style="width: min(760px, calc(100vw - 32px))">
    <div v-if="overview" class="provider-modal">
      <div class="provider-list" role="listbox">
        <button class="provider-item" :class="{ selected: selected === BUILTIN }" role="option" :aria-selected="selected === BUILTIN" @click="selectProvider(BUILTIN)">
          <span class="item-name">{{ t('hermesMemory.builtin') }}</span>
          <NTag v-if="active === BUILTIN" size="tiny" round :bordered="false" type="info">{{ t('hermesMemory.inUse') }}</NTag>
        </button>
        <button
          v-for="row in overview.providers"
          :key="row.name"
          class="provider-item"
          :class="{ selected: selected === row.name }"
          role="option"
          :aria-selected="selected === row.name"
          @click="selectProvider(row.name)"
        >
          <span class="item-name">{{ providerLabel(row.name) }}</span>
          <NTag v-if="active === row.name" size="tiny" round :bordered="false" type="info">{{ t('hermesMemory.inUse') }}</NTag>
          <NTag v-else size="tiny" round :bordered="false" :type="providerStatusType(row.status)">{{ statusLabel(row.status) }}</NTag>
        </button>
        <p v-if="!overview.providers.length" class="muted small">{{ t('hermesMemory.noProviders') }}</p>
      </div>

      <div class="provider-detail">
        <template v-if="selected === BUILTIN">
          <h3 class="detail-title">{{ t('hermesMemory.builtin') }}</h3>
          <p class="muted">{{ t('hermesMemory.builtinDesc') }}</p>
          <div class="detail-actions">
            <NButton size="small" :loading="busy === 'clear'" :disabled="!!busy || !(overview.builtin_files.memory || overview.builtin_files.user)" @click="clearFiles">
              {{ t('hermesMemory.clearFiles') }}
            </NButton>
            <NButton v-if="active !== BUILTIN" size="small" type="primary" :loading="busy === 'use'" :disabled="!!busy" @click="useSelected">
              {{ t('hermesMemory.useThis') }}
            </NButton>
          </div>
        </template>

        <template v-else-if="selectedRow">
          <div class="detail-head">
            <h3 class="detail-title">{{ config?.label && config.label !== selectedRow.name ? config.label : providerLabel(selectedRow.name) }}</h3>
            <NTag size="small" round :bordered="false" :type="providerStatusType(selectedRow.status)">{{ statusLabel(selectedRow.status) }}</NTag>
            <a v-if="config?.docs_url" :href="config.docs_url" target="_blank" rel="noopener" class="docs-link">{{ t('hermesMemory.docs') }}</a>
          </div>
          <p class="muted">{{ selectedRow.description }}</p>

          <div v-if="requirements.length" class="requirements">
            <span class="field-label">{{ t('hermesMemory.requirements') }}</span>
            <span class="muted small">{{ requirements.join(', ') }}</span>
            <NButton v-if="canInstall" size="tiny" :loading="busy === 'setup'" :disabled="!!busy" @click="installRequirements">{{ t('hermesMemory.runSetup') }}</NButton>
          </div>
          <div v-if="setupResult" class="setup-results">
            <div v-for="(row, i) in setupResult.results" :key="i" class="setup-row">
              <NTag size="tiny" :bordered="false" :type="row.status === 'failed' ? 'error' : row.status === 'missing' ? 'warning' : 'success'">{{ row.status.replace(/_/g, ' ') }}</NTag>
              <code>{{ row.command || row.name }}</code>
              <pre v-if="row.status === 'failed' && (row.stderr || row.stdout)">{{ row.stderr || row.stdout }}</pre>
            </div>
          </div>

          <NSpin :show="configLoading">
            <div class="fields">
              <p v-if="config && !config.fields.length" class="muted small">{{ t('hermesMemory.noSettings') }}</p>
              <label v-for="field in visibleFields" :key="field.key" class="field">
                <span class="field-label">
                  {{ field.label }}<span v-if="field.required" class="required">*</span>
                  <a v-if="field.url" :href="field.url" target="_blank" rel="noopener" class="docs-link">↗</a>
                </span>
                <NSwitch v-if="field.kind === 'boolean' || field.kind === 'bool'" v-model:value="values[field.key]" size="small" />
                <NSelect v-else-if="field.kind === 'select'" v-model:value="values[field.key]" size="small" :options="selectOptions(field)" />
                <NInputNumber
                  v-else-if="field.kind === 'integer' || field.kind === 'number'"
                  v-model:value="values[field.key]"
                  size="small"
                  :min="field.minimum ?? undefined"
                  :max="field.maximum ?? undefined"
                  :step="field.step ?? 1"
                  :placeholder="field.placeholder || ''"
                />
                <NInput
                  v-else-if="field.kind === 'secret'"
                  v-model:value="values[field.key]"
                  size="small"
                  type="password"
                  show-password-on="click"
                  autocomplete="off"
                  :placeholder="field.is_set ? t('hermesMemory.secretKeep') : (field.placeholder || t('hermesMemory.secretUnset'))"
                />
                <NInput
                  v-else
                  v-model:value="values[field.key]"
                  size="small"
                  :type="field.kind === 'json' ? 'textarea' : 'text'"
                  :autosize="field.kind === 'json' ? { minRows: 2, maxRows: 6 } : undefined"
                  :placeholder="field.placeholder || ''"
                />
                <span v-if="field.description" class="muted small">{{ field.description }}</span>
              </label>
            </div>
          </NSpin>

          <div class="detail-actions">
            <NButton
              v-if="config && config.fields.length"
              size="small"
              type="primary"
              :loading="busy === 'save'"
              :disabled="!!busy || configLoading"
              @click="saveAndUse"
            >
              {{ t('hermesMemory.saveAndUse') }}
            </NButton>
            <NButton
              v-else-if="active !== selectedRow.name"
              size="small"
              type="primary"
              :loading="busy === 'use'"
              :disabled="!!busy || selectedRow.status !== 'ready'"
              @click="useSelected"
            >
              {{ t('hermesMemory.useThis') }}
            </NButton>
          </div>
        </template>
      </div>
    </div>
  </NModal>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.provider-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: calc(12px * var(--spacing-scale, 1));
  padding: calc(8px * var(--spacing-scale, 1)) calc(16px * var(--spacing-scale, 1));
  margin-bottom: calc(16px * var(--spacing-scale, 1));
  border: var(--border-width, 1px) solid $border-color;
  border-radius: $radius-md;
  background: $bg-secondary;
  flex-shrink: 0;
}

.provider-bar-main {
  display: flex;
  align-items: center;
  gap: calc(8px * var(--spacing-scale, 1));
  min-width: 0;
}

.provider-icon {
  color: $text-secondary;
  display: flex;
}

.provider-caption {
  font-size: calc(var(--font-size-base, 14px) * 13 / 14);
  color: $text-secondary;
  white-space: nowrap;
}

.provider-name {
  font-size: calc(var(--font-size-base, 14px) * 14 / 14);
  font-weight: 600;
  color: $text-primary;
  white-space: nowrap;
}

.provider-desc {
  font-size: calc(var(--font-size-base, 14px) * 12 / 14);
  color: $text-muted;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;

  @media (max-width: $breakpoint-mobile) {
    display: none;
  }
}

.provider-modal {
  display: flex;
  gap: calc(16px * var(--spacing-scale, 1));
  min-height: 320px;

  @media (max-width: $breakpoint-mobile) {
    flex-direction: column;
  }
}

.provider-list {
  width: 200px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;

  @media (max-width: $breakpoint-mobile) {
    width: 100%;
  }
}

.provider-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: calc(6px * var(--spacing-scale, 1)) calc(10px * var(--spacing-scale, 1));
  border: none;
  border-radius: $radius-sm;
  background: none;
  color: $text-primary;
  text-align: start;
  cursor: pointer;
  font-size: calc(var(--font-size-base, 14px) * 13 / 14);

  &:hover {
    background: $bg-secondary;
  }

  &.selected {
    background: rgba(var(--accent-primary-rgb), 0.1);
    color: $accent-primary;
  }
}

.item-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.provider-detail {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: calc(10px * var(--spacing-scale, 1));
}

.detail-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.detail-title {
  margin: 0;
  font-size: calc(var(--font-size-base, 14px) * 15 / 14);
  font-weight: 600;
  color: $text-primary;
}

.muted {
  margin: 0;
  color: $text-muted;
  font-size: calc(var(--font-size-base, 14px) * 13 / 14);
}

.small {
  font-size: calc(var(--font-size-base, 14px) * 12 / 14);
}

.docs-link {
  color: $accent-primary;
  font-size: calc(var(--font-size-base, 14px) * 12 / 14);
  text-decoration: none;
  margin-inline-start: 4px;
}

.requirements {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.setup-results {
  display: flex;
  flex-direction: column;
  gap: 4px;

  code {
    font-family: var(--font-code, $font-code);
    font-size: calc(var(--font-size-base, 14px) * 12 / 14);
    color: $text-secondary;
    margin-inline-start: 6px;
    word-break: break-all;
  }

  pre {
    margin: 4px 0 0;
    max-height: 120px;
    overflow: auto;
    font-size: calc(var(--font-size-base, 14px) * 11 / 14);
    color: $text-muted;
    white-space: pre-wrap;
  }
}

.fields {
  display: flex;
  flex-direction: column;
  gap: calc(12px * var(--spacing-scale, 1));
}

.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.field-label {
  font-size: calc(var(--font-size-base, 14px) * 13 / 14);
  font-weight: 500;
  color: $text-primary;
}

.required {
  color: $error;
  margin-inline-start: 2px;
}

.detail-actions {
  display: flex;
  justify-content: flex-end;
  gap: calc(8px * var(--spacing-scale, 1));
  margin-top: auto;
  padding-top: 8px;
}
</style>
