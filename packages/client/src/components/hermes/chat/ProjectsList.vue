<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import { NButton, NForm, NFormItem, NInput, NModal, NPopconfirm, NSelect, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import AgentStatusIcon from '@/components/common/AgentStatusIcon.vue'
import {
  createProject,
  listProjects,
  removeProject,
  setThreadResolved,
  startProjectThread,
  updateProject,
  type Project,
  type ProjectThread,
} from '@/api/studio/projects'
import { THREAD_AGENTS, THREAD_GROUPS, groupThreads, projectSummary, threadDisplayStatus } from './project-groups'

/**
 * Projects in the chat list (the chat menu's Projects view): each project is a
 * coordinator chat plus threads whose agents run in herdr. Opening one opens
 * its chat in the normal chat view. With threadsInPane, a thread opens in the
 * pane beside its coordinator instead. See docs/projects.md.
 */
const props = defineProps<{
  /** The chat open in the chat view, to mark its row. */
  activeSessionId: string | null
  /** Threads open beside the coordinator (wide screens) instead of replacing it. */
  threadsInPane?: boolean
  /** The thread shown in that pane, to mark its row. */
  paneThreadId?: string | null
}>()

const emit = defineEmits<{
  open: [sessionId: string]
  thread: [project: Project, thread: ProjectThread]
  back: []
}>()

const { t } = useI18n()
const message = useMessage()
const projects = ref<Project[]>([])
const loading = ref(true)
const loadError = ref('')
const expanded = ref<Set<string>>(new Set(readExpanded()))

function readExpanded(): string[] {
  try { return JSON.parse(localStorage.getItem('studio_projects_expanded') || '[]') } catch { return [] }
}

function toggle(id: string) {
  const next = new Set(expanded.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  expanded.value = next
  try { localStorage.setItem('studio_projects_expanded', JSON.stringify([...next])) } catch { /* private mode */ }
}

async function refresh() {
  try {
    projects.value = await listProjects()
    loadError.value = ''
  } catch (error: any) {
    loadError.value = error?.message || String(error)
  } finally {
    loading.value = false
  }
}

let timer: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  void refresh()
  // Thread states come from herdr; a few seconds behind is fine for a list.
  timer = setInterval(() => { if (document.visibilityState === 'visible') void refresh() }, 5000)
})
onUnmounted(() => { if (timer) clearInterval(timer) })

const sorted = computed(() => [...projects.value].sort((a, b) => b.updatedAt - a.updatedAt))
const agentOptions = computed(() => THREAD_AGENTS.map(value => ({ label: value, value })))

function openThread(project: Project, thread: ProjectThread) {
  if (props.threadsInPane) emit('thread', project, thread)
  else if (thread.sessionId) emit('open', thread.sessionId)
}

function threadActive(thread: ProjectThread): boolean {
  if (props.threadsInPane && props.paneThreadId === thread.id) return true
  return !!thread.sessionId && props.activeSessionId === thread.sessionId
}

// --- New / edit project ---
const projectForm = reactive({ show: false, editing: '' as string, name: '', folder: '', instructions: '', defaultAgent: 'claude-code', saving: false })

function openNewProject() {
  Object.assign(projectForm, { show: true, editing: '', name: '', folder: '', instructions: '', defaultAgent: 'claude-code', saving: false })
}

function openEditProject(project: Project) {
  Object.assign(projectForm, {
    show: true, editing: project.id, name: project.name, folder: project.folder,
    instructions: project.instructions, defaultAgent: project.defaultAgent, saving: false,
  })
}

async function saveProject() {
  if (!projectForm.name.trim()) return
  projectForm.saving = true
  try {
    const input = { name: projectForm.name, folder: projectForm.folder, instructions: projectForm.instructions, defaultAgent: projectForm.defaultAgent }
    const saved = projectForm.editing ? await updateProject(projectForm.editing, input) : await createProject(input)
    projectForm.show = false
    await refresh()
    if (!projectForm.editing) {
      if (!expanded.value.has(saved.id)) toggle(saved.id)
      emit('open', saved.coordinatorSessionId)
    }
  } catch (error: any) {
    message.error(t('projects.failed', { error: error?.message || String(error) }))
  } finally {
    projectForm.saving = false
  }
}

