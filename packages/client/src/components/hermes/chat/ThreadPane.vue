<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { NButton, NInput, NSelect, type SelectOption, type SelectGroupOption } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import AgentStatusIcon from '@/components/common/AgentStatusIcon.vue'
import MarkdownRenderer from './MarkdownRenderer.vue'
import { getProject, messageProjectThread, readProjectThread, type Project, type ProjectThread, type ThreadMessage } from '@/api/studio/projects'
import { THREAD_GROUPS, groupThreads, threadDisplayStatus, threadGroup } from './project-groups'

// A project's threads beside its coordinator: one thread's latest messages (read
// and sent through the project API) or, with no thread picked, all of them at a
// glance. The switcher in the header moves between them.
const props = defineProps<{ projectId: string; threadId: string | null; initialThread?: ProjectThread | null }>()
const emit = defineEmits<{ open: [sessionId: string]; close: []; select: [threadId: string | null] }>()
const { t } = useI18n()

const POLL_MS = 3000
const ALL = '__all'
const project = ref<Project | null>(null)
const messages = ref<ThreadMessage[]>([])
const lastWords = ref<Record<string, string>>({})
const draft = ref('')
const sending = ref(false)
const error = ref('')
const listRef = ref<HTMLElement | null>(null)
let timer: ReturnType<typeof setInterval> | null = null
let request = 0

const live = computed<ProjectThread | null>(() => {
  if (!props.threadId) return null
  return project.value?.threads.find(item => item.id === props.threadId)
    ?? (props.initialThread?.id === props.threadId ? props.initialThread : null)
})
const status = computed(() => live.value?.liveStatus ?? 'unknown')
const blocked = computed(() => status.value === 'blocked')
const hasChat = computed(() => !!live.value?.sessionId)
const groups = computed(() => groupThreads(project.value?.threads ?? []))
const openCount = computed(() => (project.value?.threads ?? []).filter(item => !item.resolved).length)

const switcherOptions = computed<Array<SelectOption | SelectGroupOption>>(() => [
  { label: t('projects.pane.allThreads', { n: openCount.value }), value: ALL },
  ...THREAD_GROUPS
    .filter(group => groups.value[group].length)
    .map(group => ({
      type: 'group' as const,
      key: group,
      label: t(`projects.groups.${group}`),
      children: groups.value[group].map(item => ({ label: item.title, value: item.id })),
    })),
])

function statusLabel(thread: ProjectThread): string {
  if (thread.liveStatus === 'starting') return t('projects.starting')
  return t(`projects.groups.${threadGroup(thread)}`)
}

async function load() {
  const id = ++request
  try {
    const selected = props.threadId
    const [loaded, thread] = await Promise.all([
      getProject(props.projectId),
      selected ? readProjectThread(props.projectId, selected) : Promise.resolve(null),
    ])
    if (id !== request) return
    project.value = loaded
    error.value = ''
    if (thread) {
      const grew = thread.messages.length !== messages.value.length || thread.messages.at(-1)?.text !== messages.value.at(-1)?.text
      messages.value = thread.messages
      if (grew) await scrollToEnd()
    } else {
      await loadLastWords(loaded, id)
    }
  } catch (err: any) {
    if (id === request) error.value = t('projects.failed', { error: err?.message || String(err) })
  }
}

/** Each open thread's last agent message, for the overview (the 30 most recent). */
async function loadLastWords(loaded: Project, id: number) {
  const threads = loaded.threads.filter(item => item.sessionId).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 30)
  const results = await Promise.all(threads.map(item => readProjectThread(loaded.id, item.id, 2).catch(() => null)))
  if (id !== request) return
  const next: Record<string, string> = {}
  threads.forEach((item, index) => {
    const text = results[index]?.messages.filter(row => row.role !== 'user').at(-1)?.text
    if (text) next[item.id] = text
  })
  lastWords.value = next
}

async function scrollToEnd() {
  await nextTick()
  const list = listRef.value
  if (list) list.scrollTop = list.scrollHeight
}

