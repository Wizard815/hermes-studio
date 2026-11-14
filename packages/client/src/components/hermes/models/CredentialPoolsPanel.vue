<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { NButton, NInput, NModal, NSelect, NSpin, NTag, useDialog, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useModelsStore } from '@/stores/hermes/models'
import { copyToClipboard } from '@/utils/clipboard'
import {
  addPoolKey, cancelHermesOAuth, disconnectHermesOAuth, extraSignIns, getCredentialPools, getHermesOAuthProviders,
  pollHermesOAuth, removePoolKey, startHermesOAuth,
  type DeviceLoginStart, type HermesOAuthProvider, type PoolEntry, type PoolProvider,
} from '@/api/hermes/local-models'

const props = defineProps<{ profile?: string }>()
const { t } = useI18n()
const message = useMessage()
const dialog = useDialog()
const modelsStore = useModelsStore()

const pools = ref<PoolProvider[]>([])
const signIns = ref<HermesOAuthProvider[]>([])
const loading = ref(false)
const loadError = ref('')
const provider = ref<string | null>(null)
const apiKey = ref('')
const label = ref('')
const adding = ref(false)

const providerOptions = computed(() => {
  const seen = new Map<string, string>()
  for (const group of modelsStore.providers) seen.set(group.provider, group.label ? `${group.label} (${group.provider})` : group.provider)
  for (const pool of pools.value) if (!seen.has(pool.provider)) seen.set(pool.provider, pool.provider)
  return [...seen].map(([value, text]) => ({ value, label: text }))
})

async function load() {
  loading.value = true
  loadError.value = ''
  try {
    const [p, o] = await Promise.all([getCredentialPools(props.profile), getHermesOAuthProviders(props.profile)])
    pools.value = p.providers
    signIns.value = extraSignIns(o.providers)
  } catch (err: any) {
    loadError.value = t('hermesModels.loadFailed', { error: err?.message || String(err) })
  } finally {
    loading.value = false
  }
}

async function addKey() {
  const name = (provider.value || '').trim()
  if (!name || !apiKey.value.trim()) return
  adding.value = true
  try {
    await addPoolKey(name, apiKey.value.trim(), label.value.trim(), props.profile)
    apiKey.value = ''
    label.value = ''
    message.success(t('hermesModels.keyAdded'))
    pools.value = (await getCredentialPools(props.profile)).providers
  } catch (err: any) {
    message.error(err?.message || String(err))
  } finally {
    adding.value = false
  }
}

function removeKey(pool: PoolProvider, entry: PoolEntry) {
  dialog.warning({
    title: t('hermesModels.delete'),
    content: t('hermesModels.removeKeyConfirm', { provider: pool.provider }),
    positiveText: t('hermesModels.delete'),
    negativeText: t('hermesModels.cancel'),
    onPositiveClick: async () => {
      try {
        await removePoolKey(pool.provider, entry.index, props.profile)
        message.success(t('hermesModels.keyRemoved'))
        pools.value = (await getCredentialPools(props.profile)).providers
      } catch (err: any) {
        message.error(err?.message || String(err))
      }
    },
  })
}

// ── device-code sign-in for providers Studio has no own window for ──
const login = ref<{ provider: HermesOAuthProvider; start: DeviceLoginStart } | null>(null)
const loginBusy = ref('')
let polling = 0

async function signIn(item: HermesOAuthProvider) {
  loginBusy.value = item.id
  try {
    const start = await startHermesOAuth(item.id, props.profile)
    login.value = { provider: item, start }
    window.open(start.verification_url, '_blank', 'noopener')
    void poll(++polling)
  } catch (err: any) {
    message.error(err?.message || String(err))
  } finally {
    loginBusy.value = ''
  }
}

async function poll(run: number) {
  while (run === polling && login.value) {
    const { provider: item, start } = login.value
    try {
      const result = await pollHermesOAuth(item.id, start.session_id, props.profile)
      if (run !== polling) return
      if (result.status === 'pending') continue
      login.value = null
      if (result.status === 'approved') message.success(t('hermesModels.signInDone', { provider: item.name }))
      else message.error(t('hermesModels.signInFailed', { error: result.error_message || result.status }))
      await load()
      return
    } catch (err: any) {
      if (run !== polling) return
      login.value = null
      message.error(t('hermesModels.signInFailed', { error: err?.message || String(err) }))
      return
    }
  }
}

function cancelLogin() {
  const current = login.value
  polling++
  login.value = null
  if (current) void cancelHermesOAuth(current.start.session_id, props.profile).catch(() => undefined)
}