async function stopProject(project: Project) {
  try {
    await removeProject(project.id)
    await refresh()
  } catch (error: any) {
    message.error(t('projects.failed', { error: error?.message || String(error) }))
  }
}

// --- New thread ---
const threadForm = reactive({ show: false, projectId: '', title: '', brief: '', agent: 'claude-code', saving: false })

function openNewThread(project: Project) {
  Object.assign(threadForm, { show: true, projectId: project.id, title: '', brief: '', agent: project.defaultAgent, saving: false })
}

async function saveThread() {
  if (!threadForm.brief.trim()) return
  threadForm.saving = true
  try {
    await startProjectThread(threadForm.projectId, { title: threadForm.title, brief: threadForm.brief, agent: threadForm.agent })
    threadForm.show = false
    message.success(t('projects.threadStarted'))
    await refresh()
  } catch (error: any) {
    message.error(t('projects.failed', { error: error?.message || String(error) }))
  } finally {
    threadForm.saving = false
  }
}

async function toggleResolved(project: Project, thread: ProjectThread) {
  try {
    await setThreadResolved(project.id, thread.id, !thread.resolved)
    await refresh()
  } catch (error: any) {
    message.error(t('projects.failed', { error: error?.message || String(error) }))
  }
}

defineExpose({ refresh })
</script>

