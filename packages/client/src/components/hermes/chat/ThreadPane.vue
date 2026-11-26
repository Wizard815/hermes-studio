<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { NButton, NInput } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import AgentStatusIcon from '@/components/common/AgentStatusIcon.vue'
import MarkdownRenderer from './MarkdownRenderer.vue'
import { messageProjectThread, readProjectThread, type ProjectThread, type ThreadMessage } from '@/api/studio/projects'
import { threadDisplayStatus } from './project-groups'

// A project's thread beside its coordinator: the latest messages, read and sent
// through the project API, so the main chat can stay on the coordinator.
const props = defineProps<{ projectId: string; thread: ProjectThread }>()
const emit = defineEmits<{ open: [sessionId: string]; close: [] }>()
const { t } = useI18n()

const POLL_MS = 3000
const messages = ref<ThreadMessage[]>([])
const live = ref<ProjectThread>(props.thread)
const status = computed(() => live.value.liveStatus)
const draft = ref('')
const sending = ref(false)
const error = ref('')
const listRef = ref<HTMLElement | null>(null)
let timer: ReturnType<typeof setInterval> | null = null
let request = 0

const blocked = computed(() => status.value === 'blocked')
const hasChat = computed(() => !!live.value.sessionId)

async function load() {
  const id = ++request
  try {
    const result = await readProjectThread(props.projectId, props.thread.id)
    if (id !== request) return
    const grew = result.messages.length !== messages.value.length || result.messages.at(-1)?.text !== messages.value.at(-1)?.text
    messages.value = result.messages
    live.value = result.thread
    error.value = ''
    if (grew) await scrollToEnd()
  } catch (err: any) {
    if (id === request) error.value = t('projects.failed', { error: err?.message || String(err) })
  }
}

async function scrollToEnd() {
  await nextTick()
  const list = listRef.value
  if (list) list.scrollTop = list.scrollHeight
}

async function send() {
  const text = draft.value.trim()
  if (!text || sending.value || blocked.value) return
  sending.value = true
  try {
    await messageProjectThread(props.projectId, props.thread.id, text)
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

function tick() {
  if (document.visibilityState === 'visible') void load()
}

watch(() => props.thread.id, () => {
  messages.value = []
  draft.value = ''
  error.value = ''
  live.value = props.thread
  void load()
})
watch(() => props.thread, value => { if (value.id === live.value.id && value.updatedAt >= live.value.updatedAt) live.value = value })

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
      <AgentStatusIcon :status="threadDisplayStatus(status)" :live="status !== 'idle' && status !== 'gone'" />
      <div class="thread-pane-title">
        <span class="thread-pane-name">{{ thread.title }}</span>
        <span class="thread-pane-meta" :title="live.workspace">{{ thread.agent }}<template v-if="live.branch"> · {{ live.branch }}</template> · {{ t(`projects.groups.${blocked ? 'needsYou' : status === 'done' ? 'done' : 'working'}`) }}</span>
      </div>
      <NButton size="small" quaternary :disabled="!hasChat" data-testid="thread-pane-open" @click="emit('open', live.sessionId)">
        {{ t('projects.pane.openChat') }}
      </NButton>
      <button type="button" class="thread-pane-close" :aria-label="t('projects.pane.close')" :title="t('projects.pane.close')" data-testid="thread-pane-close" @click="emit('close')">✕</button>
    </header>

    <div ref="listRef" class="thread-pane-messages" role="log" aria-live="polite">
      <p v-if="!hasChat" class="thread-pane-note">{{ t('projects.pane.starting') }}</p>
      <p v-else-if="!messages.length" class="thread-pane-note">{{ t('projects.pane.empty') }}</p>
      <div
        v-for="(item, index) in messages"
        :key="index"
        class="thread-pane-message"
        :class="item.role === 'user' ? 'thread-pane-message--user' : 'thread-pane-message--agent'"
      >
        <span class="thread-pane-role">{{ item.role === 'user' ? t('projects.pane.you') : thread.agent }}</span>
        <MarkdownRenderer :content="item.text" />
      </div>
    </div>

    <p v-if="error" class="thread-pane-error" role="alert">{{ error }}</p>
    <div v-if="blocked" class="thread-pane-blocked" role="status">
      <span>{{ t('projects.pane.blocked') }}</span>
      <NButton size="small" :disabled="!hasChat" @click="emit('open', live.sessionId)">{{ t('projects.pane.openChat') }}</NButton>
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
