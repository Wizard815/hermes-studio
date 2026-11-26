<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { NButton, NInput, NSwitch, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import {
  fetchLlmWikiStatus, saveLlmWikiProfile, testLlmWikiProfile,
  type LlmWikiProfile, type LlmWikiSaveInput, type LlmWikiStatus, type LlmWikiTestResult,
} from '@/api/studio/llm-wiki'

/**
 * Connections → LLM wiki (docs/llm-wiki.md): the family's Obsidian wiki as each
 * Hermes profile's memory provider. Every profile has its own wiki token (kept
 * in the profile's .env, never shown again); the token decides what it can see.
 */
const { t } = useI18n()
const toast = useMessage()
const router = useRouter()

const wiki = ref<LlmWikiStatus | null>(null)
const loadError = ref('')
const selected = ref('')
const form = ref({ url: '', token: '' })
const saving = ref(false)
const testing = ref(false)
const testResult = ref<{ ok: boolean; text: string } | null>(null)

const current = computed<LlmWikiProfile | null>(() => wiki.value?.profiles.find(item => item.profile === selected.value) || null)
const canTurnOn = computed(() => !!(form.value.url.trim() || current.value?.url) && !!(form.value.token.trim() || current.value?.hasToken))

function stateText(item: LlmWikiProfile): string {
  if (item.enabled) return t('llmWiki.stateOn')
  if (item.url && item.hasToken) return t('llmWiki.stateReady')
  return t('llmWiki.stateNotSet')
}

function providerText(item: LlmWikiProfile): string {
  if (item.enabled) return item.previousProvider ? t('llmWiki.replaces', { provider: item.previousProvider }) : t('llmWiki.builtinStays')
  return item.provider ? t('llmWiki.otherProvider', { provider: item.provider }) : t('llmWiki.builtinOnly')
}

function pick(profile: string) {
  selected.value = profile
}

watch(current, (item, before) => {
  if (item?.profile === before?.profile) return
  form.value = { url: item?.url || '', token: '' }
  testResult.value = null
})

async function load() {
  try {
    wiki.value = await fetchLlmWikiStatus()
    loadError.value = ''
    if (!selected.value || !wiki.value.profiles.some(item => item.profile === selected.value)) {
      selected.value = wiki.value.profiles.find(item => item.enabled)?.profile || wiki.value.profiles[0]?.profile || ''
    }
  } catch (err: any) {
    loadError.value = t('llmWiki.loadFailed', { error: err?.message || String(err) })
  }
}

function replace(item: LlmWikiProfile) {
  if (!wiki.value) return
  wiki.value = { ...wiki.value, profiles: wiki.value.profiles.map(row => (row.profile === item.profile ? item : row)) }
}

async function save(extra: LlmWikiSaveInput = {}, quiet = false) {
  if (!current.value) return
  saving.value = true
  try {
    const input: LlmWikiSaveInput = { ...extra }
    if (form.value.url.trim() !== current.value.url) input.url = form.value.url.trim()
    if (form.value.token.trim()) input.token = form.value.token.trim()
    const saved = await saveLlmWikiProfile(current.value.profile, input)
    replace(saved)
    form.value.token = ''
    if (!quiet) toast.success(t('llmWiki.saved', { profile: saved.profile }))
  } catch (err: any) {
    toast.error(err?.message || String(err))
  } finally {
    saving.value = false
  }
}

function describe(result: LlmWikiTestResult): string {
  if (!result.ok || !result.identity) return t('llmWiki.testFailed', { error: result.error })
  const who = `${result.identity.name} (${result.identity.kind})`
  return t(`llmWiki.view.${result.view}`, { who })
}

async function runTest() {
  if (!current.value) return
  testing.value = true
  testResult.value = null
  try {
    const result = await testLlmWikiProfile(current.value.profile, { url: form.value.url.trim(), token: form.value.token.trim() || undefined })
    testResult.value = { ok: result.ok, text: describe(result) }
  } catch (err: any) {
    testResult.value = { ok: false, text: t('llmWiki.testFailed', { error: err?.message || String(err) }) }
  } finally {
    testing.value = false
  }
}

function openMcp() {
  void router.push({ name: 'hermes.mcp', query: { tab: 'catalog' } })
}

onMounted(() => { void load() })
</script>

<template>
  <div class="wiki-connection" data-testid="llm-wiki-connection">
    <section class="wiki-card" data-theme-surface="card">
      <header class="wiki-card-head"><h3>{{ t('llmWiki.title') }}</h3></header>
      <p class="wiki-hint">{{ t('llmWiki.intro') }}</p>
      <ol class="wiki-steps">
        <li>{{ t('llmWiki.step1') }} <code>node scripts/family-setup.mjs token &lt;id&gt;</code></li>
        <li>{{ t('llmWiki.step2') }}</li>
        <li>{{ t('llmWiki.step3') }}</li>
      </ol>
      <p class="wiki-hint">{{ t('llmWiki.privacy') }}</p>
      <p v-if="loadError" class="wiki-result is-bad" role="alert">{{ loadError }}</p>
    </section>

    <section class="wiki-card" data-theme-surface="card">
      <header class="wiki-card-head"><h3>{{ t('llmWiki.profilesTitle') }}</h3></header>
      <p v-if="wiki && !wiki.profiles.length" class="wiki-hint">{{ t('llmWiki.noProfiles') }}</p>
      <ul class="wiki-profiles" :aria-label="t('llmWiki.profilesTitle')">
        <li v-for="item in wiki?.profiles || []" :key="item.profile">
          <button
            type="button"
            class="wiki-profile"
            :class="{ 'is-selected': item.profile === selected }"
            :aria-current="item.profile === selected ? 'true' : undefined"
            :data-testid="`llm-wiki-profile-${item.profile}`"
            @click="pick(item.profile)"
          >
            <span class="wiki-profile-name">{{ item.profile }}</span>
            <span class="wiki-badge" :class="{ 'is-on': item.enabled }">{{ stateText(item) }}</span>
            <span class="wiki-profile-meta">{{ providerText(item) }}</span>
          </button>
        </li>
      </ul>
    </section>

    <section v-if="current" class="wiki-card" data-theme-surface="card" data-testid="llm-wiki-editor">
      <header class="wiki-card-head">
        <h3>{{ t('llmWiki.profileTitle', { profile: current.profile }) }}</h3>
        <span class="wiki-badge" :class="{ 'is-on': current.enabled }" data-testid="llm-wiki-state">{{ stateText(current) }}</span>
      </header>
      <div class="wiki-fields">
        <label class="wiki-field">
          <span>{{ t('llmWiki.address') }}</span>
          <NInput v-model:value="form.url" size="small" placeholder="http://wiki.lan:27123" :input-props="{ 'aria-label': t('llmWiki.address') }" data-testid="llm-wiki-url" />
          <small>{{ t('llmWiki.addressHint') }}</small>
        </label>
        <label class="wiki-field">
          <span>{{ t('llmWiki.token') }}</span>
          <NInput
            v-model:value="form.token"
            size="small"
            type="password"
            show-password-on="click"
            :placeholder="current.hasToken ? t('llmWiki.tokenSaved') : 'llmw_…'"
            :input-props="{ 'aria-label': t('llmWiki.token'), autocomplete: 'off' }"
            data-testid="llm-wiki-token"
          />
          <small>{{ current.hasToken ? t('llmWiki.tokenKept', { env: wiki?.tokenEnv }) : t('llmWiki.tokenHint', { env: wiki?.tokenEnv }) }}</small>
        </label>
      </div>
      <div class="wiki-actions">
        <NButton size="small" type="primary" :loading="saving" data-testid="llm-wiki-save" @click="save()">{{ t('llmWiki.save') }}</NButton>
        <NButton size="small" :loading="testing" :disabled="!canTurnOn" data-testid="llm-wiki-test" @click="runTest">{{ t('llmWiki.test') }}</NButton>
        <NButton v-if="current.hasToken" size="small" quaternary type="error" :disabled="saving" data-testid="llm-wiki-forget" @click="save({ clearToken: true, ...(current.enabled ? { enabled: false } : {}) })">{{ t('llmWiki.forgetToken') }}</NButton>
      </div>
      <p v-if="testResult" class="wiki-result" :class="testResult.ok ? 'is-good' : 'is-bad'" role="status" aria-live="polite" data-testid="llm-wiki-test-result">{{ testResult.text }}</p>

      <div class="wiki-switches">
        <label class="wiki-toggle">
          <NSwitch :value="current.enabled" :disabled="saving || (!current.enabled && !canTurnOn)" :aria-label="t('llmWiki.useAsMemory')" data-testid="llm-wiki-enabled" @update:value="value => save({ enabled: value })" />
          <span><strong>{{ t('llmWiki.useAsMemory') }}</strong> {{ providerText(current) }}</span>
        </label>
        <label class="wiki-toggle">
          <NSwitch :value="current.recall" :disabled="saving" :aria-label="t('llmWiki.recall')" data-testid="llm-wiki-recall" @update:value="value => save({ recall: value }, true)" />
          <span><strong>{{ t('llmWiki.recall') }}</strong> {{ t('llmWiki.recallHint') }}</span>
        </label>
        <label class="wiki-toggle">
          <NSwitch :value="current.remember" :disabled="saving" :aria-label="t('llmWiki.remember')" data-testid="llm-wiki-remember" @update:value="value => save({ remember: value }, true)" />
          <span><strong>{{ t('llmWiki.remember') }}</strong> {{ t('llmWiki.rememberHint') }}</span>
        </label>
      </div>
      <p class="wiki-hint">{{ t('llmWiki.appliesHint') }}</p>
      <p class="wiki-hint">{{ t('llmWiki.mcpHint') }} <NButton text size="small" type="primary" data-testid="llm-wiki-open-mcp" @click="openMcp">{{ t('llmWiki.openMcp') }}</NButton></p>
    </section>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.wiki-connection {
  display: flex;
  flex-direction: column;
  gap: calc(16px * var(--spacing-scale, 1));
  max-width: 880px;
  height: 100%;
  overflow: auto;
  padding: calc(20px * var(--spacing-scale, 1));
}

.wiki-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 16px;
  background: $bg-card;
  border: var(--border-width, 1px) solid $border-light;
  border-radius: var(--radius-component, 8px);
  color: $text-primary;
}