<template>
  <div class="projects-list" data-testid="projects-list">
    <div class="projects-head">
      <button type="button" class="projects-back" data-testid="projects-back" @click="emit('back')">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><polyline points="15 18 9 12 15 6" /></svg>
        <span>{{ t('projects.back') }}</span>
      </button>
      <button type="button" class="projects-new" data-testid="projects-new" @click="openNewProject">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
        <span>{{ t('projects.newProject') }}</span>
      </button>
    </div>

    <div v-if="loadError" class="projects-note" role="alert">
      <span>{{ t('projects.failed', { error: loadError }) }}</span>
      <button type="button" class="projects-link" @click="refresh">{{ t('common.retry') }}</button>
    </div>
    <p v-else-if="!loading && !projects.length" class="projects-note" data-testid="projects-empty">{{ t('projects.empty') }}</p>

    <section v-for="project in sorted" :key="project.id" class="project" :data-testid="`project-${project.id}`">
      <div class="project-row">
        <button
          type="button"
          class="project-toggle"
          :aria-expanded="expanded.has(project.id)"
          @click="toggle(project.id)"
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="project-chevron" :class="{ open: expanded.has(project.id) }" aria-hidden="true"><polyline points="9 18 15 12 9 6" /></svg>
          <span class="project-name">{{ project.name }}</span>
        </button>
        <div v-if="projectSummary(project).length" class="project-badges">
          <span v-for="item in projectSummary(project)" :key="item.key" class="project-badge" :class="`project-badge--${item.key}`">
            {{ t(`projects.badge.${item.key}`, { n: item.count }) }}
          </span>
        </div>
      </div>

      <div v-if="expanded.has(project.id)" class="project-body">
        <button
          type="button"
          class="project-item project-item--coordinator"
          :class="{ active: props.activeSessionId === project.coordinatorSessionId }"
          :aria-current="props.activeSessionId === project.coordinatorSessionId ? 'page' : undefined"
          data-testid="project-coordinator"
          @click="emit('open', project.coordinatorSessionId)"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
          <span class="project-item-title">{{ t('projects.coordinator') }}</span>
        </button>
        <div class="project-actions">
          <button type="button" class="projects-link" data-testid="project-new-thread" @click="openNewThread(project)">+ {{ t('projects.newThread') }}</button>
          <button type="button" class="projects-link" @click="openEditProject(project)">{{ t('projects.edit') }}</button>
          <NPopconfirm @positive-click="stopProject(project)">
            <template #trigger>
              <button type="button" class="projects-link">{{ t('projects.remove') }}</button>
            </template>
            {{ t('projects.removeConfirm', { name: project.name }) }}
          </NPopconfirm>
        </div>

        <template v-for="group in THREAD_GROUPS" :key="group">
          <template v-if="groupThreads(project.threads)[group].length">
            <div class="project-group">{{ t(`projects.groups.${group}`) }}</div>
            <div
              v-for="thread in groupThreads(project.threads)[group]"
              :key="thread.id"
              class="project-item project-thread"
              :class="{ active: threadActive(thread) }"
              :data-testid="`project-thread-${thread.id}`"
            >
              <button
                type="button"
                class="project-thread-open"
                :disabled="!thread.sessionId && !props.threadsInPane"
                :title="thread.sessionId || props.threadsInPane ? thread.title : t('projects.threadNoChat')"
                :aria-current="threadActive(thread) ? 'page' : undefined"
                @click="openThread(project, thread)"
              >
                <AgentStatusIcon :status="threadDisplayStatus(thread.liveStatus)" :live="thread.liveStatus !== 'idle' && thread.liveStatus !== 'gone'" />
                <span class="project-thread-text">
                  <span class="project-item-title">{{ thread.title }}</span>
                  <span class="project-item-meta">{{ thread.liveStatus === 'starting' ? t('projects.starting') : thread.agent }}</span>
                </span>
              </button>
              <button
                type="button"
                class="project-thread-resolve"
                :aria-label="thread.resolved ? t('projects.reopen') : t('projects.resolve')"
                :title="thread.resolved ? t('projects.reopen') : t('projects.resolve')"
                @click="toggleResolved(project, thread)"
              >{{ thread.resolved ? '↺' : '✓' }}</button>
            </div>
          </template>
        </template>
      </div>
    </section>

    <NModal v-model:show="projectForm.show" preset="card" :title="projectForm.editing ? t('projects.edit') : t('projects.newProject')" style="max-width: 520px">
      <NForm label-placement="top" @submit.prevent="saveProject">
        <NFormItem :label="t('projects.form.name')" required>
          <NInput v-model:value="projectForm.name" :maxlength="80" data-testid="project-form-name" />
        </NFormItem>
        <NFormItem :label="t('projects.form.folder')" :feedback="t('projects.form.folderHint')">
          <NInput v-model:value="projectForm.folder" placeholder="~/code/my-app" />
        </NFormItem>
        <NFormItem :label="t('projects.form.instructions')" :feedback="t('projects.form.instructionsHint')">
          <NInput v-model:value="projectForm.instructions" type="textarea" :autosize="{ minRows: 3, maxRows: 10 }" :maxlength="8000" />
        </NFormItem>
        <NFormItem :label="t('projects.form.defaultAgent')">
          <NSelect v-model:value="projectForm.defaultAgent" :options="agentOptions" filterable tag />
        </NFormItem>
      </NForm>
      <template #footer>
        <div class="projects-modal-actions">
          <NButton @click="projectForm.show = false">{{ t('projects.cancel') }}</NButton>
          <NButton type="primary" :loading="projectForm.saving" :disabled="!projectForm.name.trim()" data-testid="project-form-save" @click="saveProject">
            {{ projectForm.editing ? t('projects.save') : t('projects.create') }}
          </NButton>
        </div>
      </template>
    </NModal>

    <NModal v-model:show="threadForm.show" preset="card" :title="t('projects.newThread')" style="max-width: 560px">
      <NForm label-placement="top" @submit.prevent="saveThread">
        <NFormItem :label="t('projects.form.threadTitle')">
          <NInput v-model:value="threadForm.title" :maxlength="120" />
        </NFormItem>
        <NFormItem :label="t('projects.form.brief')" :feedback="t('projects.form.briefHint')" required>
          <NInput v-model:value="threadForm.brief" type="textarea" :autosize="{ minRows: 4, maxRows: 14 }" data-testid="thread-form-brief" />
        </NFormItem>
        <NFormItem :label="t('projects.form.agent')">
          <NSelect v-model:value="threadForm.agent" :options="agentOptions" filterable tag />
        </NFormItem>
      </NForm>
      <template #footer>
        <div class="projects-modal-actions">
          <NButton @click="threadForm.show = false">{{ t('projects.cancel') }}</NButton>
          <NButton type="primary" :loading="threadForm.saving" :disabled="!threadForm.brief.trim()" data-testid="thread-form-start" @click="saveThread">
            {{ t('projects.start') }}
          </NButton>
        </div>
      </template>
    </NModal>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.projects-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 4px 0;
  color: $text-primary;
}

