<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { NButton, NInput } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import AgentStatusIcon from '@/components/common/AgentStatusIcon.vue'
import {
  addProjectTask,
  getProjectPrStatuses,
  type PrResult,
  removeProjectTask,
  setProjectThreadPr,
  setThreadResolved,
  startProjectTask,
  updateProjectTask,
  type Project,
  type ProjectTaskColumn,
} from '@/api/studio/projects'
import { BOARD_COLUMNS, boardCards, boardTargets, threadDisplayStatus, type BoardCard, type BoardColumn } from './project-groups'

// A project's kanban: its threads (placed by status) and tasks that are not
// threads yet, with their pull requests. Cards move by drag and drop or with
// their Move menu; a thread only moves in or out of Done (resolving it).
const props = defineProps<{ project: Project }>()
const emit = defineEmits<{ select: [threadId: string]; changed: []; error: [message: string] }>()
const { t } = useI18n()

const columns = computed(() => boardCards(props.project))

// Live PR status from GitHub (cached a minute on the server), refreshed while the board shows.
const PR_POLL_MS = 60_000
const prStatus = ref<Record<string, PrResult>>({})
const prLinks = computed(() => [...props.project.threads.map(item => item.pr), ...(props.project.tasks || []).map(item => item.pr)].filter(Boolean).sort().join(' '))
let prTimer: ReturnType<typeof setInterval> | null = null
async function loadPrStatus() {
  if (!prLinks.value) { prStatus.value = {}; return }
  try { prStatus.value = await getProjectPrStatuses(props.project.id) } catch { /* the links still work without status */ }
}
watch(prLinks, () => { void loadPrStatus() })
onMounted(() => { void loadPrStatus(); prTimer = setInterval(() => { if (document.visibilityState === 'visible') void loadPrStatus() }, PR_POLL_MS) })
onUnmounted(() => { if (prTimer) clearInterval(prTimer) })

/** The live status of a card's PR, in words, or null while unknown. */
function prWords(link: string): { state: string; stateKey: string; checks: string; checksKey: string; conflicts: boolean; error: string } | null {
  const status = prStatus.value[link]
  if (!status) return null
  if ('error' in status) return { state: '', stateKey: '', checks: '', checksKey: '', conflicts: false, error: t('projects.board.prError', { error: status.error }) }
  return {
    state: t(`projects.board.prState.${status.state}`),
    stateKey: status.state,
    checks: status.checks === 'none' ? '' : t(`projects.board.checks.${status.checks}`),
    checksKey: status.checks,
    conflicts: status.mergeable === 'dirty',
    error: '',
  }
}
const adding = ref(false)
const title = ref('')
const pr = ref('')
const busy = ref('')
const dragging = ref<BoardCard | null>(null)
const over = ref<BoardColumn | null>(null)
const prEditing = ref('')
const prDraft = ref('')

async function run(key: string, action: () => Promise<unknown>) {
  busy.value = key
  try {
    await action()
    emit('changed')
  } catch (err: any) {
    emit('error', t('projects.failed', { error: err?.message || String(err) }))
  } finally {
    busy.value = ''
  }
}

function addTask() {
  const text = title.value.trim()
  if (!text) return
  void run('add', async () => {
    await addProjectTask(props.project.id, { title: text, pr: pr.value.trim() || undefined })
    title.value = ''
    pr.value = ''
    adding.value = false
  })
}

function move(card: BoardCard, to: BoardColumn) {
  if (card.column === to || !boardTargets(card).includes(to)) return
  void run(card.id, () => card.kind === 'task'
    ? updateProjectTask(props.project.id, card.id, { column: to as ProjectTaskColumn })
    : setThreadResolved(props.project.id, card.id, to === 'done'))
}

function onMoveSelect(card: BoardCard, event: Event) {
  const select = event.target as HTMLSelectElement
  if (select.value) move(card, select.value as BoardColumn)
  select.value = ''
}

function onDrop(column: BoardColumn) {
  const card = dragging.value
  dragging.value = null
  over.value = null
  if (card) move(card, column)
}

function onDragStart(card: BoardCard, event: DragEvent) {
  dragging.value = card
  event.dataTransfer?.setData('text/plain', card.id)
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
}

function onDragOver(column: BoardColumn, event: DragEvent) {
  if (!canDrop(column)) return
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
  over.value = column
}

function canDrop(column: BoardColumn): boolean {
  return !!dragging.value && dragging.value.column !== column && boardTargets(dragging.value).includes(column)
}

function startTask(card: BoardCard) {
  void run(card.id, () => startProjectTask(props.project.id, card.id, props.project.defaultAgent))
}

function removeTask(card: BoardCard) {
  void run(card.id, () => removeProjectTask(props.project.id, card.id))
}

function editPr(card: BoardCard) {
  prEditing.value = card.id
  prDraft.value = card.pr
}

function savePr(card: BoardCard) {
  const link = prDraft.value.trim()
  void run(card.id, async () => {
    if (card.kind === 'task') await updateProjectTask(props.project.id, card.id, { pr: link })
    else await setProjectThreadPr(props.project.id, card.id, link)
    prEditing.value = ''
  })
}

