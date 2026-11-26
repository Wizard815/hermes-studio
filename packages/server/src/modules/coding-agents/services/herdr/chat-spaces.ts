/**
 * Chats are Studio-only until they are elevated to herdr. An elevated chat
 * is a herdr space; while its agent is not running there the space shows a
 * small waiting pane (`bin/herdr-plugin/studio-chat.sh`): it shows the chat,
 * reports itself to herdr as the chat's idle agent, and resumes the agent in
 * place when you press Enter. Spaces are named after their chat and kept in
 * Studio's folder order. Returning a chat to Studio closes its space.
 *
 * This file only plans: given Studio's chats and herdr's spaces, what to
 * create, rename, close and in which order (the bridge applies the plan).
 */

/** A Studio chat as herdr shows it. */
export interface ChatSpaceChat {
  id: string
  title: string
  /** Folder names from the top folder down ([] when not in a folder). */
  folderPath: string[]
  /** Each folder's place among its siblings, top folder down (the order Studio's herdr page shows); else by name. */
  folderRank?: number[]
  /** Studio agent id (claude-code, codex, hermes, ekko-agent, ...). */
  agent: string
  /** herdr can run its agent (others show the chat and point to Studio). */
  hostable: boolean
  /** The chat's working directory, if it has one. */
  workspace: string | null
  lastActive: number
}

/** A chat's space in herdr, as the bridge remembers it. */
export interface ChatSpaceRecord {
  workspaceId: string
  /** The waiting pane; '' once the chat's agent is running in the space. */
  stubPaneId: string
  label: string
  /** Whether the waiting pane runs the chat's agent itself (else it talks to Studio). */
  hostable?: boolean
}

export interface ChatSpacePlan {
  /** Chats that need a space (in sidebar order). */
  create: ChatSpaceChat[]
  /** Spaces whose label no longer matches their chat. */
  rename: Array<{ workspaceId: string; label: string }>
  /** Waiting spaces of chats that are gone (deleted or archived in Studio). */
  close: Array<{ sessionId: string; workspaceId: string }>
  /** Records that no longer point at a herdr space (herdr restarted, or the space was closed). */
  forget: string[]
  /** Every chat space in sidebar order (workspace ids that exist after the plan; new ones are appended by the bridge). */
  order: string[]
}

/** herdr shows about this much of a label in its sidebar. */
const MAX_LABEL = 72

/** A space is named after its chat (the folder shows in Studio; the order follows folders). */
export function chatSpaceLabel(chat: Pick<ChatSpaceChat, 'title'>): string {
  const title = (chat.title || 'Chat').replace(/\s+/g, ' ').trim() || 'Chat'
  return title.length <= MAX_LABEL ? title : `${title.slice(0, MAX_LABEL - 1)}…`
}

/** Sidebar order: folder tree order (folders before loose chats), then newest first. */
export function chatSpaceOrder(chats: ChatSpaceChat[]): ChatSpaceChat[] {
  return [...chats].sort((a, b) => {
    const depth = Math.min(a.folderPath.length, b.folderPath.length)
    for (let i = 0; i < depth; i += 1) {
      const rank = (a.folderRank?.[i] ?? Infinity) - (b.folderRank?.[i] ?? Infinity)
      if (rank) return rank
      const cmp = a.folderPath[i].localeCompare(b.folderPath[i], undefined, { sensitivity: 'base' })
      if (cmp) return cmp
    }
    // Inside the same folder, chats in subfolders come first, then this folder's own chats.
    if (a.folderPath.length !== b.folderPath.length) {
      if (!a.folderPath.length) return 1
      if (!b.folderPath.length) return -1
      return b.folderPath.length - a.folderPath.length
    }
    return b.lastActive - a.lastActive || a.id.localeCompare(b.id)
  })
}

