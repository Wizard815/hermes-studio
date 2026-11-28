<script setup lang="ts">
import { computed, h, ref, watch } from 'vue'
import { NButton, NCheckbox, NModal, NPopconfirm, NSpin, useMessage, useNotification } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { batchDeleteSessions, fetchCleanupPrs, fetchCleanupSummaries, fetchLastMessages, saveChatsToWiki, unarchiveSession, type CleanupPr } from '@/api/studio/sessions'
import { STALE_DAYS, cleanupCandidates, mergedChats, readCleanupReminder, suggestCleanup, writeCleanupReminder, type CleanupSuggestion } from '@/utils/chat-list-tidy'
import type { Session } from '@/stores/hermes/chat'

/**
 * Clean up (docs/chat-list.md): chats worth archiving or deleting, by reason,
 * each with a one-line summary and its last message so you can tell what it
 * was. Archive is the main button. Delete asks first, can save each chat's key
 * facts to the wiki, and archives first so it can be undone for a few seconds.
 */
const props = defineProps<{
  sessions: Session[]
  /** Project coordinators and threads: never suggested. */
  keep: Set<string>
  busy: (id: string) => boolean
  archive: (id: string) => Promise<boolean>
}>()
const emit = defineEmits<{ deleted: [ids: string[]]; restored: [ids: string[]] }>()
const show = defineModel<boolean>('show', { default: false })
const { t } = useI18n()
const message = useMessage()
const notification = useNotification()

const UNDO_MS = 10_000

const suggestions = ref<Array<CleanupSuggestion<Session>>>([])
const lastMessages = ref<Record<string, { role: string; text: string; at: number }>>({})
const summaries = ref<Record<string, string>>({})
const summarizing = ref(false)
const prs = ref<Record<string, CleanupPr[]>>({})
const wikiProfiles = ref<string[]>([])
const saveToWiki = ref(true)
const remind = ref(readCleanupReminder().on)
const selected = ref(new Set<string>())
const loading = ref(false)
const working = ref(false)

async function load() {
  loading.value = true
  summaries.value = {}
  const now = Date.now()
  const options = { now, keep: props.keep, busy: props.busy }
  const candidates = cleanupCandidates(props.sessions, options)
  try {
    const context = await fetchCleanupPrs(candidates.map(chat => chat.id))
    prs.value = context.prs || {}
    wikiProfiles.value = context.wikiProfiles || []
  } catch {
    prs.value = {}
    wikiProfiles.value = []
  }
  suggestions.value = suggestCleanup(props.sessions, { ...options, merged: mergedChats(prs.value) })
  selected.value = new Set(suggestions.value.map(item => item.chat.id))
  const ids = suggestions.value.map(item => item.chat.id)
  try { lastMessages.value = await fetchLastMessages(ids) } catch { lastMessages.value = {} }
  loading.value = false
  // Opening Clean up counts as this month's reminder.
  const reminder = readCleanupReminder()
  if (reminder.on) writeCleanupReminder({ on: true, last: now })
  summarizing.value = true
  try { summaries.value = await fetchCleanupSummaries(ids.slice(0, 40)) } catch { summaries.value = {} }
  summarizing.value = false
}
watch(show, open => { if (open) void load() })

const groups = computed(() => (['empty', 'done', 'duplicate', 'stale'] as const)
  .map(reason => ({ reason, items: suggestions.value.filter(item => item.reason === reason) }))
  .filter(group => group.items.length))
const reasonLabel = (reason: string) => reason === 'empty' ? t('chatList.reasonEmpty')
  : reason === 'done' ? t('chatList.reasonDone')
    : reason === 'duplicate' ? t('chatList.reasonDuplicate')
      : t('chatList.reasonStale', { days: STALE_DAYS })
const allSelected = computed(() => suggestions.value.length > 0 && selected.value.size === suggestions.value.length)
const selectedChats = computed(() => suggestions.value.filter(item => selected.value.has(item.chat.id)).map(item => item.chat))
const wikiAvailable = computed(() => selectedChats.value.some(chat => wikiProfiles.value.includes(chat.profile || 'default')))
const mergedPr = (id: string) => (prs.value[id] || []).find(pr => pr.state === 'merged')