/** "#41" for a GitHub/Gitea PR or GitLab MR link, else the host. */
function prLabel(link: string): string {
  const number = link.match(/\/(?:pull|pulls|merge_requests)\/(\d+)/)?.[1]
  if (number) return `#${number}`
  try { return new URL(link).host } catch { return 'PR' }
}
</script>

<template>
  <div class="project-board" data-testid="project-board" role="tabpanel">
    <div class="project-board-toolbar">
      <NButton v-if="!adding" size="small" data-testid="project-board-add" @click="adding = true">+ {{ t('projects.board.addTask') }}</NButton>
      <form v-else class="project-board-form" data-testid="project-board-form" @submit.prevent="addTask">
        <NInput v-model:value="title" size="small" :placeholder="t('projects.board.placeholder')" :input-props="{ 'aria-label': t('projects.board.placeholder') }" data-testid="project-board-title" />
        <NInput v-model:value="pr" size="small" :placeholder="t('projects.board.prPlaceholder')" :input-props="{ 'aria-label': t('projects.board.pr') }" data-testid="project-board-pr" />
        <NButton size="small" type="primary" attr-type="submit" :disabled="!title.trim()" :loading="busy === 'add'" data-testid="project-board-save">{{ t('projects.board.add') }}</NButton>
        <NButton size="small" quaternary @click="adding = false">{{ t('projects.board.cancel') }}</NButton>
      </form>
    </div>

    <div class="project-board-columns">
      <section
        v-for="column in BOARD_COLUMNS"
        :key="column"
        class="project-board-column"
        :class="{ 'project-board-column--over': over === column && canDrop(column), [`project-board-column--${column}`]: true }"
        :aria-label="t(`projects.board.columns.${column}`)"
        :data-testid="`project-board-column-${column}`"
        @dragenter="onDragOver(column, $event)"
        @dragover="onDragOver(column, $event)"
        @dragleave="over === column && (over = null)"
        @drop.prevent="onDrop(column)"
      >
        <h3 class="project-board-column-title">
          {{ t(`projects.board.columns.${column}`) }}
          <span class="project-board-count">{{ columns[column].length }}</span>
        </h3>
        <p v-if="!columns[column].length" class="project-board-empty">{{ t('projects.board.empty') }}</p>
        <article
          v-for="card in columns[column]"
          :key="`${card.kind}-${card.id}`"
          class="project-board-card"
          :class="{ 'project-board-card--busy': busy === card.id }"
          draggable="true"
          :data-testid="`project-board-card-${card.id}`"
          @dragstart="onDragStart(card, $event)"
          @dragend="dragging = null; over = null"
        >
          <div class="project-board-card-head">
            <AgentStatusIcon v-if="card.kind === 'thread'" :status="threadDisplayStatus(card.thread.liveStatus)" :live="card.thread.liveStatus !== 'idle' && card.thread.liveStatus !== 'gone'" />
            <button v-if="card.kind === 'thread'" type="button" class="project-board-card-title project-board-link" @click="emit('select', card.id)">{{ card.title }}</button>
            <span v-else class="project-board-card-title">{{ card.title }}</span>
          </div>
          <p v-if="card.kind === 'task' && card.task.notes" class="project-board-notes">{{ card.task.notes }}</p>
          <div class="project-board-chips">
            <span class="project-board-chip">{{ card.kind === 'thread' ? `${t('projects.board.thread')} · ${card.thread.agent}${card.thread.model ? ` · ${card.thread.model}` : ''}` : t('projects.board.task') }}</span>
            <a v-if="card.pr" class="project-board-chip project-board-chip--pr" :href="card.pr" target="_blank" rel="noopener noreferrer" :title="card.pr" :aria-label="`${t('projects.board.openPr')} ${prLabel(card.pr)} ${prWords(card.pr)?.state || ''}`" data-testid="project-board-pr-link">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="6" cy="6" r="2" /><circle cx="6" cy="18" r="2" /><circle cx="18" cy="18" r="2" /><path d="M6 8v8M18 16V9a3 3 0 0 0-3-3h-4M13 4l-2 2 2 2" /></svg>
              {{ prLabel(card.pr) }}<template v-if="prWords(card.pr)?.state"> · {{ prWords(card.pr)!.state }}</template>
            </a>
            <span v-if="prWords(card.pr)?.checks" class="project-board-chip" :class="`project-board-chip--checks-${prWords(card.pr)!.checksKey}`" :data-testid="`project-board-checks-${card.id}`">{{ prWords(card.pr)!.checks }}</span>
            <span v-if="prWords(card.pr)?.conflicts" class="project-board-chip project-board-chip--checks-failing">{{ t('projects.board.conflicts') }}</span>
            <span v-if="prWords(card.pr)?.error" class="project-board-chip project-board-chip--muted" :title="prWords(card.pr)!.error">?</span>
            <button v-if="!card.pr" type="button" class="project-board-chip project-board-chip--add" :data-testid="`project-board-add-pr-${card.id}`" @click="editPr(card)">+ {{ t('projects.board.pr') }}</button>
          </div>
          <form v-if="prEditing === card.id" class="project-board-pr-form" @submit.prevent="savePr(card)">
            <NInput v-model:value="prDraft" size="tiny" :placeholder="t('projects.board.prPlaceholder')" :input-props="{ 'aria-label': t('projects.board.pr') }" :data-testid="`project-board-pr-input-${card.id}`" />
            <NButton size="tiny" type="primary" attr-type="submit">{{ t('projects.board.add') }}</NButton>
            <NButton size="tiny" quaternary @click="prEditing = ''">{{ t('projects.board.cancel') }}</NButton>
          </form>
          <div class="project-board-actions">
            <select class="project-board-move" :aria-label="t('projects.board.move')" :data-testid="`project-board-move-${card.id}`" @change="onMoveSelect(card, $event)">
              <option value="">{{ t('projects.board.move') }}…</option>
              <option v-for="target in boardTargets(card).filter(item => item !== card.column)" :key="target" :value="target">{{ t(`projects.board.columns.${target}`) }}</option>
            </select>
            <NButton v-if="card.kind === 'task' && card.column === 'todo'" size="tiny" secondary :loading="busy === card.id" :data-testid="`project-board-start-${card.id}`" @click="startTask(card)">{{ t('projects.board.start') }}</NButton>
            <button v-if="card.kind === 'task'" type="button" class="project-board-remove" :aria-label="t('projects.board.remove')" :title="t('projects.board.remove')" @click="removeTask(card)">✕</button>
          </div>
        </article>
      </section>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.project-board {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
  gap: 8px;
  padding: 8px 12px 12px;
}
.project-board-toolbar { display: flex; gap: 8px; }
.project-board-form,
.project-board-pr-form {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  width: 100%;

  > :first-child { flex: 1 1 200px; }
}
.project-board-pr-form > :first-child { flex-basis: 140px; }
.project-board-columns {
  display: grid;
  flex: 1;
  grid-auto-columns: minmax(150px, 1fr);
  grid-auto-flow: column;
  gap: 8px;
  min-height: 0;
  overflow: auto;
}
.project-board-column {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-height: 120px;
  padding: 8px;
  border: var(--border-width, 1px) solid $border-light;
  border-radius: var(--radius-component, 8px);
  background-color: $bg-secondary;
  overflow-y: auto;

  &--over { border-color: $accent-primary; }
  &--needsYou .project-board-count { border-color: $warning; color: $text-primary; }
}
.project-board-column-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 0 0 2px;
  font-size: 12px;
  font-weight: 600;
  color: $text-secondary;
}
.project-board-count {
  padding: 0 6px;
  border: var(--border-width, 1px) solid $border-light;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 500;
}
.project-board-empty { margin: 4px 0; font-size: 12px; color: $text-muted; }
.project-board-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px;
  border: var(--border-width, 1px) solid $border-light;
  border-radius: var(--radius-component, 8px);
  background-color: var(--theme-content-bg, $bg-main-surface);
  cursor: grab;

  &--busy { opacity: 0.6; }
}
.project-board-card-head { display: flex; align-items: flex-start; gap: 6px; }
.project-board-card-title {
  font-size: 13px;
  font-weight: 500;
  line-height: 1.35;
  color: $text-primary;
  overflow-wrap: anywhere;
}
.project-board-link {
  border: 0;
  background: none;
  font: inherit;
  padding: 0;
  text-align: start;
  cursor: pointer;

  &:hover { text-decoration: underline; }
  &:focus-visible { outline: 2px solid $accent-primary; outline-offset: 2px; }
}
.project-board-notes {
  margin: 0;
  font-size: 12px;
  color: $text-secondary;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.project-board-chips { display: flex; flex-wrap: wrap; gap: 4px; }
.project-board-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 0 6px;
  border: var(--border-width, 1px) solid $border-light;
  border-radius: 999px;
  background: none;
  font: inherit;
  font-size: 11px;
  line-height: 18px;
  color: $text-secondary;
  text-decoration: none;

  &--pr { border-color: $accent-primary; color: $text-primary; }
  &--add { cursor: pointer; border-style: dashed; }
  &--checks-passing { border-color: $success; color: $text-primary; }
  &--checks-failing { border-color: $error; color: $text-primary; }
  &--checks-pending { border-color: $warning; color: $text-primary; }
  &--muted { color: $text-muted; }
  &:focus-visible { outline: 2px solid $accent-primary; outline-offset: 1px; }
}
.project-board-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.project-board-move {
  flex: 1 1 100px;
  min-width: 0;
  min-height: 24px;
  border: var(--border-width, 1px) solid $border-light;
  border-radius: var(--radius-component, 6px);
  background-color: var(--theme-content-bg, $bg-main-surface);
  color: $text-secondary;
  font: inherit;
  font-size: 12px;
}
.project-board-remove {
  border: 0;
  background: none;
  font: inherit;
  min-width: 24px;
  min-height: 24px;
  color: $text-muted;
  cursor: pointer;

  &:hover { color: $text-primary; }
  &:focus-visible { outline: 2px solid $accent-primary; outline-offset: 1px; }
}
</style>
