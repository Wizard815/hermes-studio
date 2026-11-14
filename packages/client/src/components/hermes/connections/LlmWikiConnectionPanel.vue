<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { NButton, NInput, NSwitch, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { fetchLlmWikiStatus, saveLlmWikiSettings, searchLlmWiki, type LlmWikiStatus } from '@/api/studio/llmwiki'

/**
 * Connections → LLMWIKI: the Obsidian memory vault (Local REST API). Studio
 * reads wiki/ (long-term memory) and adds to today's daily note (short-term).
 */
const { t } = useI18n()
const toast = useMessage()
const wiki = ref<LlmWikiStatus | null>(null)
const url = ref('')
const token = ref('')
const saving = ref(false)
const query = ref('')
const searching = ref(false)
const answer = ref('')

async function load() {
  try {
    wiki.value = await fetchLlmWikiStatus()
    url.value = wiki.value.settings.url
  } catch { wiki.value = null }
}

async function save(extra: { recall?: boolean; saveChats?: boolean } = {}) {
  saving.value = true
  try {
    await saveLlmWikiSettings({
      ...(wiki.value?.settings.fromEnv ? {} : { url: url.value.trim() }),
      ...(token.value.trim() ? { token: token.value.trim() } : {}),
      ...extra,
    })
    token.value = ''
    await load()
    if (!('recall' in extra) && !('saveChats' in extra)) toast.success(wiki.value?.connected ? t('llmwiki.connectedToast') : t('llmwiki.saved'))
  } catch (err: any) {
    toast.error(err?.message || String(err))
  } finally {
    saving.value = false
  }
}

async function search() {
  if (!query.value.trim()) return
  searching.value = true
  answer.value = ''
  try { answer.value = (await searchLlmWiki(query.value.trim())).result || t('llmwiki.noResults') } catch (err: any) { answer.value = err?.message || String(err) } finally { searching.value = false }
}

onMounted(() => { void load() })
</script>

<template>
  <div class="wiki-connection" data-testid="llmwiki-connection">
    <section class="wiki-card" data-theme-surface="card">
      <header class="wiki-card-head">
        <h3>{{ t('llmwiki.tab') }}</h3>
        <span class="wiki-state" :class="{ 'is-good': wiki?.connected }" data-testid="llmwiki-state">
          {{ wiki?.connected ? t('llmwiki.connected') : t('llmwiki.notConnected') }}
        </span>
      </header>
      <p class="wiki-hint">{{ t('llmwiki.intro') }}</p>
      <div class="wiki-form">
        <NInput v-model:value="url" size="small" :disabled="wiki?.settings.fromEnv" :placeholder="`${t('llmwiki.address')} (http://192.168.20.5:27123)`" data-testid="llmwiki-url" />
        <NInput v-model:value="token" size="small" type="password" :placeholder="wiki?.settings.hasToken ? t('llmwiki.keyKept') : t('llmwiki.key')" data-testid="llmwiki-token" />
        <NButton size="small" type="primary" :loading="saving" data-testid="llmwiki-save" @click="save()">{{ t('llmwiki.connect') }}</NButton>
      </div>
      <p v-if="wiki?.settings.fromEnv" class="wiki-hint">{{ t('llmwiki.fromEnv') }}</p>
      <p v-if="wiki?.error && wiki.settings.url" class="wiki-error" data-testid="llmwiki-error">{{ wiki.error }}</p>
      <p class="wiki-hint">{{ t('llmwiki.addressHint') }}</p>
    </section>

    <section class="wiki-card" data-theme-surface="card">
      <header class="wiki-card-head"><h3>{{ t('llmwiki.useTitle') }}</h3></header>
      <label class="wiki-toggle">
        <NSwitch :value="wiki?.settings.recall ?? true" size="small" :disabled="saving" data-testid="llmwiki-recall" @update:value="value => save({ recall: value })" />
        <span><strong>{{ t('llmwiki.recall') }}</strong> {{ t('llmwiki.recallHint') }}</span>
      </label>
      <label class="wiki-toggle">
        <NSwitch :value="wiki?.settings.saveChats ?? true" size="small" :disabled="saving" data-testid="llmwiki-save-chats" @update:value="value => save({ saveChats: value })" />
        <span><strong>{{ t('llmwiki.saveChats') }}</strong> {{ t('llmwiki.saveChatsHint') }}</span>
      </label>
      <p class="wiki-hint">{{ t('llmwiki.agentsHint') }}</p>
    </section>

    <section v-if="wiki?.connected" class="wiki-card" data-theme-surface="card">
      <header class="wiki-card-head"><h3>{{ t('llmwiki.tryTitle') }}</h3></header>
      <div class="wiki-form wiki-form--search">
        <NInput v-model:value="query" size="small" :placeholder="t('llmwiki.tryPlaceholder')" data-testid="llmwiki-query" @keydown.enter="search" />
        <NButton size="small" :loading="searching" data-testid="llmwiki-search" @click="search">{{ t('llmwiki.search') }}</NButton>
      </div>
      <pre v-if="answer" class="wiki-answer" data-testid="llmwiki-answer">{{ answer }}</pre>
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

  h3 { margin: 0; font-size: 15px; }
}

.wiki-state {
  font-size: 12px;
  color: $text-muted;

  &.is-good { color: $success; }
}

.wiki-hint,
.wiki-error {
  margin: 0;
  font-size: 12.5px;
  color: $text-muted;
}

.wiki-error { color: $error; }

.wiki-form {
  display: grid;
  grid-template-columns: minmax(0, 2fr) minmax(0, 1fr) auto;
  gap: 8px;
}

.wiki-form--search { grid-template-columns: minmax(0, 1fr) auto; }

.wiki-toggle {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  font-size: 13px;
  cursor: pointer;

  strong { font-weight: 600; }
}

.wiki-answer {
  margin: 0;
  max-height: 320px;
  overflow: auto;
  padding: 10px;
  font-size: 12px;
  white-space: pre-wrap;
  background: $bg-main-surface;
  border-radius: var(--radius-component, 8px);
}

@media (max-width: $breakpoint-mobile) {
  .wiki-form { grid-template-columns: 1fr; }
}
</style>