.projects-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 2px 8px 6px;
}

.projects-back,
.projects-new,
.projects-link,
.project-toggle,
.project-item,
.project-thread-open,
.project-thread-resolve {
  font: inherit;
  color: inherit;
  background: none;
  border: 0;
  cursor: pointer;
}

.projects-back,
.projects-new {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-height: 32px;
  padding: 4px 6px;
  border-radius: var(--radius-component, 6px);
  font-size: 12px;
  color: $text-secondary;

  &:hover { color: $text-primary; }
}

.projects-link {
  padding: 2px 4px;
  font-size: 12px;
  color: $text-secondary;
  text-decoration: underline;
  text-underline-offset: 2px;

  &:hover { color: $text-primary; }
}

.projects-note {
  margin: 4px 12px;
  font-size: 12px;
  line-height: 1.5;
  color: $text-secondary;
}

.project-row {
  display: flex;
  flex-direction: column;
  padding: 0 8px;
}

// Counts sit under the name so a long name and three counts both fit.
.project-badges {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding: 0 0 4px 16px;
}

.project-toggle {
  display: flex;
  flex: 1;
  min-width: 0;
  align-items: center;
  gap: 6px;
  min-height: 32px;
  text-align: start;
}

.project-chevron {
  flex: none;
  transition: transform 0.15s ease;

  &.open { transform: rotate(90deg); }
}

.project-name {
  overflow: hidden;
  font-weight: 600;
  font-size: 13px;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.project-badge {
  flex: none;
  padding: 0 6px;
  border: var(--border-width, 1px) solid $border-light;
  border-radius: 999px;
  font-size: 11px;
  line-height: 18px;
  color: $text-secondary;

  &--needsYou {
    border-color: $warning;
    color: $text-primary;
  }
}

.project-body {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 0 0 6px 10px;
}

.project-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding: 0 8px 2px 4px;
}

.project-group {
  padding: 6px 8px 2px;
  font-size: 11px;
  letter-spacing: 0.02em;
  text-transform: uppercase;
  color: $text-muted;
}

.project-item {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 32px;
  padding: 0 8px;
  border-radius: var(--radius-component, 6px);
  text-align: start;

  &.active { box-shadow: inset 2px 0 0 $accent-primary; }
}

.project-thread {
  padding: 0;
}

.project-thread-open {
  display: flex;
  flex: 1;
  min-width: 0;
  align-items: center;
  gap: 6px;
  min-height: 32px;
  padding: 0 8px;
  text-align: start;

  &:disabled { cursor: default; color: $text-secondary; }
}

.project-thread-text {
  display: flex;
  flex: 1;
  min-width: 0;
  flex-direction: column;
  padding: 3px 0;
  line-height: 1.3;
}

.project-item-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  font-size: 13px;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.project-item-meta {
  flex: none;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: 11px;
  color: $text-muted;
}

.project-thread-resolve {
  flex: none;
  width: 32px;
  height: 32px;
  font-size: 12px;
  color: $text-muted;

  &:hover { color: $text-primary; }
}

.projects-back:focus-visible,
.projects-new:focus-visible,
.projects-link:focus-visible,
.project-toggle:focus-visible,
.project-item:focus-visible,
.project-thread-open:focus-visible,
.project-thread-resolve:focus-visible {
  outline: 2px solid $accent-primary;
  outline-offset: -2px;
}

.projects-modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