function toggle(id: string, on: boolean) {
  const next = new Set(selected.value)
  if (on) next.add(id)
  else next.delete(id)
  selected.value = next
}
function toggleAll(on: boolean) {
  selected.value = on ? new Set(suggestions.value.map(item => item.chat.id)) : new Set()
}
function setRemind(on: boolean) {
  remind.value = on
  writeCleanupReminder({ on, last: Date.now() })
}
function when(ms?: number) {
  return ms ? new Date(ms).toLocaleDateString() : ''
}

async function archiveSelected() {
  working.value = true
  let done = 0
  for (const id of selected.value) if (await props.archive(id).catch(() => false)) done++
  working.value = false
  message.success(t('chatList.done', { n: done }, done))
  show.value = false
}

/**
 * Delete: save notes to the wiki (when asked; a chat whose notes fail is kept),
 * archive so the chats leave the list, then delete for good once the undo
 * window has passed. Closing the page in that window leaves them archived.
 */
async function deleteSelected() {
  working.value = true
  try {
    let chats = selectedChats.value
    if (saveToWiki.value && wikiAvailable.value) {
      const forWiki = chats.filter(chat => wikiProfiles.value.includes(chat.profile || 'default'))
      const result = await saveChatsToWiki(forWiki.map(chat => chat.id))
      if (result.errors.length) {
        const failed = new Set(result.errors.map(error => error.id))
        chats = chats.filter(chat => !failed.has(chat.id))
        message.warning(t('chatList.wikiKept', { n: failed.size, error: result.errors[0].error }, failed.size), { duration: 8000 })
      }
      if (result.saved.length) message.success(t('chatList.savedToWiki', { n: result.saved.length }, result.saved.length))
    }
    const archived: DeleteTarget[] = []
    for (const chat of chats) if (await props.archive(chat.id).catch(() => false)) archived.push({ id: chat.id, profile: chat.profile || null, title: chat.title || chat.id.slice(0, 8) })
    show.value = false
    if (archived.length) startUndoWindow(archived)
  } catch (error: any) {
    message.error(error?.message || String(error))
  } finally {
    working.value = false
  }
}

type DeleteTarget = { id: string; profile: string | null; title: string }

/** A big delete (this many or more) can pick which chats to bring back. */
const PICK_FROM = 3
const undoPick = ref<{ targets: DeleteTarget[]; back: Set<string> } | null>(null)
let finishPick: ((back: Set<string>) => void) | null = null

async function restore(targets: DeleteTarget[]) {
  const back: string[] = []
  for (const target of targets) if (await unarchiveSession(target.id)) back.push(target.id)
  emit('restored', back)
  message.success(t('chatList.undone', { n: back.length }, back.length))
}

async function deleteForGood(targets: DeleteTarget[]) {
  if (!targets.length) return
  try {
    const result = await batchDeleteSessions(targets.map(({ id, profile }) => ({ id, profile })))
    const failed = new Set(result.errors.map(error => error.id))
    emit('deleted', targets.map(target => target.id).filter(id => !failed.has(id)))
    message.success(t('chatList.done', { n: result.deleted }, result.deleted))
  } catch (error: any) {
    message.error(error?.message || String(error))
  }
}

/**
 * Undo for UNDO_MS, then delete for good. A big delete also offers Choose…,
 * which stops the clock until you pick which chats come back.
 */
