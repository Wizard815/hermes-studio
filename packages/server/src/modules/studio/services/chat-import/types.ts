/** Where an imported chat came from. */
export type ChatImportKind = 'hermes' | 'claude-code' | 'codex' | 'openclaw'

export const CHAT_IMPORT_KINDS: ChatImportKind[] = ['hermes', 'claude-code', 'codex', 'openclaw']

/** One message as it will be stored in Studio's messages table. */
export interface ImportedMessage {
  role: 'user' | 'assistant' | 'tool'
  content: string
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> | null
  tool_call_id?: string | null
  tool_name?: string | null
  /** Unix seconds. */
  timestamp: number
  reasoning?: string | null
  finish_reason?: string | null
}

/** A conversation read from a source file, ready to become a Studio chat. */
export interface ParsedChat {
  kind: ChatImportKind
  /** The session id the other agent used. */
  originalId: string
  title: string
  /** Unix seconds. */
  startedAt: number
  lastActive: number
  /** The agent's working folder, when the source records one. */
  cwd: string | null
  model: string
  messages: ImportedMessage[]
}

/** A chat found by a scan, before import. */
export interface ChatCandidate {
  /** Stable key: kind and original id. */
  key: string
  kind: ChatImportKind
  originalId: string
  title: string
  startedAt: number
  lastActive: number
  messageCount: number
  cwd: string | null
  model: string
  /** The Hermes profile the chat came from (Hermes sources only). */
  sourceProfile?: string
  /** Studio chat this one was already imported as, if any. */
  existingSessionId: string | null
  /** Working folder exists on this server. */
  cwdExists: boolean
  /** The agent can resume its own session on this server (Claude Code, Codex). */
  resumable: boolean
  /** Why it will be skipped (empty, too large, unreadable). */
  skipReason: string | null
}

/** Where a candidate's data lives; kept on the server only. */
export interface CandidateLocation {
  kind: ChatImportKind
  /** jsonl file, or the Hermes state.db. */
  path: string
  /** Hermes: the sessions merged into this chat, oldest first. */
  sessionIds?: string[]
}

/** Limits, overridable for tests. */
export interface ChatImportLimits {
  maxUploadBytes: number
  maxArchiveBytes: number
  maxArchiveEntries: number
  maxFileBytes: number
  maxChats: number
  maxMessagesPerChat: number
  maxToolOutputChars: number
}

export const DEFAULT_CHAT_IMPORT_LIMITS: ChatImportLimits = {
  maxUploadBytes: 512 * 1024 * 1024,
  maxArchiveBytes: 2 * 1024 * 1024 * 1024,
  maxArchiveEntries: 50_000,
  maxFileBytes: 128 * 1024 * 1024,
  maxChats: 5000,
  maxMessagesPerChat: 20_000,
  maxToolOutputChars: 32_000,
}

export class ChatImportError extends Error {
  constructor(message: string, readonly status = 400, readonly code = 'chat_import_invalid') {
    super(message)
  }
}
