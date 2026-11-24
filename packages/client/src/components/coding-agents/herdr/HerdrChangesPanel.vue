<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { fetchHerdrPaneChanges, fetchHerdrPaneDiff, type HerdrPaneChanges } from '@/api/coding-agents/herdr'

/**
 * The Changes panel of the Herdr App layout (its `changes` panel beside the
 * panes): the uncommitted changes of the repo the focused pane works in,
 * and a file's diff on click. Read-only.
 */
const props = defineProps<{ paneId: string }>()
const emit = defineEmits<{ close: [] }>()
const { t } = useI18n()

const data = ref<HerdrPaneChanges | null>(null)
const error = ref('')
const loading = ref(false)
const file = ref('')
const diff = ref<{ text: string; truncated: boolean } | null>(null)

async function load() {
  if (!props.paneId) { data.value = null; return }
  loading.value = true
  error.value = ''
  try { data.value = await fetchHerdrPaneChanges(props.paneId) } catch (err: any) { error.value = err?.message || String(err) } finally { loading.value = false }
}

async function openFile(path: string) {
  file.value = path
  diff.value = null
  try {
    const result = await fetchHerdrPaneDiff(props.paneId, path)
    diff.value = { text: result.diff, truncated: result.truncated }
  } catch (err: any) {
    diff.value = { text: err?.message || String(err), truncated: false }
  }
}

watch(() => props.paneId, () => { file.value = ''; diff.value = null; void load() }, { immediate: true })

const lines = computed(() => (diff.value?.text || '').split('\n').map(text => ({
  text,
  kind: text.startsWith('+++') || text.startsWith('---') || text.startsWith('diff ') || text.startsWith('index ') ? 'meta'
    : text.startsWith('@@') ? 'hunk' : text.startsWith('+') ? 'add' : text.startsWith('-') ? 'del' : 'ctx',
})))
const statusLabel = (status: string) => (status === '??' ? 'U' : status)
</script>

<template>
  <aside class="ch" data-testid="herdr-app-changes" :aria-label="t('herdrApp.changes')">
    <header class="ch-head">
      <button v-if="file" type="button" class="ch-back" data-testid="herdr-app-changes-back" @click="file = ''; diff = null">‹ {{ t('herdrApp.changesPanel.back') }}</button>
      <template v-else>
        <span class="ch-title">{{ t('herdrApp.changes') }}</span>
        <span v-if="data?.branch" class="ch-branch">{{ data.branch }}</span>
      </template>
      <span class="ch-spacer" />
      <button type="button" class="ch-icon" :title="t('herdrApp.changesPanel.refresh')" :aria-label="t('herdrApp.changesPanel.refresh')" @click="file ? openFile(file) : load()">
        <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.3-5.6M20 4v5h-5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" /></svg>
      </button>
      <button type="button" class="ch-icon" :title="t('herdrApp.closePanel')" :aria-label="t('herdrApp.closePanel')" data-testid="herdr-app-changes-close" @click="emit('close')">×</button>
    </header>
    <div v-if="file" class="ch-diff">
      <div class="ch-file">{{ file }}</div>
      <pre v-if="diff"><code><span v-for="(line, index) in lines" :key="index" class="ch-line" :class="`is-${line.kind}`">{{ line.text || ' ' }}</span></code></pre>
      <p v-if="diff?.truncated" class="ch-note">{{ t('herdrApp.changesPanel.truncated') }}</p>
    </div>
    <div v-else class="ch-list">
      <p v-if="!paneId" class="ch-note">{{ t('herdrApp.changesPanel.noPane') }}</p>
      <p v-else-if="error" class="ch-note">{{ error }}</p>
      <p v-else-if="data?.notRepo" class="ch-note">{{ t('herdrApp.changesPanel.notRepo') }}</p>
      <p v-else-if="data && !data.changes.length && !loading" class="ch-note">{{ t('herdrApp.changesPanel.clean') }}</p>
      <button v-for="change in data?.changes || []" :key="change.path" type="button" class="ch-row" :data-testid="`herdr-app-change-${change.path}`" @click="openFile(change.path)">
        <span class="ch-status" :class="`is-${statusLabel(change.status)}`">{{ statusLabel(change.status) }}</span>
        <span class="ch-path" :title="change.path">{{ change.path }}</span>
        <span v-if="change.added" class="ch-add">+{{ change.added }}</span>
        <span v-if="change.removed" class="ch-del">−{{ change.removed }}</span>
      </button>
    </div>
  </aside>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.ch {
  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
  overflow: hidden;
  border: var(--border-width, 1px) solid $border-light;
  border-radius: 10px;
  background: var(--theme-card-bg, $bg-card);
  font-size: 13px;
}

.ch-head {
  display: flex;
  flex: none;
  align-items: center;
  gap: 6px;
  height: 34px;
  padding: 0 6px 0 12px;
  border-bottom: var(--border-width, 1px) solid $border-light;
}

.ch-title {
  font-weight: 500;
  color: $text-primary;
}

.ch-branch {
  font-size: 11.5px;
  color: $text-muted;
}

.ch-spacer {
  flex: 1 1 auto;
}

.ch-back,
.ch-icon {
  border: 0;
  background: transparent;
  color: $text-secondary;
  cursor: pointer;
}

.ch-back {
  padding: 0;
  font-size: 12.5px;
}

.ch-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 6px;
  font-size: 16px;

  &:hover {
    color: $text-primary;
  }
}

.ch-list,
.ch-diff {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
}

.ch-list {
  padding: 6px;
}

.ch-note {
  margin: 8px;
  font-size: 12px;
  color: $text-muted;
}

.ch-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  height: 28px;
  padding: 0 8px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: $text-primary;
  font-size: 12.5px;
  text-align: left;
  cursor: pointer;

  &:hover {
    background: rgba(var(--accent-primary-rgb), 0.07);
  }
}

.ch-status {
  flex: none;
  width: 14px;
  font-family: $font-code;
  font-size: 11px;
  font-weight: 600;
  color: $warning;

  &.is-A,
  &.is-U {
    color: $success;
  }

  &.is-D {
    color: $error;
  }
}

.ch-path {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  direction: rtl;
  text-align: left;
}

.ch-add {
  color: $success;
  font-size: 11px;
}

.ch-del {
  color: $error;
  font-size: 11px;
}

.ch-file {
  padding: 8px 12px 4px;
  font-size: 12px;
  color: $text-secondary;
  word-break: break-all;
}

.ch-diff pre {
  margin: 0;
  padding: 4px 0 12px;
  font-family: $font-code;
  font-size: 11.5px;
  line-height: 1.45;
}

.ch-line {
  display: block;
  padding: 0 12px;
  white-space: pre;
  color: $text-secondary;

  &.is-add {
    color: $success;
    background: color-mix(in srgb, $success 11%, transparent);
  }

  &.is-del {
    color: $error;
    background: color-mix(in srgb, $error 11%, transparent);
  }

  &.is-hunk {
    color: $accent-primary;
  }

  &.is-meta {
    color: $text-muted;
  }
}
</style>