function startUndoWindow(targets: DeleteTarget[]) {
  let settled = false
  const settle = () => { if (settled) return false; settled = true; clearTimeout(timer); note.destroy(); return true }
  const note = notification.create({
    content: t('chatList.deleting', { n: targets.length }, targets.length),
    duration: UNDO_MS,
    closable: false,
    action: () => h('div', { style: 'display: flex; gap: 8px' }, [
      targets.length >= PICK_FROM
        ? h(NButton, {
          size: 'small',
          'data-testid': 'chat-cleanup-undo-choose',
          onClick: () => {
            if (!settle()) return
            undoPick.value = { targets, back: new Set() }
            finishPick = back => {
              void restore(targets.filter(target => back.has(target.id)))
              void deleteForGood(targets.filter(target => !back.has(target.id)))
            }
          },
        }, { default: () => t('chatList.undoChoose') })
        : null,
      h(NButton, {
        size: 'small',
        type: 'primary',
        'data-testid': 'chat-cleanup-undo',
        onClick: () => { if (settle()) void restore(targets) },
      }, { default: () => t('chatList.undo') }),
    ]),
  })
  const timer = setTimeout(() => { if (settle()) void deleteForGood(targets) }, UNDO_MS)
}

function togglePick(id: string, on: boolean) {
  if (!undoPick.value) return
  const back = new Set(undoPick.value.back)
  if (on) back.add(id)
  else back.delete(id)
  undoPick.value = { ...undoPick.value, back }
}

function applyPick() {
  const pick = undoPick.value
  undoPick.value = null
  if (pick && finishPick) finishPick(pick.back)
  finishPick = null
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
            <span v-if="summaries[item.chat.id]" class="cleanup-summary" data-testid="chat-cleanup-summary">{{ summaries[item.chat.id] }}</span>
            <span v-else-if="summarizing" class="cleanup-summary cleanup-pending">{{ t('chatList.summarizing') }}</span>
            <a v-if="item.reason === 'done' && mergedPr(item.chat.id)" class="cleanup-pr" :href="mergedPr(item.chat.id)!.url" target="_blank" rel="noopener" @click.stop>{{ t('chatList.prMerged') }}: {{ mergedPr(item.chat.id)!.title || mergedPr(item.chat.id)!.url }}</a>
            <span class="cleanup-last">
              <template v-if="lastMessages[item.chat.id]">{{ t('chatList.lastMessage') }}: {{ lastMessages[item.chat.id].text }}</template>
              <template v-else>{{ t('chatList.noMessage') }}</template>
            </span>
          </span>
        </label>
      </section>
    </template>
    <template #footer>
      <div class="cleanup-options">
        <NCheckbox v-if="wikiAvailable" v-model:checked="saveToWiki" data-testid="chat-cleanup-wiki">{{ t('chatList.saveToWiki') }}</NCheckbox>
        <NCheckbox :checked="remind" data-testid="chat-cleanup-remind" @update:checked="setRemind">{{ t('chatList.remindMonthly') }}</NCheckbox>
      </div>
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
  <NModal
    :show="!!undoPick"
    preset="card"
    :title="t('chatList.undoPickTitle')"
    :closable="false"
    :mask-closable="false"
    :close-on-esc="false"
    style="max-width: 480px"
    data-testid="chat-cleanup-undo-pick"
  >
    <template v-if="undoPick">
      <p class="cleanup-hint">{{ t('chatList.undoPickHint') }}</p>
      <label v-for="target in undoPick.targets" :key="target.id" class="cleanup-item">
        <NCheckbox :checked="undoPick.back.has(target.id)" @update:checked="on => togglePick(target.id, on)" />
        <span class="cleanup-title">{{ target.title }}</span>
      </label>
    </template>
    <template #footer>
      <div class="cleanup-actions">
        <NButton type="primary" data-testid="chat-cleanup-undo-apply" @click="applyPick">
          {{ undoPick && undoPick.back.size
            ? t('chatList.undoPickApply', { n: undoPick.back.size, m: undoPick.targets.length - undoPick.back.size })
            : t('chatList.undoPickDeleteAll', { n: undoPick?.targets.length ?? 0 }) }}
        </NButton>
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

.cleanup-summary { color: $text-primary; font-size: 12px; }
.cleanup-pending { color: $text-muted; font-style: italic; }
.cleanup-pr { color: $accent-primary; font-size: 12px; text-decoration: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.cleanup-options { display: flex; flex-direction: column; gap: 6px; margin-bottom: 12px; font-size: 13px; }
.cleanup-actions { display: flex; justify-content: flex-end; gap: 8px; }
</style>