function signOut(item: HermesOAuthProvider) {
  dialog.warning({
    title: t('hermesModels.signOut'),
    content: t('hermesModels.signOutConfirm', { provider: item.name }),
    positiveText: t('hermesModels.signOut'),
    negativeText: t('hermesModels.cancel'),
    onPositiveClick: async () => {
      try { await disconnectHermesOAuth(item.id, props.profile); await load() } catch (err: any) { message.error(err?.message || String(err)) }
    },
  })
}

async function copy(text: string) {
  if (await copyToClipboard(text)) message.success(t('common.copied'))
}

watch(() => props.profile, () => { void load() })
onMounted(load)
onUnmounted(() => { polling++ })
</script>

<template>
  <section class="key-pools">
    <header class="kp-header">
      <div>
        <h3>{{ t('hermesModels.keysTitle') }}</h3>
        <p>{{ t('hermesModels.keysDesc') }}</p>
      </div>
      <NButton size="small" :loading="loading" @click="load">{{ t('hermesModels.refresh') }}</NButton>
    </header>

    <p v-if="loadError" class="kp-error" role="alert">{{ loadError }}</p>

    <form class="kp-form" @submit.prevent="addKey">
      <NSelect v-model:value="provider" class="kp-provider" size="small" filterable tag :options="providerOptions"
        :placeholder="t('hermesModels.providerPlaceholder')" :aria-label="t('hermesModels.provider')" />
      <NInput v-model:value="apiKey" class="kp-key" size="small" type="password" show-password-on="click"
        :placeholder="t('hermesModels.apiKey')" :input-props="{ autocomplete: 'off', 'aria-label': t('hermesModels.apiKey') }" />
      <NInput v-model:value="label" class="kp-label" size="small" :placeholder="t('hermesModels.label')" />
      <NButton size="small" type="primary" attr-type="submit" :loading="adding" :disabled="!provider || !apiKey.trim()">
        {{ t('hermesModels.addKey') }}
      </NButton>
    </form>

    <NSpin :show="loading">
      <p v-if="!pools.length && !loading" class="kp-muted">{{ t('hermesModels.noPools') }}</p>
      <div v-for="pool in pools" :key="pool.provider" class="kp-pool">
        <h4 dir="ltr">{{ pool.provider }}</h4>
        <ul class="kp-list">
          <li v-for="entry in pool.entries" :key="entry.id" class="kp-row">
            <span class="kp-index">{{ entry.index }}</span>
            <span class="kp-main">
              <strong dir="auto">{{ entry.label }} <code v-if="entry.token_preview">{{ entry.token_preview }}</code></strong>
              <small>
                {{ t('hermesModels.requests', { count: entry.request_count }) }}
                <template v-if="entry.last_status"> · {{ t('hermesModels.lastStatus', { status: entry.last_status }) }}</template>
                <template v-if="entry.source && entry.source !== 'manual'"> · {{ t('hermesModels.source', { source: entry.source }) }}</template>
              </small>
            </span>
            <NButton size="tiny" quaternary type="error" :aria-label="t('hermesModels.delete')" @click="removeKey(pool, entry)">✕</NButton>
          </li>
        </ul>
      </div>

      <section v-if="signIns.length" class="kp-signins">
        <h3>{{ t('hermesModels.otherSignIns') }}</h3>
        <p class="kp-muted">{{ t('hermesModels.otherSignInsDesc') }}</p>
        <ul class="kp-list">
          <li v-for="item in signIns" :key="item.id" class="kp-row">
            <span class="kp-main">
              <strong dir="auto">{{ item.name }}
                <NTag size="tiny" round :type="item.status.logged_in ? 'success' : 'default'">
                  {{ item.status.logged_in ? t('hermesModels.signedIn') : t('hermesModels.notSignedIn') }}
                </NTag>
              </strong>
              <small v-if="item.flow !== 'device_code' && !item.status.logged_in">
                {{ t('hermesModels.runCommand') }} <code dir="ltr">{{ item.cli_command }}</code>
                <NButton size="tiny" text @click="copy(item.cli_command)">{{ t('hermesModels.copy') }}</NButton>
              </small>
              <small v-else-if="item.disconnect_hint" class="kp-muted">{{ item.disconnect_hint }}</small>
            </span>
            <a v-if="item.docs_url" :href="item.docs_url" target="_blank" rel="noopener" class="kp-link">{{ t('hermesModels.docs') }}</a>
            <NButton v-if="item.flow === 'device_code' && !item.status.logged_in" size="tiny" type="primary"
              :loading="loginBusy === item.id" @click="signIn(item)">{{ t('hermesModels.signIn') }}</NButton>
            <NButton v-if="item.status.logged_in && item.disconnectable" size="tiny" @click="signOut(item)">{{ t('hermesModels.signOut') }}</NButton>
          </li>
        </ul>
      </section>
    </NSpin>

    <NModal :show="!!login" preset="card" :title="login?.provider.name" style="max-width: 420px" :mask-closable="false" @close="cancelLogin">
      <div v-if="login" class="kp-device">
        <p>{{ t('hermesModels.deviceCodeHint') }}</p>
        <code class="kp-code" dir="ltr">{{ login.start.user_code }}</code>
        <div class="kp-device-actions">
          <NButton size="small" @click="copy(login.start.user_code)">{{ t('hermesModels.copy') }}</NButton>
          <NButton size="small" type="primary" tag="a" :href="login.start.verification_url" target="_blank" rel="noopener">{{ t('hermesModels.openPage') }}</NButton>
        </div>
        <p class="kp-muted"><NSpin size="small" /> {{ t('hermesModels.waiting') }}</p>
        <NButton size="small" quaternary @click="cancelLogin">{{ t('hermesModels.cancel') }}</NButton>
      </div>
    </NModal>
  </section>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.key-pools { padding: calc(4px * var(--spacing-scale, 1)) 0; display: flex; flex-direction: column; gap: calc(14px * var(--spacing-scale, 1)); }

