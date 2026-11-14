/**
 * Display status for a chat, shared with herdr's pane vocabulary so the same
 * icon means the same thing in both apps.
 *
 * - working: a run is in progress
 * - blocked: waiting on an approval or a question
 * - done: finished and not yet read
 * - idle: ready for input
 * - unknown: an agent is present but its state cannot be classified
 */
export type AgentDisplayStatus = 'working' | 'blocked' | 'done' | 'idle' | 'unknown'

/** Live herdr pane linked to a Studio chat through the agent's native session id. */
export interface SessionHerdrLink {
  paneId: string
  workspaceId?: string
  status: AgentDisplayStatus
  /** The pane is the chat's waiting pane: its agent is not running, so messages go through Studio. */
  waiting?: boolean
}

/** Account-specific read cursor and live execution state, independent of open tabs. */
export interface SessionListState {
  sessionId: string
  profile?: string
  working: boolean
  /** An approval or clarification is waiting for the user. */
  blocked?: boolean
  backgroundPending: number
  lastMessageId: number
  readMessageId: number
  lastAttentionId?: number
  readAttentionId?: number
  /** Completed content awaiting a read receipt; false while working. */
  unread: boolean
  /** Present while the chat is open in a herdr pane. */
  herdr?: SessionHerdrLink
}

export interface SessionStateSnapshot { sessions: SessionListState[] }

/** Pushed when a chat row is created or deleted anywhere (another tab, MCP, herdr). */
export interface SessionListChange {
  type: 'created' | 'deleted' | 'updated'
  sessionId: string
}

/** Collapse live state into one display status. Blocked outranks working. */
export function resolveDisplayStatus(input: {
  working?: boolean
  blocked?: boolean
  unread?: boolean
  herdr?: AgentDisplayStatus
}): AgentDisplayStatus {
  if (input.blocked || input.herdr === 'blocked') return 'blocked'
  if (input.working || input.herdr === 'working') return 'working'
  if (input.unread || input.herdr === 'done') return 'done'
  if (input.herdr === 'unknown') return 'unknown'
  return 'idle'
}
