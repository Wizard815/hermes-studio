/**
 * The chat list's optional extras (docs/chat-list.md): chats shown under another
 * chat (one level), and Clean up's suggestions.
 */

export interface TidyChat {
  id: string
  title?: string | null
  nestedUnder?: string | null
  isPinned?: boolean
  isArchived?: boolean
  isLocalOnly?: boolean
  messageCount?: number
  lastActiveAt?: number
  updatedAt?: number
  createdAt?: number
}

/**
 * A list in its own order, with each nested chat moved right under its parent.
 * A chat whose parent is not in this list stays where it is, at the top level.
 */
export function nestChats<T extends TidyChat>(list: T[]): Array<{ chat: T; nested: boolean }> {
  const ids = new Set(list.map(chat => chat.id))
  const children = new Map<string, T[]>()
  for (const chat of list) {
    const parent = chat.nestedUnder
    if (parent && parent !== chat.id && ids.has(parent)) children.set(parent, [...(children.get(parent) || []), chat])
  }
  const out: Array<{ chat: T; nested: boolean }> = []
  for (const chat of list) {
    if (chat.nestedUnder && chat.nestedUnder !== chat.id && ids.has(chat.nestedUnder)) continue
    out.push({ chat, nested: false })
    for (const child of children.get(chat.id) || []) out.push({ chat: child, nested: true })
  }
  return out
}

export type CleanupReason = 'empty' | 'duplicate' | 'stale'

export interface CleanupSuggestion<T extends TidyChat> {
  chat: T
  reason: CleanupReason
  /** For a duplicate: the newer chat with the same title. */
  keep?: T
}

export const STALE_DAYS = 30
const DAY_MS = 86_400_000

const lastActive = (chat: TidyChat) => chat.lastActiveAt || chat.updatedAt || chat.createdAt || 0
const sameTitle = (title?: string | null) => String(title || '').trim().toLowerCase().replace(/\s+/g, ' ')

/**
 * Chats worth archiving or deleting, by reason, first reason that fits:
 * - empty: two messages or fewer, and untouched for a day;
 * - duplicate: the same title as a newer chat, and untouched for a week;
 * - stale: untouched for STALE_DAYS.
 * Never pinned, archived, local-only or busy chats, nor any chat in `keep`
 * (project chats), nor a chat with chats under it.
 */
export function suggestCleanup<T extends TidyChat>(
  chats: T[],
  options: { now: number; keep?: Set<string>; busy?: (id: string) => boolean; staleDays?: number },
): Array<CleanupSuggestion<T>> {
  const staleMs = (options.staleDays ?? STALE_DAYS) * DAY_MS
  const parents = new Set(chats.map(chat => chat.nestedUnder).filter(Boolean) as string[])
  const candidates = chats.filter(chat => !chat.isPinned && !chat.isArchived && !chat.isLocalOnly
    && !options.keep?.has(chat.id) && !parents.has(chat.id) && !options.busy?.(chat.id))
  const newestByTitle = new Map<string, T>()
  for (const chat of chats) {
    const title = sameTitle(chat.title)
    if (!title || chat.isArchived) continue
    const current = newestByTitle.get(title)
    if (!current || lastActive(chat) > lastActive(current)) newestByTitle.set(title, chat)
  }
  const out: Array<CleanupSuggestion<T>> = []
  const idleFor = (chat: TidyChat) => options.now - lastActive(chat)
  const isEmpty = (chat: TidyChat) => (chat.messageCount ?? 0) <= 2 && idleFor(chat) > DAY_MS
  const emptyIds = new Set(candidates.filter(isEmpty).map(chat => chat.id))
  for (const chat of candidates) {
    const idle = idleFor(chat)
    if (emptyIds.has(chat.id)) { out.push({ chat, reason: 'empty' }); continue }
    // Never suggest both copies: a duplicate only when the newer one stays.
    const newest = newestByTitle.get(sameTitle(chat.title))
    if (newest && newest.id !== chat.id && !emptyIds.has(newest.id) && idle > 7 * DAY_MS) { out.push({ chat, reason: 'duplicate', keep: newest }); continue }
    if (idle > staleMs) out.push({ chat, reason: 'stale' })
  }
  const order: Record<CleanupReason, number> = { empty: 0, duplicate: 1, stale: 2 }
  return out.sort((a, b) => order[a.reason] - order[b.reason] || lastActive(a.chat) - lastActive(b.chat))
}
