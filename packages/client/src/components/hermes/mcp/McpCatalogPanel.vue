<script setup lang="ts">
import { computed, ref } from 'vue'
import { NAlert, NButton, NEmpty, NInput, NModal, NRadioButton, NRadioGroup, NSpin, NTag, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import McpOAuthConnect from './McpOAuthConnect.vue'
import {
  fetchMcpCatalog, filterMcpCatalog, installMcpCatalogEntry, type McpCatalogEntry,
} from '@/api/hermes/extensions'

/** Hermes's curated MCP servers: browse, install with one click, sign in. */
const emit = defineEmits<{ changed: [server?: string] }>()

const { t } = useI18n()
const message = useMessage()

const entries = ref<McpCatalogEntry[]>([])
const loading = ref(false)
const loaded = ref(false)
const error = ref('')
const query = ref('')
const show = ref<'all' | 'installed' | 'available'>('all')

const installing = ref<McpCatalogEntry | null>(null)
const envValues = ref<Record<string, string>>({})
const installBusy = ref(false)

const connectServer = ref('')
const showConnect = ref(false)

const filtered = computed(() => filterMcpCatalog(entries.value, query.value, show.value))
const installedCount = computed(() => entries.value.filter(e => e.installed).length)

async function load() {
  loading.value = true
  error.value = ''
  try {
    const data = await fetchMcpCatalog()
    entries.value = data.entries || []
    loaded.value = true
  } catch (err: any) {
    error.value = err?.message || t('hermesExtensions.catalog.loadFailed')
  } finally {
    loading.value = false
  }
}

function needsOAuth(entry: McpCatalogEntry) {
  return entry.auth_type === 'oauth'
}

function openInstall(entry: McpCatalogEntry) {
  installing.value = entry
  envValues.value = Object.fromEntries(entry.required_env.map(env => [env.name, '']))
}

const missingEnv = computed(() => (installing.value?.required_env || [])
  .some(env => env.required && !String(envValues.value[env.name] || '').trim()))

async function confirmInstall() {
  const entry = installing.value
  if (!entry) return
  installBusy.value = true
  try {
    const env = Object.fromEntries(Object.entries(envValues.value).filter(([, value]) => value.trim()).map(([k, v]) => [k, v.trim()]))
    const result = await installMcpCatalogEntry(entry.name, env)
    installing.value = null
    if (result.background) {
      message.info(t('hermesExtensions.catalog.installingBackground', { name: entry.name }), { duration: 6000 })
    } else {
      message.success(t('hermesExtensions.catalog.installed', { name: entry.name }))
    }
    await load()
    emit('changed', entry.name)
    if (!result.background && needsOAuth(entry)) connect(entry.name)
  } catch (err: any) {
    message.error(err?.message || t('hermesExtensions.catalog.installFailed'))
  } finally {
    installBusy.value = false
  }
}

function connect(name: string) {
  connectServer.value = name
  showConnect.value = true
}

function onConnected(name: string) {
  message.success(t('hermesExtensions.oauth.connected', { name }))
  emit('changed', name)
}

defineExpose({ load, connect })
void load()
</script>

<template>
  <div class="catalog-panel">
    <NAlert type="info" :bordered="false" class="mcp-notice">
      {{ t('hermesExtensions.catalog.intro') }}
    </NAlert>
    <NAlert v-if="error" type="error" class="mcp-notice">{{ error }}</NAlert>

    <div class="toolbar-row">
      <NInput v-model:value="query" :placeholder="t('hermesExtensions.catalog.search')" clearable size="small" class="search-input" />
      <NRadioGroup v-model:value="show" size="small">
        <NRadioButton value="all">{{ t('hermesExtensions.common.all') }} ({{ entries.length }})</NRadioButton>
        <NRadioButton value="installed">{{ t('hermesExtensions.common.installed') }} ({{ installedCount }})</NRadioButton>
        <NRadioButton value="available">{{ t('hermesExtensions.common.notInstalled') }}</NRadioButton>
      </NRadioGroup>
      <NButton size="small" quaternary :loading="loading" @click="load">{{ t('hermesExtensions.common.refresh') }}</NButton>
    </div>

    <div v-if="loading && !loaded" class="catalog-loading"><NSpin /></div>
    <div v-else-if="filtered.length" class="catalog-grid">
      <div v-for="entry in filtered" :key="entry.name" class="catalog-card" :class="{ installed: entry.installed }">
        <div class="catalog-head">
          <h3>{{ entry.name }}</h3>
          <div class="catalog-tags">
            <NTag v-if="entry.installed" size="small" type="success" round>
              {{ entry.enabled ? t('hermesExtensions.common.installed') : t('hermesExtensions.common.installedOff') }}
            </NTag>
            <NTag size="small" round :type="needsOAuth(entry) ? 'info' : 'default'">
              {{ needsOAuth(entry) ? t('hermesExtensions.catalog.signInNeeded') : t('hermesExtensions.catalog.noSignIn') }}
            </NTag>
          </div>
        </div>
        <p class="catalog-desc">{{ entry.description }}</p>
        <div v-if="entry.url" class="catalog-url" :title="entry.url">{{ entry.url }}</div>
        <div class="catalog-actions">
          <a v-if="entry.source && /^https?:/.test(entry.source)" :href="entry.source" target="_blank" rel="noopener" class="catalog-link">
            {{ t('hermesExtensions.common.docs') }}
          </a>
          <span class="spacer" />
          <NButton v-if="entry.installed && needsOAuth(entry)" size="tiny" secondary type="primary" @click="connect(entry.name)">
            {{ t('hermesExtensions.oauth.connect') }}
          </NButton>
          <NButton v-if="!entry.installed" size="tiny" type="primary" @click="openInstall(entry)">
            {{ t('hermesExtensions.common.install') }}
          </NButton>
        </div>
      </div>
    </div>
    <NEmpty v-else-if="loaded" :description="t('hermesExtensions.common.noMatch')" />

    <NModal
      :show="!!installing"
      preset="card"
      :title="t('hermesExtensions.catalog.installTitle', { name: installing?.name || '' })"
      :style="{ width: 'min(560px, calc(100vw - 32px))' }"
      @update:show="(value: boolean) => { if (!value) installing = null }"
    >
      <div v-if="installing" class="install-body">
        <p>{{ installing.description }}</p>
        <div class="install-detail">
          <span class="label">{{ t('hermesExtensions.catalog.connectsTo') }}</span>
          <code>{{ installing.url || [installing.command, ...(installing.args || [])].filter(Boolean).join(' ') }}</code>
        </div>
        <div v-if="installing.install_url" class="install-detail">
          <span class="label">{{ t('hermesExtensions.catalog.downloadsFrom') }}</span>
          <code>{{ installing.install_url }}</code>
        </div>
        <div v-for="env in installing.required_env" :key="env.name" class="install-field">
          <label>{{ env.prompt || env.name }} <span v-if="env.required" class="required">*</span></label>
          <NInput v-model:value="envValues[env.name]" size="small" :placeholder="env.name" type="password" show-password-on="click" />
        </div>
        <NAlert v-if="needsOAuth(installing)" type="info" :bordered="false">{{ t('hermesExtensions.catalog.oauthAfterInstall') }}</NAlert>
        <pre v-if="installing.post_install" class="post-install">{{ installing.post_install }}</pre>
        <div class="modal-actions">
          <NButton @click="installing = null">{{ t('hermesExtensions.common.cancel') }}</NButton>
          <NButton type="primary" :loading="installBusy" :disabled="missingEnv" @click="confirmInstall">
            {{ t('hermesExtensions.common.install') }}
          </NButton>
        </div>
      </div>
    </NModal>

    <McpOAuthConnect v-model:show="showConnect" :server="connectServer" @connected="onConnected" />
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;
@use '@/styles/mcp-manager' as mcp-manager;

@include mcp-manager.layout;

.catalog-loading { display: grid; place-items: center; padding: 40px 0; }
.catalog-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 300px), 1fr)); gap: calc(12px * var(--spacing-scale, 1)); }
.catalog-card {
  display: flex; flex-direction: column; gap: calc(8px * var(--spacing-scale, 1));
  padding: calc(14px * var(--spacing-scale, 1));
  border: var(--border-width, 1px) solid $border-color; border-radius: $radius-md;
  background: var(--theme-card-bg, $bg-card);
}
.catalog-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
.catalog-head h3 { margin: 0; font-size: calc(var(--font-size-base, 14px) * 15 / 14); font-weight: 600; word-break: break-word; }
.catalog-tags { display: flex; gap: 4px; flex-wrap: wrap; justify-content: flex-end; }
.catalog-desc { margin: 0; color: $text-secondary; font-size: calc(var(--font-size-base, 14px) * 13 / 14); flex: 1; }
.catalog-url { color: $text-muted; font-size: calc(var(--font-size-base, 14px) * 11 / 14); font-family: monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.catalog-actions { display: flex; align-items: center; gap: 8px; }
.catalog-link { color: $accent-primary; font-size: calc(var(--font-size-base, 14px) * 12 / 14); text-decoration: none; }
.spacer { flex: 1; }
.install-body { display: flex; flex-direction: column; gap: calc(12px * var(--spacing-scale, 1)); }
.install-body p { margin: 0; }
.install-detail { display: flex; flex-direction: column; gap: 4px; }
.install-detail code { word-break: break-all; font-size: calc(var(--font-size-base, 14px) * 12 / 14); }
.label, .install-field label { color: $text-muted; font-size: calc(var(--font-size-base, 14px) * 12 / 14); }
.install-field { display: flex; flex-direction: column; gap: 4px; }
.required { color: $error; }
.post-install {
  margin: 0; white-space: pre-wrap; font-size: calc(var(--font-size-base, 14px) * 12 / 14);
  padding: 10px; border-radius: $radius-md; background: $bg-secondary; color: $text-secondary; max-height: 200px; overflow: auto;
}
</style>
