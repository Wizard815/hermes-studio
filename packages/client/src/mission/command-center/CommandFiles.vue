<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { NButton } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { listSessionWorkspaceFiles } from '@/api/studio/sessions'
import type { FileEntry } from '@/api/studio/workspace-files'
import { useHerdrStore } from '@/stores/hermes/herdr'
import { useCommandCenter } from './useCommandCenter'
import { folderName, relativeIn } from './model'
import { canPreview, crumbs, formatSize, parentPath, sortEntries } from './files'
import FloatingPreview from './FloatingPreview.vue'

/**
 * Files (Roundup's file list and preview): the focused pane's folder, through
 * the chat's workspace files. Folders open with a click; a file opens in a
 * floating preview with a double-click or Enter.
 */
defineProps<{ phone: boolean }>()
const { t } = useI18n()
const herdr = useHerdrStore()
const cc = useCommandCenter()

const pane = computed(() => {
  const id = herdr.bridge?.focusedPaneId || ''
  return (id && herdr.bridge?.panes.find(item => item.pane_id === id)) || null
})
const sessionId = computed(() => pane.value?.studioSessionId || '')
const chatTitle = computed(() => (sessionId.value && cc.state.chats.get(sessionId.value)?.title) || pane.value?.label || '')
const path = ref('')
const root = ref('')
const entries = ref<FileEntry[]>([])
const error = ref('')
const loading = ref(false)
const query = ref('')
const hidden = ref(false)
const selected = ref('')
const preview = ref<FileEntry | null>(null)
let generation = 0

const shown = computed(() => sortEntries(entries.value, { query: query.value, hidden: hidden.value }))
const trail = computed(() => crumbs(path.value, folderName(root.value) || t('commandCenter.files.root')))

async function open(next: string) {
  const id = sessionId.value
  if (!id) return
  const mine = ++generation
  loading.value = true
  try {
    const result = await listSessionWorkspaceFiles(id, next)
    if (mine !== generation) return
    entries.value = result.entries
    path.value = next
    if (!next && result.absolutePath) root.value = result.absolutePath
    error.value = ''
  } catch (err: any) {
    if (mine === generation) error.value = err?.message || String(err)
  } finally {
    if (mine === generation) loading.value = false
  }
}

/** A newly focused pane: its chat's folder, at the pane's own folder when that is inside it. */
watch(() => `${sessionId.value}|${pane.value?.foreground_cwd || pane.value?.cwd || ''}`, async () => {
  entries.value = []
  root.value = ''
  path.value = ''
  selected.value = ''
  if (!sessionId.value) return
  await open('')
  const inside = relativeIn(root.value, pane.value?.foreground_cwd || pane.value?.cwd || '')
  if (inside) await open(inside)
}, { immediate: true })

function activate(entry: FileEntry) {
  selected.value = entry.path
  if (entry.isDir) void open(entry.path)
}
function show(entry: FileEntry) {
  if (entry.isDir) { void open(entry.path); return }
  if (canPreview(entry.name)) preview.value = entry
}
function onKey(event: KeyboardEvent, entry: FileEntry) {
  if (event.key === 'Enter') { event.preventDefault(); show(entry) }
  else if (event.key === 'Backspace' && path.value) { event.preventDefault(); void open(parentPath(path.value)) }
}
</script>