.kp-header {
  display: flex; align-items: flex-start; justify-content: space-between; gap: calc(16px * var(--spacing-scale, 1));
  h3 { margin: 0 0 4px; font-size: calc(var(--font-size-base, 14px) * 15 / 14); color: $text-primary; }
  p { margin: 0; font-size: calc(var(--font-size-base, 14px) * 12 / 14); color: $text-secondary; }
}

.kp-form { display: flex; flex-wrap: wrap; gap: calc(8px * var(--spacing-scale, 1)); align-items: center; }
.kp-provider { width: 220px; }
.kp-key { flex: 1; min-width: 200px; }
.kp-label { width: 160px; }

.kp-pool { margin-bottom: 12px; h4 { margin: 0 0 6px; font-size: calc(var(--font-size-base, 14px) * 13 / 14); color: $text-primary; } }

.kp-list { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: calc(6px * var(--spacing-scale, 1)); }

.kp-row {
  display: flex; align-items: center; gap: calc(10px * var(--spacing-scale, 1));
  padding: calc(10px * var(--spacing-scale, 1)) calc(12px * var(--spacing-scale, 1));
  background: $bg-secondary; border: var(--border-width, 1px) solid $border-color; border-radius: $radius-sm;
}

.kp-index {
  flex-shrink: 0; width: 22px; height: 22px; display: inline-flex; align-items: center; justify-content: center;
  border-radius: 50%; background: var(--theme-input-bg, $bg-input); color: $text-secondary; font-size: calc(var(--font-size-base, 14px) * 11 / 14);
}

.kp-main {
  flex: 1; min-width: 0; display: flex; flex-direction: column; gap: calc(3px * var(--spacing-scale, 1));
  strong { font-size: calc(var(--font-size-base, 14px) * 13 / 14); font-weight: 500; color: $text-primary; display: flex; gap: 6px; align-items: center; flex-wrap: wrap; overflow-wrap: anywhere; }
  small { font-size: calc(var(--font-size-base, 14px) * 11 / 14); color: $text-secondary; overflow-wrap: anywhere; }
  code { font-size: calc(var(--font-size-base, 14px) * 11 / 14); color: $text-muted; }
}

.kp-signins {
  margin-top: 8px;
  h3 { margin: 0 0 4px; font-size: calc(var(--font-size-base, 14px) * 14 / 14); color: $text-primary; }
  .kp-muted { margin-bottom: 8px; }
}

.kp-link { font-size: calc(var(--font-size-base, 14px) * 12 / 14); color: $text-secondary; }
.kp-muted { margin: 0; color: $text-muted; font-size: calc(var(--font-size-base, 14px) * 12 / 14); display: flex; align-items: center; gap: 6px; }
.kp-error { margin: 0; color: var(--error-color, #d03050); font-size: calc(var(--font-size-base, 14px) * 12 / 14); }

.kp-device {
  display: flex; flex-direction: column; align-items: center; gap: 12px; text-align: center;
  p { margin: 0; }
}
.kp-code { font-size: calc(var(--font-size-base, 14px) * 22 / 14); letter-spacing: 0.15em; padding: 6px 12px; border-radius: $radius-sm; background: $bg-secondary; }
.kp-device-actions { display: flex; gap: 8px; }

@media (max-width: 640px) {
  .kp-provider, .kp-label { width: 100%; }
}
</style>