async function send() {
  const text = draft.value.trim()
  if (!text || sending.value || blocked.value || !props.threadId) return
  sending.value = true
  try {
    await messageProjectThread(props.projectId, props.threadId, text)
    draft.value = ''
    messages.value = [...messages.value, { role: 'user', text }]
    await scrollToEnd()
  } catch (err: any) {
    error.value = t('projects.failed', { error: err?.message || String(err) })
  } finally {
    sending.value = false
  }
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault()
    void send()
  }
}

function pick(value: string) {
  emit('select', value === ALL ? null : value)
}

function tick() {
  if (document.visibilityState === 'visible') void load()
}

watch(() => [props.projectId, props.threadId], () => {
  messages.value = []
  draft.value = ''
  error.value = ''
  void load()
})

onMounted(() => {
  void load()
  timer = setInterval(tick, POLL_MS)
})
onUnmounted(() => {
  if (timer) clearInterval(timer)
  request += 1
})
</script>

<template>
  <aside class="thread-pane" :aria-label="t('projects.pane.label')" data-testid="thread-pane">
    <header class="thread-pane-head">
      <AgentStatusIcon v-if="live" :status="threadDisplayStatus(status)" :live="status !== 'idle' && status !== 'gone'" />
      <div class="thread-pane-title">
        <NSelect
          class="thread-pane-switcher"
          size="small"
          :value="threadId ?? ALL"
          :options="switcherOptions"
          :consistent-menu-width="false"
          :aria-label="t('projects.pane.switch')"
          data-testid="thread-pane-switcher"
          @update:value="pick"
        />
        <span v-if="live" class="thread-pane-meta" :title="live.workspace">{{ live.agent }}<template v-if="live.branch"> · {{ live.branch }}</template> · {{ statusLabel(live) }}</span>
      </div>
      <NButton v-if="live" size="small" quaternary :disabled="!hasChat" data-testid="thread-pane-open" @click="emit('open', live.sessionId)">
        {{ t('projects.pane.openChat') }}
      </NButton>
      <button type="button" class="thread-pane-close" :aria-label="t('projects.pane.close')" :title="t('projects.pane.close')" data-testid="thread-pane-close" @click="emit('close')">✕</button>
    </header>

    <div v-if="!threadId" class="thread-pane-overview" data-testid="thread-pane-all">
      <p v-if="project && !project.threads.length" class="thread-pane-note">{{ t('projects.pane.noThreads') }}</p>
      <template v-for="group in THREAD_GROUPS" :key="group">
        <section v-if="groups[group].length" class="thread-pane-group">
          <h3 class="thread-pane-group-title">{{ t(`projects.groups.${group}`) }} · {{ groups[group].length }}</h3>
          <button
            v-for="item in groups[group]"
            :key="item.id"
            type="button"
            class="thread-pane-card"
            :class="{ 'thread-pane-card--resolved': item.resolved }"
            :data-testid="`thread-pane-card-${item.id}`"
            @click="emit('select', item.id)"
          >
            <span class="thread-pane-card-head">
              <AgentStatusIcon :status="threadDisplayStatus(item.liveStatus)" :live="item.liveStatus !== 'idle' && item.liveStatus !== 'gone'" />
              <span class="thread-pane-card-title">{{ item.title }}</span>
              <span class="thread-pane-card-state">{{ statusLabel(item) }}</span>
            </span>
            <span class="thread-pane-meta">{{ item.agent }}<template v-if="item.branch"> · {{ item.branch }}</template></span>
            <span v-if="lastWords[item.id]" class="thread-pane-card-last">{{ lastWords[item.id] }}</span>
          </button>
        </section>
      </template>
    </div>

    <template v-else>

    <div ref="listRef" class="thread-pane-messages" role="log" aria-live="polite">
      <p v-if="!hasChat" class="thread-pane-note">{{ t('projects.pane.starting') }}</p>
      <p v-else-if="!messages.length" class="thread-pane-note">{{ t('projects.pane.empty') }}</p>
      <div
        v-for="(item, index) in messages"
        :key="index"
        class="thread-pane-message"
        :class="item.role === 'user' ? 'thread-pane-message--user' : 'thread-pane-message--agent'"
      >
        <span class="thread-pane-role">{{ item.role === 'user' ? t('projects.pane.you') : live?.agent }}</span>
        <MarkdownRenderer :content="item.text" />
      </div>
    </div>

    <p v-if="error" class="thread-pane-error" role="alert">{{ error }}</p>
    <div v-if="blocked" class="thread-pane-blocked" role="status">
      <span>{{ t('projects.pane.blocked') }}</span>
      <NButton size="small" :disabled="!hasChat" @click="live && emit('open', live.sessionId)">{{ t('projects.pane.openChat') }}</NButton>
    </div>
    <footer v-else class="thread-pane-input">
      <NInput
        v-model:value="draft"
        type="textarea"
        :autosize="{ minRows: 1, maxRows: 6 }"
        :placeholder="t('projects.pane.placeholder')"
        :disabled="sending"
        data-testid="thread-pane-input"
        @keydown="onKeydown"
      />
      <NButton type="primary" :loading="sending" :disabled="!draft.trim()" data-testid="thread-pane-send" @click="send">
        {{ t('projects.pane.send') }}
      </NButton>
    </footer>
    </template>
    <p v-if="error && !threadId" class="thread-pane-error" role="alert">{{ error }}</p>
  </aside>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.thread-pane {
  display: flex;
  flex: 0 0 clamp(320px, 42%, 640px);
  flex-direction: column;
  min-width: 0;
  border-inline-start: var(--border-width, 1px) solid $border-light;
  background-color: var(--theme-content-bg, $bg-main-surface);
}