<template>
  <section class="source cc-files" data-testid="cc-files">
    <p v-if="!pane" class="source-empty">{{ t('commandCenter.files.noPane') }}</p>
    <p v-else-if="!sessionId" class="source-empty">{{ t('commandCenter.files.noChat') }}</p>
    <template v-else>
      <div class="source-card-meta cc-files-chat" :title="root">{{ t('commandCenter.files.of', { chat: chatTitle || sessionId }) }}</div>
      <nav class="cc-crumbs" :aria-label="t('commandCenter.files.path')">
        <button v-if="path" type="button" class="cc-up" :title="t('commandCenter.files.up')" :aria-label="t('commandCenter.files.up')" @click="open(parentPath(path))">↑</button>
        <template v-for="(crumb, index) in trail" :key="crumb.path">
          <span v-if="index" class="cc-crumb-sep" aria-hidden="true">/</span>
          <button type="button" class="cc-crumb" :aria-current="index === trail.length - 1 ? 'location' : undefined" @click="open(crumb.path)">{{ crumb.name }}</button>
        </template>
      </nav>
      <div class="source-bar">
        <input v-model="query" class="cc-filter" data-theme-surface="input" :placeholder="t('commandCenter.files.filter')" :aria-label="t('commandCenter.files.filter')" />
        <label class="cc-hidden"><input v-model="hidden" type="checkbox" /> {{ t('commandCenter.files.hidden') }}</label>
        <NButton size="tiny" quaternary :loading="loading" @click="open(path)">{{ t('mission.refresh') }}</NButton>
      </div>
      <p v-if="error" class="source-error">{{ error }}</p>
      <p v-else-if="!loading && !shown.length" class="source-empty">{{ t('commandCenter.files.empty') }}</p>
      <ul class="cc-file-list" role="listbox" :aria-label="t('commandCenter.tabs.files')">
        <li v-for="entry in shown" :key="entry.path" role="none">
          <button
            type="button"
            role="option"
            class="cc-file"
            :class="{ 'is-dir': entry.isDir, 'is-selected': selected === entry.path, 'no-preview': !entry.isDir && !canPreview(entry.name) }"
            :aria-selected="selected === entry.path"
            :data-testid="entry.isDir ? 'cc-file-dir' : 'cc-file'"
            :title="entry.isDir ? entry.name : canPreview(entry.name) ? t('commandCenter.files.openHint') : entry.name"
            @click="activate(entry)"
            @dblclick="show(entry)"
            @keydown="onKey($event, entry)"
          >
            <span class="cc-file-icon" aria-hidden="true">{{ entry.isDir ? '▸' : '·' }}</span>
            <span class="cc-file-name">{{ entry.name }}</span>
            <span v-if="entry.gitStatus" class="cc-git" :class="`is-${entry.gitStatus}`">{{ entry.gitStatus[0].toUpperCase() }}</span>
            <span v-if="!entry.isDir" class="cc-file-size">{{ formatSize(entry.size) }}</span>
          </button>
        </li>
      </ul>
    </template>
    <FloatingPreview v-if="preview && sessionId" :session-id="sessionId" :path="preview.path" :name="preview.name" :size="preview.size" :phone="phone" @close="preview = null" />
  </section>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;
@use '../sources/source';

.cc-files {
  gap: 6px;
}

.cc-files-chat {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cc-crumbs {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 2px;
  font-size: 12px;
}

.cc-crumb,
.cc-up {
  padding: 1px 5px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: $text-secondary;
  font-size: 12px;
  cursor: pointer;

  &:hover,
  &:focus-visible {
    color: $text-primary;
    background: rgba(var(--accent-primary-rgb), 0.1);
    outline: none;
  }

  &[aria-current] {
    color: $text-primary;
    font-weight: 600;
  }
}

.cc-crumb-sep {
  color: $text-muted;
}

.cc-filter {
  flex: 1 1 120px;
  min-width: 0;
  padding: 4px 8px;
  font-size: 12px;
  color: $text-primary;
  background: $bg-input;
  border: var(--border-width, 1px) solid $border-light;
  border-radius: var(--radius-component, 6px);
  outline: none;
}

.cc-hidden {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11.5px;
}

.cc-file-list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.cc-file {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 4px 6px;
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

  &:focus-visible {
    outline: 2px solid $accent-primary;
    outline-offset: -2px;
  }

  &.is-selected {
    background: rgba(var(--accent-primary-rgb), 0.14);
  }

  &.is-dir .cc-file-name {
    font-weight: 600;
  }

  &.no-preview {
    color: $text-secondary;
  }
}

.cc-file-icon {
  flex: none;
  width: 10px;
  color: $text-muted;
}

.cc-file-name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cc-file-size {
  flex: none;
  font-size: 10.5px;
  color: $text-muted;
}

.cc-git {
  flex: none;
  font-size: 10px;
  font-weight: 700;
  color: $warning;

  &.is-added,
  &.is-untracked {
    color: $success;
  }

  &.is-deleted,
  &.is-conflicted {
    color: $error;
  }
}
</style>
