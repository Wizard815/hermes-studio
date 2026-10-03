import { ref, watch } from 'vue'

/**
 * Per-session composer drafts.
 *
 * Drafts are keyed by chat session id so text typed in one conversation never
 * leaks into another. Text typed before a session exists is kept under a
 * pending slot and migrated onto the session once it binds.
 */
const DRAFT_STORAGE_KEY = 'hermes_chat_input_drafts_v3'
const PENDING_SLOT = '__pending__'

type DraftMap = Record<string, string>

function readMap(): DraftMap {
  if (typeof localStorage === 'undefined') return {}
  try {
    const parsed = JSON.parse(localStorage.getItem(DRAFT_STORAGE_KEY) || '{}')
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function writeMap(map: DraftMap): void {
  if (typeof localStorage === 'undefined') return
  try {
    if (Object.keys(map).length > 0) {
      localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(map))
    } else {
      localStorage.removeItem(DRAFT_STORAGE_KEY)
    }
  } catch {
    // Quota/storage errors fall back to in-memory only.
  }
}

/** Reactive mirror of the on-disk map. */
export const composerDrafts = ref<DraftMap>(readMap())

watch(composerDrafts, writeMap, { deep: true })

export function draftSlot(sessionId: string | null | undefined): string {
  return sessionId || PENDING_SLOT
}

export function readDraft(sessionId: string | null | undefined): string {
  return composerDrafts.value[draftSlot(sessionId)] || ''
}

export function writeDraft(sessionId: string | null | undefined, value: string): void {
  const slot = draftSlot(sessionId)
  const next = { ...composerDrafts.value }
  if (value) next[slot] = value
  else delete next[slot]
  composerDrafts.value = next
}

/** Re-read from storage (e.g. after another tab wrote a newer draft). */
export function reloadComposerDrafts(): void {
  composerDrafts.value = readMap()
}

/** Move a pre-session draft onto the session once it becomes active. */
export function migratePendingDraft(sessionId: string | null | undefined): void {
  if (!sessionId) return
  const pending = composerDrafts.value[PENDING_SLOT]
  if (!pending) return
  const next = { ...composerDrafts.value }
  delete next[PENDING_SLOT]
  if (!next[sessionId]) next[sessionId] = pending
  composerDrafts.value = next
}