.thread-pane-head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 48px;
  padding: 6px 8px 6px 12px;
  border-bottom: var(--border-width, 1px) solid $border-light;
}

.thread-pane-title {
  display: flex;
  flex: 1;
  min-width: 0;
  flex-direction: column;
  line-height: 1.3;
}

.thread-pane-name {
  overflow: hidden;
  font-weight: 600;
  font-size: 13px;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.thread-pane-switcher {
  max-width: 100%;
}

.thread-pane-overview {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 14px;
  overflow-y: auto;
  padding: 12px;
}

.thread-pane-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.thread-pane-group-title {
  margin: 0;
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.02em;
  text-transform: uppercase;
  color: $text-muted;
}

.thread-pane-card {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-height: 44px;
  padding: 8px 10px;
  border: var(--border-width, 1px) solid $border-light;
  border-radius: var(--radius-component, 8px);
  text-align: start;

  &:hover { background-color: $bg-secondary; }
  &:focus-visible { outline: 2px solid $accent-primary; outline-offset: -2px; }
  &--resolved { opacity: 0.7; }
}

.thread-pane-card-head {
  display: flex;
  align-items: center;
  gap: 6px;
}

.thread-pane-card-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  font-weight: 600;
  font-size: 13px;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.thread-pane-card-state {
  flex: none;
  font-size: 11px;
  color: $text-secondary;
}

.thread-pane-card-last {
  display: -webkit-box;
  overflow: hidden;
  font-size: 12px;
  color: $text-secondary;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.thread-pane-meta {
  font-size: 11px;
  color: $text-muted;
}

.thread-pane-close {
  flex: none;
  width: 44px;
  height: 44px;
  color: $text-muted;

  &:hover { color: $text-primary; }
  &:focus-visible { outline: 2px solid $accent-primary; outline-offset: -2px; }
}

.thread-pane-messages {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 12px;
  overflow-y: auto;
  padding: 12px;
}

.thread-pane-note {
  margin: 0;
  font-size: 13px;
  color: $text-secondary;
}

.thread-pane-message {
  max-width: 92%;
  padding: 8px 12px;
  border-radius: var(--radius-component, 8px);
  font-size: 13px;
  background-color: $bg-secondary;

  &--user { align-self: flex-end; }
  &--agent { align-self: flex-start; }
}

.thread-pane-role {
  display: block;
  margin-bottom: 2px;
  font-size: 11px;
  color: $text-muted;
}

.thread-pane-error {
  margin: 0;
  padding: 6px 12px;
  font-size: 12px;
  color: $error;
}

.thread-pane-blocked {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-top: var(--border-width, 1px) solid $warning;
  font-size: 13px;

  span { flex: 1; }
}

.thread-pane-input {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  padding: 10px 12px;
  border-top: var(--border-width, 1px) solid $border-light;
}
</style>
