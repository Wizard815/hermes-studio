<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { NButton, NInput, NModal, NSelect, useDialog, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import {
  createOmiKey, fetchOmiStatus, fetchOmiWork, registerOmiWebhook, removeOmiWebhook, revokeOmiKey, saveOmiSettings, testOmi,
  type OmiKey, type OmiStatus,
} from '@/api/studio/omi'
import type { OrbWork } from '@/api/studio/orb'
import { useProfilesStore } from '@/stores/hermes/profiles'
import { copyToClipboard } from '@/utils/clipboard'

/**
 * Connections → Omi (docs/omi.md): Omi's address, the Studio key Omi uses
 * instead of a login (shown once), the webhook that sends results back to Omi,
 * and the chats Omi started.
 */
const { t, locale } = useI18n()
const toast = useMessage()
const dialog = useDialog()
const router = useRouter()
const profilesStore = useProfilesStore()

const omi = ref<OmiStatus | null>(null)
const form = ref({ url: '', webUrl: '', profile: '' })
const saving = ref(false)
const testing = ref(false)
const testResult = ref<{ ok: boolean; text: string } | null>(null)
const keyName = ref('Omi')
const makingKey = ref(false)
const webhookBusy = ref(false)
/** A key or webhook secret Studio shows once. */
const shownOnce = ref<{ title: string; hint: string; value: string } | null>(null)
const copied = ref(false)
const work = ref<OrbWork[]>([])
let timer = 0

const profileOptions = computed(() => [
  { label: t('omi.profileDefault'), value: '' },
  ...profilesStore.profiles.map(profile => ({ label: profile.name, value: profile.name })),
])
const webLink = computed(() => omi.value?.settings.webUrl || omi.value?.settings.url || '')

async function load() {
  try {
    omi.value = await fetchOmiStatus()
    form.value = { ...omi.value.settings }
  } catch { omi.value = null }
  await loadWork()
}

async function loadWork() {
  try { work.value = (await fetchOmiWork()).work } catch { work.value = [] }
}

function fail(err: any) {
  toast.error(err?.message || String(err))
}

async function save() {
  saving.value = true
  try {
    omi.value = await saveOmiSettings({ url: form.value.url.trim(), webUrl: form.value.webUrl.trim(), profile: form.value.profile })
    toast.success(t('omi.saved'))
  } catch (err) { fail(err) } finally { saving.value = false }
}

async function runTest() {
  testing.value = true
  testResult.value = null
  try {
    const result = await testOmi()
    testResult.value = { ok: result.ok, text: result.ok ? t('omi.testOk', { detail: result.detail }) : result.error }
  } catch (err: any) {
    testResult.value = { ok: false, text: err?.message || String(err) }
  } finally { testing.value = false }
}

function showOnce(title: string, hint: string, value: string) {
  copied.value = false
  shownOnce.value = { title, hint, value }
}

async function copyShown() {
  if (shownOnce.value) copied.value = await copyToClipboard(shownOnce.value.value)
}

async function makeKey() {
  makingKey.value = true
  try {
    const { apiKey } = await createOmiKey(keyName.value.trim() || 'Omi')
    showOnce(t('omi.newKeyTitle'), t('omi.newKeyHint'), apiKey)
    await load()
  } catch (err) { fail(err) } finally { makingKey.value = false }
}

function confirmRevoke(key: OmiKey) {
  dialog.warning({
    title: t('omi.revoke'),
    content: t('omi.revokeConfirm', { name: key.name }),
    positiveText: t('omi.revoke'),
    negativeText: t('common.cancel'),
    onPositiveClick: async () => {
      try { await revokeOmiKey(key.id); toast.success(t('omi.revoked')); await load() } catch (err) { fail(err) }
    },
  })
}

async function registerWebhook() {
  webhookBusy.value = true
  try {
    const result = await registerOmiWebhook()
    omi.value = result.status
    showOnce(t('omi.webhookSecretTitle'), t('omi.webhookSecretHint'), result.secret)
  } catch (err) { fail(err) } finally { webhookBusy.value = false }
}

async function removeWebhook() {
  webhookBusy.value = true
  try { omi.value = await removeOmiWebhook() } catch (err) { fail(err) } finally { webhookBusy.value = false }
}

function when(ms: number | null): string {
  return ms ? new Date(ms).toLocaleString(locale.value) : ''
}

function openChat(item: OrbWork) {
  void router.push({ name: 'hermes.session', params: { sessionId: item.sessionId } })
}

function openMcp() {
  void router.push({ name: 'hermes.mcp', query: { tab: 'catalog' } })
}

onMounted(() => {
  void load()
  if (!profilesStore.profiles.length) void profilesStore.fetchProfiles().catch(() => undefined)
  timer = window.setInterval(() => { void loadWork() }, 10000)
})
onBeforeUnmount(() => { if (timer) window.clearInterval(timer) })
</script>

<template>
  <div class="omi-connection" data-testid="omi-connection">
    <section class="omi-card" data-theme-surface="card">
      <header class="omi-card-head">
        <h3>{{ t('omi.tab') }}</h3>
        <a v-if="webLink" class="omi-link" :href="webLink" target="_blank" rel="noopener noreferrer" data-testid="omi-open-web">{{ t('omi.openWeb') }} ↗</a>
      </header>
      <p class="omi-hint">{{ t('omi.intro') }}</p>
      <div class="omi-fields">
        <label class="omi-field">
          <span>{{ t('omi.address') }}</span>
          <NInput v-model:value="form.url" size="small" placeholder="http://omi.lan:8000" :input-props="{ 'aria-label': t('omi.address') }" data-testid="omi-url" />
          <small>{{ t('omi.addressHint') }}</small>
        </label>
        <label class="omi-field">
          <span>{{ t('omi.webUrl') }}</span>
          <NInput v-model:value="form.webUrl" size="small" placeholder="http://omi.lan:8000" :input-props="{ 'aria-label': t('omi.webUrl') }" data-testid="omi-web-url" />
        </label>
        <label class="omi-field">
          <span>{{ t('omi.profile') }}</span>
          <NSelect v-model:value="form.profile" size="small" :options="profileOptions" data-testid="omi-profile" />
        </label>
      </div>
      <div class="omi-actions">
        <NButton size="small" type="primary" :loading="saving" data-testid="omi-save" @click="save">{{ t('omi.save') }}</NButton>
        <NButton size="small" :loading="testing" :disabled="!omi?.settings.url" data-testid="omi-test" @click="runTest">{{ t('omi.test') }}</NButton>
      </div>
      <p v-if="testResult" class="omi-result" :class="testResult.ok ? 'is-good' : 'is-bad'" role="status" aria-live="polite" data-testid="omi-test-result">{{ testResult.text }}</p>
    </section>

    <section class="omi-card" data-theme-surface="card">
      <header class="omi-card-head"><h3>{{ t('omi.keysTitle') }}</h3></header>
      <p class="omi-hint">{{ t('omi.keysHint') }}</p>
      <p v-if="!omi?.keys.length" class="omi-hint" data-testid="omi-no-keys">{{ t('omi.noKeys') }}</p>
      <ul v-else class="omi-keys">
        <li v-for="key in omi.keys" :key="key.id" class="omi-key" data-testid="omi-key">
          <span class="omi-key-name">{{ key.name }}</span>
          <code class="omi-key-preview">{{ key.preview }}</code>
          <span class="omi-key-meta">{{ key.lastUsedAt ? t('omi.lastUsed', { when: when(key.lastUsedAt) }) : t('omi.neverUsed') }}</span>
          <NButton size="small" quaternary type="error" :aria-label="`${t('omi.revoke')} ${key.name}`" data-testid="omi-key-revoke" @click="confirmRevoke(key)">{{ t('omi.revoke') }}</NButton>
        </li>
      </ul>
      <div class="omi-inline">
        <NInput v-model:value="keyName" size="small" :maxlength="80" :input-props="{ 'aria-label': t('omi.keyName') }" :placeholder="t('omi.keyName')" data-testid="omi-key-name" />
        <NButton size="small" type="primary" :loading="makingKey" data-testid="omi-key-create" @click="makeKey">{{ t('omi.createKey') }}</NButton>
      </div>
    </section>

    <section class="omi-card" data-theme-surface="card">
      <header class="omi-card-head">
        <h3>{{ t('omi.webhookTitle') }}</h3>
        <span class="omi-state" :class="{ 'is-good': omi?.webhook.registered }" data-testid="omi-webhook-state">
          {{ omi?.webhook.registered ? t('omi.webhookRegistered') : t('omi.webhookNotRegistered') }}
        </span>
      </header>
      <p class="omi-hint">{{ t('omi.webhookHint') }}</p>
      <code v-if="omi?.webhook.url" class="omi-url">{{ omi.webhook.url }}</code>
      <p v-if="omi?.webhook.runtime" class="omi-hint">
        {{ t('omi.webhookDelivered', { count: omi.webhook.runtime.delivered }) }}
        <span v-if="omi.webhook.runtime.last_error" class="omi-error"> · {{ t('omi.webhookError', { error: omi.webhook.runtime.last_error }) }}</span>
      </p>
      <p v-if="!omi?.settings.url" class="omi-hint">{{ t('omi.needUrl') }}</p>
      <div class="omi-actions">
        <NButton size="small" type="primary" :loading="webhookBusy" :disabled="!omi?.settings.url" data-testid="omi-webhook-register" @click="registerWebhook">
          {{ omi?.webhook.registered ? t('omi.webhookReplace') : t('omi.webhookRegister') }}
        </NButton>
        <NButton v-if="omi?.webhook.registered" size="small" :loading="webhookBusy" data-testid="omi-webhook-remove" @click="removeWebhook">{{ t('omi.webhookRemove') }}</NButton>
      </div>
    </section>

    <section class="omi-card" data-theme-surface="card">
      <header class="omi-card-head"><h3>{{ t('omi.workTitle') }}</h3></header>
      <p v-if="!work.length" class="omi-hint" data-testid="omi-work-empty">{{ t('omi.workEmpty') }}</p>
      <button v-for="item in work" :key="item.sessionId" type="button" class="omi-work" data-testid="omi-work" @click="openChat(item)">
        <span class="omi-work-status" :data-status="item.status">{{ t(`orb.status.${item.status}`) }}</span>
        <span class="omi-work-title">{{ item.title }}</span>
        <span class="omi-work-meta">{{ item.agentId }} · {{ when(item.startedAt) }}</span>
      </button>
      <p class="omi-hint">{{ t('omi.mcpHint') }} <NButton text size="small" type="primary" data-testid="omi-open-mcp" @click="openMcp">{{ t('omi.openMcp') }}</NButton></p>
    </section>

    <NModal
      :show="!!shownOnce"
      preset="card"
      :title="shownOnce?.title"
      :style="{ width: 'min(560px, calc(100vw - 32px))' }"
      :mask-closable="false"
      @update:show="(value: boolean) => { if (!value) shownOnce = null }"
    >
      <div class="omi-once" data-testid="omi-shown-once">
        <p class="omi-hint">{{ shownOnce?.hint }}</p>
        <NInput :value="shownOnce?.value" readonly size="small" :input-props="{ 'aria-label': shownOnce?.title }" data-testid="omi-shown-value" />
        <div class="omi-actions">
          <NButton size="small" @click="copyShown">{{ copied ? t('omi.copied') : t('omi.copy') }}</NButton>
          <NButton size="small" type="primary" data-testid="omi-shown-done" @click="shownOnce = null">{{ t('omi.done') }}</NButton>
        </div>
        <span class="sr-only" role="status" aria-live="polite">{{ copied ? t('omi.copied') : '' }}</span>
      </div>
    </NModal>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.omi-connection {
  display: flex;
  flex-direction: column;
  gap: calc(16px * var(--spacing-scale, 1));
  max-width: 880px;
  height: 100%;
  overflow: auto;
  padding: calc(20px * var(--spacing-scale, 1));
}

.omi-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 16px;
  background: $bg-card;
  border: var(--border-width, 1px) solid $border-light;
  border-radius: var(--radius-component, 8px);
  color: $text-primary;
}

