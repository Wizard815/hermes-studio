<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { NTooltip } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { getCommitSummary, type CommitList, type CommitSource, type ProjectCommit } from '@/api/studio/project-commits'

// The commits a board card's thread or PR is working on. Hovering (or
// focusing) a commit shows a short caveman summary of it, made once per
// commit by a cheap model through Argos (docs/project-commits.md).
const props = defineProps<{ projectId: string; list?: CommitList; source: CommitSource; cardId: string }>()
const { t, locale } = useI18n()

const SHOWN = 3
const expanded = ref(false)
const commits = computed(() => props.list && 'commits' in props.list ? props.list.commits : [])
const shown = computed(() => expanded.value ? commits.value : commits.value.slice(0, SHOWN))
const error = computed(() => props.list && 'error' in props.list ? props.list.error : '')

/** Summaries asked for in this view: text, loading, or why there is none. */
const asked = reactive<Record<string, { text: string; loading: boolean; error: string }>>({})
const open = ref('')

function summaryOf(commit: ProjectCommit) {
  if (commit.summary) return { text: commit.summary, loading: false, error: '' }
  return asked[commit.sha] || { text: '', loading: false, error: '' }
}

async function ensureSummary(commit: ProjectCommit) {
  if (commit.summary || asked[commit.sha]) return
  asked[commit.sha] = { text: '', loading: true, error: '' }
  try {
    asked[commit.sha] = { text: await getCommitSummary(props.projectId, commit.sha, props.source), loading: false, error: '' }
  } catch (err: any) {
    asked[commit.sha] = { text: '', loading: false, error: err?.message || String(err) }
  }
}

function show(commit: ProjectCommit) {
  open.value = commit.sha
  void ensureSummary(commit)
}

function hide(commit: ProjectCommit) {
  if (open.value === commit.sha) open.value = ''
}

function when(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString(locale.value, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

function label(commit: ProjectCommit): string {
  const summary = summaryOf(commit).text
  return summary ? `${commit.short} ${commit.subject}. ${summary}` : `${commit.short} ${commit.subject}`
}
</script>

<template>
  <div v-if="commits.length || error" class="project-commits" :data-testid="`project-commits-${cardId}`">
    <span v-if="error" class="project-commits-error" :title="error">{{ t('projects.commits.error', { error }) }}</span>
    <template v-else>
      <div class="project-commits-head">
        <span class="project-commits-count">{{ t('projects.commits.count', { n: commits.length }, commits.length) }}{{ list && 'more' in list && list.more ? '+' : '' }}</span>
      </div>
      <ul class="project-commits-list">
        <li v-for="commit in shown" :key="commit.sha">
          <NTooltip :show="open === commit.sha" placement="top-start" :style="{ maxWidth: '320px', pointerEvents: 'none' }">
            <template #trigger>
              <component
                :is="commit.url ? 'a' : 'span'"
                class="project-commit"
                :href="commit.url || undefined"
                :target="commit.url ? '_blank' : undefined"
                :rel="commit.url ? 'noopener noreferrer' : undefined"
                :tabindex="commit.url ? undefined : 0"
                :aria-label="label(commit)"
                :data-testid="`project-commit-${commit.short}`"
                @mouseenter="show(commit)"
                @mouseleave="hide(commit)"
                @focus="show(commit)"
                @blur="hide(commit)"
                @keydown.esc="hide(commit)"
              >
                <code class="project-commit-sha">{{ commit.short }}</code>
                <span class="project-commit-subject">{{ commit.subject }}</span>
              </component>
            </template>
            <div class="project-commit-tip" :data-testid="`project-commit-tip-${commit.short}`" role="status" aria-live="polite">
              <p v-if="summaryOf(commit).text" class="project-commit-summary">{{ summaryOf(commit).text }}</p>
              <p v-else-if="summaryOf(commit).error" class="project-commit-summary project-commit-summary--muted">{{ t('projects.commits.noSummary', { error: summaryOf(commit).error }) }}</p>
              <p v-else class="project-commit-summary project-commit-summary--muted">{{ t('projects.commits.thinking') }}</p>
              <p class="project-commit-meta">{{ commit.author }}<template v-if="when(commit.date)"> · {{ when(commit.date) }}</template></p>
            </div>
          </NTooltip>
        </li>
      </ul>
      <button v-if="commits.length > SHOWN" type="button" class="project-commits-more" :aria-expanded="expanded" :data-testid="`project-commits-more-${cardId}`" @click="expanded = !expanded">
        {{ expanded ? t('projects.commits.fewer') : t('projects.commits.all', { n: commits.length }) }}
      </button>
    </template>
  </div>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.project-commits {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.project-commits-head { display: flex; align-items: center; gap: 6px; }
.project-commits-count { font-size: 11px; font-weight: 600; color: $text-secondary; }
.project-commits-error { font-size: 11px; color: $text-muted; overflow-wrap: anywhere; }
.project-commits-list {
  display: flex;
  flex-direction: column;
  gap: 1px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.project-commit {
  display: flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
  min-height: 24px;
  padding: 2px 4px;
  border-radius: 4px;
  font-size: 12px;
  color: $text-primary;
  text-decoration: none;
  cursor: default;

  &[href] { cursor: pointer; }
  &:hover { background-color: rgba(var(--text-primary-rgb), 0.06); }
  &:focus-visible { outline: 2px solid $accent-primary; outline-offset: 1px; }
}
.project-commit-sha { flex: none; font-size: 11px; color: $text-muted; }
.project-commit-subject {
  display: -webkit-box;
  min-width: 0;
  overflow: hidden;
  overflow-wrap: anywhere;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  line-height: 1.35;
}
.project-commits-more {
  align-self: flex-start;
  min-height: 22px;
  padding: 0 4px;
  border: 0;
  background: none;
  font: inherit;
  font-size: 11px;
  color: $text-secondary;
  cursor: pointer;

  &:hover { color: $text-primary; text-decoration: underline; }
  &:focus-visible { outline: 2px solid $accent-primary; outline-offset: 1px; }
}
.project-commit-tip { display: flex; flex-direction: column; gap: 4px; }
.project-commit-summary { margin: 0; font-size: 13px; line-height: 1.4; }
.project-commit-summary--muted { opacity: 0.75; }
.project-commit-meta { margin: 0; font-size: 11px; opacity: 0.7; }
</style>
