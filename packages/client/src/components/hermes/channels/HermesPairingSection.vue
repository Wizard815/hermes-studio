<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { NButton, NEmpty, NInput, NPopconfirm, NSelect, NTag, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { approvePairing, clearPendingPairing, listPairing, revokePairing, type PairingEntry } from '@/api/hermes/channels'
import { cleanError } from './channel-helpers'
import { useHermesChannels } from './useHermesChannels'

const { t } = useI18n()
const message = useMessage()
const channels = useHermesChannels()

const pending = ref<PairingEntry[]>([])
const approved = ref<PairingEntry[]>([])
const busy = ref('')
const codePlatform = ref<string | null>(null)
const code = ref('')
let timer: ReturnType<typeof setInterval> | null = null

const platformOptions = computed(() => channels.platforms.value
  .filter(p => p.env_vars.some(f => f.is_list))
  .map(p => ({ label: p.name, value: p.id })))

function platformName(id: string) {
  return channels.byId(id)?.name || id
}

function who(entry: PairingEntry) {
  return [entry.user_name, entry.user_id].filter(Boolean).join(' · ') || '—'
}

async function load() {
  try {
    const res = await listPairing()
    pending.value = res.pending || []
    approved.value = res.approved || []
  } catch { /* shown by the page-level notice */ }
}

async function act(key: string, fn: () => Promise<unknown>, success: string) {
  busy.value = key
  try {
    await fn()
    message.success(success)
    await load()
  } catch (err) {
    message.error(cleanError(err, t('hermesChannels.pairing.failed')))
  } finally {
    busy.value = ''
  }
}

const approveEntry = (e: PairingEntry) => act(`a:${e.platform}:${e.request_id || e.user_id}`, () => approvePairing(e.platform, { request_id: e.request_id || undefined }), t('hermesChannels.pairing.approved'))
const revoke = (e: PairingEntry) => act(`r:${e.platform}:${e.user_id}`, () => revokePairing(e.platform, String(e.user_id)), t('hermesChannels.pairing.revoked'))
const clearPending = () => act('clear', clearPendingPairing, t('hermesChannels.pairing.cleared'))
async function approveCode() {
  if (!codePlatform.value || !code.value.trim()) return
  await act('code', () => approvePairing(codePlatform.value!, { code: code.value.trim() }), t('hermesChannels.pairing.approved'))
  code.value = ''
}

onMounted(() => {
  void load()
  timer = setInterval(load, 15000)
})
onUnmounted(() => { if (timer) clearInterval(timer) })
</script>

<template>
  <section class="hermes-section">
    <div class="section-head">
      <div>
        <h3 class="section-title">{{ t('hermesChannels.pairing.title') }}</h3>
        <p class="section-hint">{{ t('hermesChannels.pairing.hint') }}</p>
      </div>
      <NButton size="small" quaternary @click="load">{{ t('hermesChannels.refresh') }}</NButton>
    </div>

    <div class="card">
      <div class="sub-head">
        <span class="sub-title">{{ t('hermesChannels.pairing.pending') }} <NTag v-if="pending.length" size="small" type="warning" round>{{ pending.length }}</NTag></span>
        <NPopconfirm v-if="pending.length" @positive-click="clearPending">
          <template #trigger><NButton size="tiny" quaternary type="error" :loading="busy === 'clear'">{{ t('hermesChannels.pairing.clearPending') }}</NButton></template>
          {{ t('hermesChannels.pairing.clearConfirm') }}
        </NPopconfirm>
      </div>
      <div v-for="e in pending" :key="`${e.platform}:${e.request_id}:${e.user_id}`" class="row">
        <div class="row-main">
          <NTag size="small" :bordered="false">{{ platformName(e.platform) }}</NTag>
          <span>{{ who(e) }}</span>
          <span v-if="e.age_minutes !== undefined" class="muted">{{ t('hermesChannels.pairing.minutesAgo', { n: e.age_minutes }) }}</span>
        </div>
        <NButton v-if="e.request_id" size="small" type="primary" :loading="busy === `a:${e.platform}:${e.request_id}`" @click="approveEntry(e)">{{ t('hermesChannels.pairing.approve') }}</NButton>
        <span v-else class="muted">{{ t('hermesChannels.pairing.needsCode') }}</span>
      </div>
      <p v-if="!pending.length" class="muted empty">{{ t('hermesChannels.pairing.noPending') }}</p>

      <div class="code-row">
        <NSelect v-model:value="codePlatform" size="small" :options="platformOptions" :placeholder="t('hermesChannels.pairing.platform')" class="code-platform" filterable />
        <NInput v-model:value="code" size="small" :placeholder="t('hermesChannels.pairing.code')" class="code-input" @keyup.enter="approveCode" />
        <NButton size="small" :disabled="!codePlatform || !code.trim()" :loading="busy === 'code'" @click="approveCode">{{ t('hermesChannels.pairing.approveCode') }}</NButton>
      </div>
    </div>

    <div class="card">
      <div class="sub-head"><span class="sub-title">{{ t('hermesChannels.pairing.approvedTitle') }}</span></div>
      <div v-for="e in approved" :key="`${e.platform}:${e.user_id}`" class="row">
        <div class="row-main">
          <NTag size="small" :bordered="false">{{ platformName(e.platform) }}</NTag>
          <span>{{ who(e) }}</span>
        </div>
        <NPopconfirm @positive-click="revoke(e)">
          <template #trigger><NButton size="small" quaternary type="error" :loading="busy === `r:${e.platform}:${e.user_id}`">{{ t('hermesChannels.pairing.revoke') }}</NButton></template>
          {{ t('hermesChannels.pairing.revokeConfirm', { name: who(e) }) }}
        </NPopconfirm>
      </div>
      <NEmpty v-if="!approved.length" size="small" :description="t('hermesChannels.pairing.noApproved')" />
    </div>
  </section>
</template>

<style scoped lang="scss">
@use './section' as *;

.code-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 12px;
  padding-top: 12px;
  border-top: var(--border-width, 1px) solid $border-light;
}

.code-platform {
  width: 180px;
}

.code-input {
  width: 160px;
}

.empty {
  margin: 4px 0;
}
</style>