.omi-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;

  h3 {
    margin: 0;
    font-size: 15px;
  }
}

.omi-link {
  font-size: 12.5px;
  color: $accent-primary;
  text-decoration: none;

  &:hover,
  &:focus-visible {
    text-decoration: underline;
  }
}

.omi-state {
  font-size: 12px;
  color: $text-muted;

  &.is-good {
    color: $success;
  }
}

.omi-hint,
.omi-result {
  margin: 0;
  font-size: 12.5px;
  color: $text-muted;
}

.omi-result.is-good {
  color: $success;
}

.omi-result.is-bad,
.omi-error {
  color: $error;
}

.omi-fields {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
}

.omi-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12.5px;
  color: $text-secondary;

  small {
    color: $text-muted;
    font-size: 11.5px;
  }
}

.omi-actions,
.omi-inline {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.omi-inline > :first-child {
  flex: 1 1 200px;
}

.omi-keys {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.omi-key {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto auto;
  align-items: center;
  gap: 10px;
  padding: 6px 10px;
  border: var(--border-width, 1px) solid $border-light;
  border-radius: var(--radius-component, 8px);
  font-size: 13px;
}

.omi-key-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.omi-key-preview,
.omi-url {
  font-size: 12px;
  color: $text-secondary;
  word-break: break-all;
}

.omi-key-meta {
  font-size: 11.5px;
  color: $text-muted;
}

.omi-work {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  grid-template-areas: 'status title' 'status meta';
  column-gap: 10px;
  align-items: center;
  padding: 8px 10px;
  border: var(--border-width, 1px) solid $border-light;
  border-radius: var(--radius-component, 8px);
  background: transparent;
  color: $text-primary;
  text-align: left;
  cursor: pointer;

  &:hover {
    border-color: $accent-primary;
  }
}

.omi-work-status {
  grid-area: status;
  min-width: 72px;
  font-size: 11.5px;
  font-weight: 600;
  color: $text-secondary;

  &[data-status='working'] {
    color: $warning;
  }

  &[data-status='blocked'] {
    color: $error;
  }

  &[data-status='done'] {
    color: $success;
  }
}

.omi-work-title {
  grid-area: title;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
}

.omi-work-meta {
  grid-area: meta;
  font-size: 11.5px;
  color: $text-muted;
}

.omi-once {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}

@media (max-width: $breakpoint-mobile) {
  .omi-fields {
    grid-template-columns: 1fr;
  }

  .omi-key {
    grid-template-columns: minmax(0, 1fr) auto;
  }
}
</style>