.wiki-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;

  h3 {
    margin: 0;
    font-size: 15px;
  }
}

.wiki-hint,
.wiki-result {
  margin: 0;
  font-size: 12.5px;
  color: $text-muted;
}

.wiki-result.is-good {
  color: $success;
}

.wiki-result.is-bad {
  color: $error;
}

.wiki-steps {
  margin: 0;
  padding-left: 20px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 13px;
  color: $text-secondary;

  code {
    font-size: 12px;
    white-space: nowrap;
  }
}

.wiki-profiles {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.wiki-profile {
  width: 100%;
  min-height: 44px;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 2px 10px;
  align-items: center;
  padding: 8px 12px;
  text-align: left;
  font: inherit;
  color: $text-primary;
  background: transparent;
  border: var(--border-width, 1px) solid $border-light;
  border-radius: var(--radius-component, 8px);
  cursor: pointer;

  &:hover {
    border-color: $accent-primary;
  }

  &:focus-visible {
    outline: 2px solid $accent-primary;
    outline-offset: 2px;
  }

  &.is-selected {
    border-color: $accent-primary;
    box-shadow: inset 3px 0 0 $accent-primary;
  }
}

.wiki-profile-name {
  font-weight: 600;
  font-size: 13.5px;
}

.wiki-profile-meta {
  grid-column: 1 / -1;
  font-size: 12px;
  color: $text-muted;
}

.wiki-badge {
  font-size: 12px;
  color: $text-muted;
  white-space: nowrap;

  &.is-on {
    color: $success;
    font-weight: 600;
  }
}

.wiki-fields {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}

.wiki-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12.5px;
  color: $text-secondary;

  small {
    color: $text-muted;
    font-size: 12px;
  }
}

.wiki-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.wiki-switches {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding-top: 6px;
  border-top: var(--border-width, 1px) solid $border-light;
}

.wiki-toggle {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  font-size: 13px;
  cursor: pointer;

  strong {
    font-weight: 600;
  }
}

@media (max-width: $breakpoint-mobile) {
  .wiki-fields {
    grid-template-columns: 1fr;
  }
}
</style>
