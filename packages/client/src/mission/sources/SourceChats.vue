<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref } from 'vue'
import { NButton, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import AgentStatusIcon from '@/components/common/AgentStatusIcon.vue'
import { fetchSessions, type SessionSummary } from '@/api/studio/sessions'
import { openSessionInHerdr } from '@/api/coding-agents/herdr'
import { useSessionStateStore } from '@/stores/hermes/session-state'
import { useHerdrStore } from '@/stores/hermes/herdr'
import { studioUrl } from '../useMission'
import { herdrCanOpenChat } from '../useFolders'

/**
 * Every Studio chat with live status. Chats elevated to herdr are marked
 * "herdr"; the others are Studio-only until "Elevate to herdr" (which makes
 * their herdr space and starts their agent there).
 */
const emit = defineEmits<{ 'select-pane': [paneId: string] }>()
const { t } = useI18n()
const toast = useMessage()
const states = useSessionStateStore()
const herdr = useHerdrStore()
/** Chats elevated to herdr (or with their agent running there). */
function elevated(chat: SessionSummary): boolean {
  return herdr.isElevated(chat.id) || !!states.herdrLink(chat.id)
}
const chats = ref<SessionSummary[]>([])
const error = ref('')
const query = ref('')
let stopListChanges: (() => void) | null = null
let timer = 0

const visible = computed(() => {
  const q = query.value.trim().toLowerCase()
  return chats.value.filter(chat => !q || `${chat.title || ''} ${chat.agent || ''}`.toLowerCase().includes(q))
})

async function load() {
  try {
    chats.value = (await fetchSessions(undefined, 1000)).filter(chat => herdrCanOpenChat({
      id: chat.id,
      source: chat.source,
      isArchived: !!chat.is_archived,
      parentSessionId: chat.parent_session_id || null,
    }))
    error.value = ''
  } catch (err: any) {
    error.value = err?.message || String(err)
  }
}

function schedule() {
  if (timer) return
  timer = window.setTimeout(() => { timer = 0; void load() }, 150)
}

async function openInHerdr(chat: SessionSummary) {
  try {
    const { link } = await openSessionInHerdr(chat.id)
    emit('select-pane', link.paneId)
  } catch (err: any) {
    toast.error(err?.message || String(err))
  }
}

onMounted(() => {
  states.start()
  stopListChanges = states.onListChanged(schedule)
  void load()
})
onBeforeUnmount(() => {
  stopListChanges?.()
  if (timer) window.clearTimeout(timer)
})
</script>

<template>
  <section class="source" data-testid="mission-source-chats">
    <div class="source-bar">
      <input v-model="query" class="source-search" data-theme-surface="input" :placeholder="t('mission.searchChats')" />
      <span class="source-spacer" />
      <span>{{ t('mission.chatCount', { n: visible.length }) }}</span>
    </div>
    <p v-if="error" class="source-error">{{ error }}</p>
    <p v-else-if="!visible.length" class="source-empty">{{ t('mission.noChats') }}</p>
    <article v-for="chat in visible" :key="chat.id" class="source-card" data-theme-surface="card">
      <div class="source-card-meta">
        <AgentStatusIcon :status="states.statusOf(chat.id)" :live="!!states.herdrLink(chat.id)" :size="12" />
        <span class="source-card-title">{{ chat.title || chat.id }}</span>
        <span v-if="elevated(chat)" class="source-elevated" data-testid="mission-chat-elevated" :title="t('herdr.elevatedBadgeHint')">herdr</span>
      </div>
      <div class="source-card-meta">
        <span class="source-chip">{{ chat.agent || chat.source }}</span>
        <span v-if="states.herdrLink(chat.id)" class="source-chip is-good">{{ t('mission.liveIn', { pane: states.herdrLink(chat.id)?.paneId }) }}</span>
      </div>
      <div class="source-card-actions">
        <NButton size="tiny" @click="openInHerdr(chat)">{{ states.herdrLink(chat.id) ? t('mission.showPane') : elevated(chat) ? t('mission.openInHerdr') : t('herdr.elevate') }}</NButton>
        <a v-if="studioUrl(`/hermes/session/${chat.id}?center=chat`)" class="source-link" :href="studioUrl(`/hermes/session/${chat.id}?center=chat`)!">{{ t('mission.openInStudio') }}</a>
      </div>
    </article>
  </section>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;
@use './source';

.source-elevated {
  flex: none;
  padding: 1px 4px;
  border: var(--border-width, 1px) solid $border-light;
  border-radius: 4px;
  color: $text-muted;
  font-size: 10px;
  line-height: 1.2;
  cursor: default;
}

.source-search {
  flex: 1 1 200px;
  max-width: 320px;
  padding: 5px 8px;
  font-size: 12px;
  color: $text-primary;
  background: $bg-input;
  border: var(--border-width, 1px) solid $border-light;
  border-radius: var(--radius-component, 6px);
  outline: none;
}
</style>