export function planChatSpaces(input: {
  chats: ChatSpaceChat[]
  records: Record<string, ChatSpaceRecord>
  /** herdr's workspace ids right now. */
  workspaces: Set<string>
  /** herdr's panes right now (pane id → workspace id). */
  panes?: Map<string, string>
  /** Chats whose agent is running in herdr right now, and its workspace. */
  live: Map<string, string>
}): ChatSpacePlan {
  const plan: ChatSpacePlan = { create: [], rename: [], close: [], forget: [], order: [] }
  const wanted = new Map(input.chats.map(chat => [chat.id, chat]))
  const spaceOf = new Map<string, string>()

  for (const [sessionId, record] of Object.entries(input.records)) {
    if (!input.workspaces.has(record.workspaceId)) { plan.forget.push(sessionId); continue }
    // herdr started over (its state was lost) and reuses ids: a waiting space
    // only counts while its own pane is still there.
    if (record.stubPaneId && input.panes && input.panes.get(record.stubPaneId) !== record.workspaceId) { plan.forget.push(sessionId); continue }
    if (!wanted.has(sessionId)) {
      // A chat that is gone: close its waiting space; a running agent keeps its space.
      if (record.stubPaneId && !input.live.has(sessionId)) plan.close.push({ sessionId, workspaceId: record.workspaceId })
      else plan.forget.push(sessionId)
      continue
    }
    // A waiting pane made for the other way of running its chat (the hermes CLI came or went) is made again.
    if (record.stubPaneId && !input.live.has(sessionId) && record.hostable !== wanted.get(sessionId)!.hostable) {
      plan.close.push({ sessionId, workspaceId: record.workspaceId })
      continue
    }
    spaceOf.set(sessionId, record.workspaceId)
  }
  // A chat started in herdr (or resumed elsewhere) is its agent's space.
  for (const [sessionId, workspaceId] of input.live) {
    if (wanted.has(sessionId) && input.workspaces.has(workspaceId)) spaceOf.set(sessionId, workspaceId)
  }

  for (const chat of chatSpaceOrder(input.chats)) {
    const workspaceId = spaceOf.get(chat.id)
    if (!workspaceId) { plan.create.push(chat); continue }
    const label = chatSpaceLabel(chat)
    if (input.records[chat.id]?.label !== label || input.records[chat.id]?.workspaceId !== workspaceId) plan.rename.push({ workspaceId, label })
    plan.order.push(workspaceId)
  }
  return plan
}

/**
 * The agent name herdr lists for a chat herdr cannot run itself (Ekko, Hermes
 * without its CLI). herdr keeps live reports only for agent names it knows,
 * so these chats are listed as Studio's Hermes family: `hermes`.
 */
export function chatAgentLabel(_agent: string): string {
  return 'hermes'
}

/**
 * Chats that are in herdr: elevated by hand (Elevate to herdr, `/herdr`, the
 * chat menu, herdr's Studio chats picker) or with their agent running in a
 * herdr pane (started there, or resumed there by hand). Every other chat is a
 * Studio-only chat with no herdr space and no process.
 */
export function elevatedChatList(chats: ChatSpaceChat[], input: { elevated: Record<string, number>; live: Map<string, string>; returning?: Set<string> }): ChatSpaceChat[] {
  return chats.filter(chat => input.elevated[chat.id] != null || (input.live.has(chat.id) && !input.returning?.has(chat.id)))
}

/** Elevated chats from the saved bridge state (older states had none: see `planSeparation`). */
export function elevatedChatsFrom(raw: { elevatedChats?: unknown } | null | undefined): Record<string, number> {
  const out: Record<string, number> = {}
  const source = raw?.elevatedChats
  if (!source || typeof source !== 'object') return out
  for (const [id, at] of Object.entries(source as Record<string, unknown>)) if (typeof at === 'number') out[id] = at
  return out
}

/**
 * The one-time move of an install from "every chat is a herdr space" to
 * elevated chats: chats whose agent runs in herdr stay there (elevated); a
 * chat's space that only shows its waiting pane is closed by the next chat
 * sync. A waiting pane counts as waiting only when herdr says it still runs
 * the waiting script and nothing it started (`waiting`); anything else in it
 * is kept, so no running agent is closed by mistake. herdr-only spaces have
 * no record and are never touched; chat history lives in Studio and is not
 * changed either.
 */
export function planSeparation(input: {
  records: Record<string, ChatSpaceRecord>
  live: Map<string, string>
  workspaces: Set<string>
  /** Waiting panes that only show their chat's card (no agent started from them). */
  waiting: Set<string>
}): { elevate: string[]; close: string[] } {
  const elevate = new Set(input.live.keys())
  const close: string[] = []
  for (const [sessionId, record] of Object.entries(input.records)) {
    if (elevate.has(sessionId) || !input.workspaces.has(record.workspaceId)) continue
    if (record.stubPaneId && input.waiting.has(record.stubPaneId)) close.push(sessionId)
    else elevate.add(sessionId)
  }
  return { elevate: [...elevate], close }
}

