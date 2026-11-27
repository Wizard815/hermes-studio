<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { NButton, NCheckbox, NModal, NPopconfirm, NSpin, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { batchDeleteSessions, fetchLastMessages } from '@/api/studio/sessions'
import { STALE_DAYS, suggestCleanup, type CleanupSuggestion } from '@/utils/chat-list-tidy'
import type { Session } from '@/stores/hermes/chat'

/**
 * Clean up (docs/chat-list.md): chats worth archiving or deleting, by reason,
 * each with its last message so you can tell what it was. Archive is the main
 * button; Delete asks first.
 */
const props = defineProps<{
  sessions: Session[]
  /** Project coordinators and threads: never suggested. */
  keep: Set<string>
  busy: (id: string) => boolean
  archive: (id: string) => Promise<boolean>
}>()
const emit = defineEmits<{ deleted: [ids: string[]] }>()
const show = defineModel<boolean>('show', { default: false })
const { t } = useI18n()
const message = useMessage()

const suggestions = ref<Array<CleanupSuggestion<Session>>>([])
const lastMessages = ref<Record<string, { role: string; text: string; at: number }>>({})
const selected = ref(new Set<string>())
const loading = ref(false)
const working = ref(false)

async function load() {
  loading.value = true
  suggestions.value = suggestCleanup(props.sessions, { now: Date.now(), keep: props.keep, busy: props.busy })
  selected.value = new Set(suggestions.value.map(item => item.chat.id))
  try { lastMessages.value = await fetchLastMessages(suggestions.value.map(item => item.chat.id)) } catch { lastMessages.value = {} }
  loading.value = false
}
watch(show, open => { if (open) void load() })

const groups = computed(() => (['empty', 'duplicate', 'stale'] as const)
  .map(reason => ({ reason, items: suggestions.value.filter(item => item.reason === reason) }))
  .filter(group => group.items.length))
const reasonLabel = (reason: string) => reason === 'empty' ? t('chatList.reasonEmpty') : reason === 'duplicate' ? t('chatList.reasonDuplicate') : t('chatList.reasonStale', { days: STALE_DAYS })
const allSelected = computed(() => suggestions.value.length > 0 && selected.value.size === suggestions.value.length)

function toggle(id: string, on: boolean) {
  const next = new Set(selected.value)
  if (on) next.add(id)
  else next.delete(id)
  selected.value = next
}
function toggleAll(on: boolean) {
  selected.value = on ? new Set(suggestions.value.map(item => item.chat.id)) : new Set()
}
function when(ms?: number) {
  return ms ? new Date(ms).toLocaleDateString() : ''
}

async function archiveSelected() {
  working.value = true
  let done = 0
  for (const id of selected.value) if (await props.archive(id).catch(() => false)) done++
  working.value = false
  message.success(t('chatList.done', { n: done }))
  show.value = false
}

async function deleteSelected() {
  working.value = true
  const targets = suggestions.value.filter(item => selected.value.has(item.chat.id)).map(item => ({ id: item.chat.id, profile: item.chat.profile || null }))
  try {
    const result = await batchDeleteSessions(targets)
    const failed = new Set(result.errors.map(error => error.id))
    emit('deleted', targets.map(target => target.id).filter(id => !failed.has(id)))
    message.success(t('chatList.done', { n: result.deleted }))
    show.value = false
  } catch (error: any) {
    message.error(error?.message || String(error))
  } finally {
    working.value = false
  }
}
</script>

<template>
  <NModal v-model:show="show" preset="card" :title="t('chatList.cleanupTitle')" style="max-width: 640px" data-testid="chat-cleanup">
    <p class="cleanup-hint">{{ t('chatList.cleanupHint') }}</p>
    <NSpin v-if="loading" size="small" />
    <p v-else-if="!suggestions.length" class="cleanup-none" role="status">{{ t('chatList.cleanupNone') }}</p>
    <template v-else>
      <NCheckbox :checked="allSelected" :indeterminate="selected.size > 0 && !allSelected" @update:checked="toggleAll">{{ t('chatList.selectAll') }}</NCheckbox>
      <section v-for="group in groups" :key="group.reason" class="cleanup-group" :data-testid="`chat-cleanup-${group.reason}`">
        <h4>{{ reasonLabel(group.reason) }} <span>{{ group.items.length }}</span></h4>
        <label v-for="item in group.items" :key="item.chat.id" class="cleanup-item">
          <NCheckbox :checked="selected.has(item.chat.id)" @update:checked="on => toggle(item.chat.id, on)" />
          <span class="cleanup-body">
            <span class="cleanup-title">{{ item.chat.title || item.chat.id.slice(0, 8) }}</span>
            <span class="cleanup-meta">{{ when(item.chat.lastActiveAt || item.chat.updatedAt) }} · {{ item.chat.messageCount ?? 0 }}<template v-if="item.keep"> · {{ t('chatList.reasonDuplicate') }}: {{ when(item.keep.lastActiveAt || item.keep.updatedAt) }}</template></span>
            <span class="cleanup-last">
              <template v-if="lastMessages[item.chat.id]">{{ t('chatList.lastMessage') }}: {{ lastMessages[item.chat.id].text }}</template>
              <template v-else>{{ t('chatList.noMessage') }}</template>
            </span>
          </span>
        </label>
      </section>
    </template>
    <template #footer>
      <div class="cleanup-actions">
        <NPopconfirm :positive-text="t('chatList.deleteSelected', { n: selected.size })" @positive-click="deleteSelected">
          <template #trigger>
            <NButton :disabled="!selected.size || working" data-testid="chat-cleanup-delete">{{ t('chatList.deleteSelected', { n: selected.size }) }}</NButton>
          </template>
          {{ t('chatList.deleteConfirm', { n: selected.size }) }}
        </NPopconfirm>
        <NButton type="primary" :disabled="!selected.size" :loading="working" data-testid="chat-cleanup-archive" @click="archiveSelected">{{ t('chatList.archiveSelected', { n: selected.size }) }}</NButton>
      </div>
    </template>
  </NModal>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.cleanup-hint,
.cleanup-none { margin: 0 0 12px; color: $text-secondary; font-size: 13px; }

.cleanup-group {
  margin-top: 12px;

  h4 {
    margin: 0 0 4px;
    font-size: 12px;
    font-weight: 600;
    color: $text-secondary;

    span { color: $text-muted; font-weight: 400; }
  }
}

.cleanup-item {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  min-height: 44px;
  padding: 6px 4px;
  border-radius: var(--radius-component, 6px);
  cursor: pointer;

  &:hover { background: rgba(var(--accent-primary-rgb), 0.05); }
}

.cleanup-body { display: flex; flex-direction: column; min-width: 0; gap: 2px; }
.cleanup-title { color: $text-primary; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cleanup-meta { color: $text-muted; font-size: 11px; }
.cleanup-last {
  color: $text-secondary;
  font-size: 12px;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.cleanup-actions { display: flex; justify-content: flex-end; gap: 8px; }
</style>
