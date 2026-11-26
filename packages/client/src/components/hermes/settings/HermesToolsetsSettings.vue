<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { NButton, NEmpty, NInput, NModal, NSelect, NSpin, NSwitch, NTag, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import SettingRow from './SettingRow.vue'
import HermesActionLog from './HermesActionLog.vue'
import { useHermesAction } from './useHermesAction'
import {
  filledKeys, getToolsetConfig, getToolsetModels, listToolsets, runToolsetSetup, saveToolsetKeys,
  setToolsetEnabled, setToolsetModel, setToolsetProvider,
  type Toolset, type ToolsetConfig, type ToolsetModels, type ToolsetProvider,
} from '@/api/hermes/agent-tools'

const { t } = useI18n()
const message = useMessage()

const loading = ref(true)
const loadError = ref('')
const toolsets = ref<Toolset[]>([])
const toggling = ref<Record<string, boolean>>({})

async function load() {
  loading.value = true
  loadError.value = ''
  try {
    toolsets.value = await listToolsets()
  } catch (err: any) {
    loadError.value = err?.message || String(err)
  } finally {
    loading.value = false
  }
}

async function toggle(toolset: Toolset, enabled: boolean) {
  toggling.value = { ...toggling.value, [toolset.name]: true }
  try {
    const result = await setToolsetEnabled(toolset.name, enabled)
    toolset.enabled = enabled
    message.success(result.post_setup_started ? t('hermesTools.tools.installing') : t('settings.saved'))
  } catch (err: any) {
    message.error(err?.message || t('settings.saveFailed'))
  } finally {
    toggling.value = { ...toggling.value, [toolset.name]: false }
  }
}

// ---- Configure dialog ----
const editing = ref<Toolset | null>(null)
const config = ref<ToolsetConfig | null>(null)
const models = ref<ToolsetModels | null>(null)
const configLoading = ref(false)
const viewedProvider = ref<string | null>(null)
const keyValues = ref<Record<string, string>>({})
const savingKeys = ref(false)
const setup = useHermesAction('tools-post-setup')

const showConfig = computed({
  get: () => editing.value !== null,
  set: (open: boolean) => { if (!open) editing.value = null },
})

const provider = computed<ToolsetProvider | null>(() =>
  config.value?.providers.find(p => p.name === viewedProvider.value) || null)

const providerOptions = computed(() => (config.value?.providers || []).map(p => ({
  label: p.is_active ? `${p.name} · ${t('hermesTools.tools.inUse')}` : p.name,
  value: p.name,
})))

const isWeb = computed(() => editing.value?.name === 'web')
const capabilityOptions = (capability: 'search' | 'extract') => (config.value?.providers || [])
  .filter(p => (p.capabilities || []).includes(capability))
  .map(p => ({ label: p.name, value: p.name }))
const webSearch = computed(() => (config.value?.providers || []).find(p => p.web_backend === config.value?.active_search_backend)?.name || config.value?.active_search_backend || null)
const webExtract = computed(() => (config.value?.providers || []).find(p => p.web_backend === config.value?.active_extract_backend)?.name || config.value?.active_extract_backend || null)

async function loadConfig(name: string) {
  configLoading.value = true
  try {
    config.value = await getToolsetConfig(name)
    viewedProvider.value = viewedProvider.value && config.value.providers.some(p => p.name === viewedProvider.value)
      ? viewedProvider.value
      : config.value.active_provider || config.value.providers[0]?.name || null
    models.value = await getToolsetModels(name).catch(() => null)
  } catch (err: any) {
    message.error(err?.message || String(err))
  } finally {
    configLoading.value = false
  }
}

function openConfig(toolset: Toolset) {
  editing.value = toolset
  config.value = null
  models.value = null
  viewedProvider.value = null
  keyValues.value = {}
  void loadConfig(toolset.name)
}

async function useProvider(name: string, capability?: 'search' | 'extract') {
  if (!editing.value) return
  try {
    const result = await setToolsetProvider(editing.value.name, name, capability)
    message.success(result.needs_nous_auth ? t('hermesTools.tools.needsNousLogin') : t('settings.saved'))
    viewedProvider.value = name
    await loadConfig(editing.value.name)
    await load()
  } catch (err: any) {
    message.error(err?.message || t('settings.saveFailed'))
  }
}

async function saveKeys() {
  if (!editing.value) return
  const env = filledKeys(keyValues.value)
  if (!Object.keys(env).length) return
  savingKeys.value = true
  try {
    await saveToolsetKeys(editing.value.name, env)
    keyValues.value = {}
    message.success(t('settings.saved'))
    await loadConfig(editing.value.name)
    await load()
  } catch (err: any) {
    message.error(err?.message || t('settings.saveFailed'))
  } finally {
    savingKeys.value = false
  }
}

async function chooseModel(model: string) {
  if (!editing.value) return
  try {
    await setToolsetModel(editing.value.name, model, provider.value?.name)
    if (models.value) models.value.current = model
    message.success(t('settings.saved'))
  } catch (err: any) {
    message.error(err?.message || t('settings.saveFailed'))
  }
}

function install() {
  if (!editing.value || !provider.value?.post_setup) return
  const name = editing.value.name
  const key = provider.value.post_setup
  void setup.run(() => runToolsetSetup(name, key))
}

function statusType(status?: string) {
  return status === 'ready' || status === 'active' ? 'success' : 'warning'
}

onMounted(load)
</script>

<template>
  <section class="settings-section">
    <div class="section-head">
      <div>
        <h3 class="section-title">{{ t('hermesTools.tools.title') }}</h3>
        <p class="section-hint">{{ t('hermesTools.tools.hint') }}</p>
      </div>
      <NButton size="small" :loading="loading" @click="load">{{ t('hermesTools.common.refresh') }}</NButton>
    </div>

    <NSpin :show="loading && !toolsets.length">
      <p v-if="loadError" class="muted">{{ t('hermesTools.common.unavailable') }} {{ loadError }}</p>
      <NEmpty v-else-if="!loading && !toolsets.length" :description="t('hermesTools.tools.empty')" />
      <SettingRow
        v-for="toolset in toolsets"
        :key="toolset.name"
        :label="toolset.label"
        :hint="toolset.description"
      >
        <div class="row-actions">
          <NTag v-if="!toolset.configured" size="small" type="warning" :bordered="false">{{ t('hermesTools.tools.needsSetup') }}</NTag>
          <NTag v-if="toolset.platform !== 'cli'" size="small" :bordered="false">{{ toolset.platform_label }}</NTag>
          <NButton size="small" quaternary data-testid="toolset-configure" @click="openConfig(toolset)">{{ t('hermesTools.tools.configure') }}</NButton>
          <NSwitch
            :value="toolset.enabled"
            :loading="toggling[toolset.name]"
            @update:value="(value: boolean) => toggle(toolset, value)"
          />
        </div>
      </SettingRow>
    </NSpin>

    <NModal
      v-model:show="showConfig"
      preset="card"
      :title="editing?.label || ''"
      style="width: min(640px, calc(100vw - 32px))"
      :bordered="false"
    >
      <NSpin :show="configLoading">
        <p class="section-hint">{{ editing?.description }}</p>
        <p v-if="editing?.tools?.length" class="muted">{{ t('hermesTools.tools.includes') }} {{ editing.tools.join(', ') }}</p>

        <template v-if="config && !config.has_category">
          <p class="section-hint">{{ t('hermesTools.tools.nothingToConfigure') }}</p>
        </template>

        <template v-else-if="config">
          <template v-if="isWeb">
            <SettingRow :label="t('hermesTools.tools.webSearchWith')">
              <NSelect class="input-md" size="small" :value="webSearch" :options="capabilityOptions('search')" @update:value="(v: string) => useProvider(v, 'search')" />
            </SettingRow>
            <SettingRow :label="t('hermesTools.tools.webReadWith')">
              <NSelect class="input-md" size="small" :value="webExtract" :options="capabilityOptions('extract')" @update:value="(v: string) => useProvider(v, 'extract')" />
            </SettingRow>
          </template>

          <SettingRow :label="t('hermesTools.tools.provider')" :hint="t('hermesTools.tools.providerHint')">
            <NSelect v-model:value="viewedProvider" class="input-md" size="small" :options="providerOptions" />
          </SettingRow>

          <template v-if="provider">
            <SettingRow :label="provider.name" :hint="provider.tag || provider.badge || ''">
              <div class="row-actions">
                <NTag size="small" :type="statusType(provider.status)" :bordered="false">
                  {{ provider.status === 'ready' ? t('hermesTools.tools.ready') : t('hermesTools.tools.needsSetup') }}
                </NTag>
                <NButton v-if="!provider.is_active && !isWeb" size="small" type="primary" @click="useProvider(provider.name)">{{ t('hermesTools.tools.useThis') }}</NButton>
                <NTag v-else-if="provider.is_active" size="small" type="success" :bordered="false">{{ t('hermesTools.tools.inUse') }}</NTag>
              </div>
            </SettingRow>
            <p v-if="provider.requires_nous_auth" class="muted">{{ t('hermesTools.tools.needsNousLogin') }}</p>

            <SettingRow
              v-for="envVar in provider.env_vars"
              :key="envVar.key"
              :label="envVar.prompt || envVar.key"
              :hint="envVar.key"
            >
              <div class="row-actions">
                <NInput
                  v-model:value="keyValues[envVar.key]"
                  type="password"
                  show-password-on="click"
                  size="small"
                  class="input-md"
                  autocomplete="off"
                  :placeholder="envVar.is_set ? t('hermesTools.tools.keySaved') : t('hermesTools.tools.keyMissing')"
                />
                <a v-if="envVar.url" :href="envVar.url" target="_blank" rel="noopener noreferrer" class="muted">{{ t('hermesTools.tools.getKey') }}</a>
              </div>
            </SettingRow>
            <div v-if="provider.env_vars.length" class="row-actions dialog-actions">
              <span class="muted">{{ t('hermesTools.tools.keysNeverShown') }}</span>
              <NButton size="small" type="primary" :loading="savingKeys" :disabled="!Object.keys(filledKeys(keyValues)).length" @click="saveKeys">{{ t('hermesTools.tools.saveKeys') }}</NButton>
            </div>

            <SettingRow v-if="provider.post_setup" :label="t('hermesTools.tools.install')" :hint="t('hermesTools.tools.installHint')">
              <NButton size="small" :loading="setup.running.value" @click="install">{{ t('hermesTools.tools.install') }}</NButton>
            </SettingRow>
            <HermesActionLog
              :lines="setup.lines.value"
              :running="setup.running.value"
              :exit-code="setup.exitCode.value"
              :finished="setup.finished.value"
              :error="setup.error.value"
            />
          </template>

          <SettingRow v-if="models?.has_models" :label="t('hermesTools.tools.model')">
            <NSelect
              class="input-md"
              size="small"
              :value="models.current"
              :options="models.models.map(m => ({ label: m.display || m.id, value: m.id }))"
              @update:value="chooseModel"
            />
          </SettingRow>
        </template>
      </NSpin>
    </NModal>
  </section>
</template>

<style scoped lang="scss">
@use './hermes-tools' as *;

.dialog-actions {
  justify-content: flex-end;
  padding: 8px 0;
}
</style>
