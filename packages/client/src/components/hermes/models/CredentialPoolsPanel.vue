<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { NButton, NInput, NSelect, NSpin, useDialog, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useModelsStore } from '@/stores/hermes/models'
import { addPoolKey, getCredentialPools, removePoolKey, type PoolEntry, type PoolProvider } from '@/api/hermes/local-models'

// Pools belong to the account's Providers (the same for every profile); the model
// gateway takes a Provider's own key and its pooled keys in turn.
const props = defineProps<{ profile?: string }>()
const { t } = useI18n()
const message = useMessage()
const dialog = useDialog()
const modelsStore = useModelsStore()

const pools = ref<PoolProvider[]>([])
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
    pools.value = (await getCredentialPools()).providers
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
    await addPoolKey(name, apiKey.value.trim(), label.value.trim())
    apiKey.value = ''
    label.value = ''
    message.success(t('hermesModels.keyAdded'))
    pools.value = (await getCredentialPools()).providers
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
        await removePoolKey(pool.provider, entry.index)
        message.success(t('hermesModels.keyRemoved'))
        pools.value = (await getCredentialPools()).providers
      } catch (err: any) {
        message.error(err?.message || String(err))
      }
    },
  })
}

watch(() => props.profile, () => { void load() })
onMounted(load)
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

    </NSpin>

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
