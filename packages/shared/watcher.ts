/**
 * The Watcher (docs/watcher.md): one feed of what Studio's guards already do
 * (approvals, run limits, clean rooms, Agent work, plugin installs), the alert
 * bell, and "Trust this" rules that answer approvals the user has trusted.
 * Shared by the server and the client.
 */

export const WATCHER_KINDS = [
  'approval_asked',
  'approval_denied',
  'approval_approved',
  'approval_trusted',
  'run_limit',
  'loop',
  'cleanroom_leak',
  'cleanroom_blocked',
  'work_approval',
  'work_blocked',
  'work_decided',
  'plugin_failed',
  'connection',
  'pipelock_blocked',
] as const
export type WatcherKind = typeof WATCHER_KINDS[number]

export type WatcherSeverity = 'info' | 'warn' | 'block'

export interface WatcherEvent {
  id: number
  /** ms since epoch */
  time: number
  kind: WatcherKind
  severity: WatcherSeverity
  /** The chat it happened in, when there is one. */
  sessionId: string
  /** Agent work id, when it is about a task. */
  taskId: string
  /** Agent (claude-code, codex, hermes, ekko, ...). */
  agent: string
  /** The chat's folder, when known. */
  folder: string
  /** One short line for people. */
  text: string
  /** Where to look: a Studio route (`/hermes/chat?session=…`) or an outside URL (Langfuse). */
  link: string
  /** What "Trust this" would allow, when the event is an approval. */
  action?: WatcherAction
  /** Langfuse link for the chat, when the Langfuse extra is on and has keys. */
  trace?: string
  read: boolean
}

/** The action an approval was about (what a trust rule matches). */
export interface WatcherAction {
  kind: TrustKind
  /** The command line, the file path or the tool name. */
  value: string
}

export interface WatcherKindSetting {
  /** Show it in the bell. */
  alert: boolean
  /** Also post it to Agent work's Mattermost channel (Connections → Agent work). */
  mattermost: boolean
}

export interface WatcherExtrasSettings {
  pipelock: { enabled: boolean; proxyUrl: string }
  innerwarden: { enabled: boolean }
  langfuse: { enabled: boolean }
}

export interface WatcherSettings {
  kinds: Record<WatcherKind, WatcherKindSetting>
  /** Most alerts kept (older ones go first). */
  historySize: number
  /** Alerts older than this many days go. */
  maxAgeDays: number
  extras: WatcherExtrasSettings
}

export const DEFAULT_WATCHER_KINDS: Record<WatcherKind, WatcherKindSetting> = {
  approval_asked: { alert: true, mattermost: false },
  approval_denied: { alert: true, mattermost: false },
  approval_approved: { alert: false, mattermost: false },
  approval_trusted: { alert: false, mattermost: false },
  // Run limits already posted to Mattermost before the watcher; keep that.
  run_limit: { alert: true, mattermost: true },
  loop: { alert: true, mattermost: true },
  cleanroom_leak: { alert: true, mattermost: false },
  cleanroom_blocked: { alert: true, mattermost: false },
  work_approval: { alert: true, mattermost: false },
  work_blocked: { alert: true, mattermost: false },
  work_decided: { alert: false, mattermost: false },
  plugin_failed: { alert: true, mattermost: false },
  connection: { alert: true, mattermost: false },
  pipelock_blocked: { alert: true, mattermost: false },
}

export const DEFAULT_WATCHER_SETTINGS: WatcherSettings = {
  kinds: DEFAULT_WATCHER_KINDS,
  historySize: 500,
  maxAgeDays: 30,
  extras: {
    pipelock: { enabled: false, proxyUrl: 'http://127.0.0.1:8888' },
    innerwarden: { enabled: false },
    langfuse: { enabled: false },
  },
}

export const WATCHER_HISTORY_LIMITS = { min: 50, max: 5000 }
export const WATCHER_AGE_LIMITS = { min: 1, max: 365 }

/** What a trust rule allows: a command line, a file write, or a tool by name. */
export type TrustKind = 'command' | 'write' | 'tool'
/** Where a trust rule applies. */
export type TrustScope = 'chat' | 'task' | 'agent' | 'folder'

export interface TrustRule {
  id: string
  kind: TrustKind
  scope: TrustScope
  /** The chat id, Agent work id, agent id or folder path. */
  target: string
  /** `*` matches anything (`npm run *`, `/srv/data/*`). */
  pattern: string
  /** ms since epoch; 0 never expires. */
  expiresAt: number
  createdAt: number
  createdBy: string
  /** What it was made from (the alert's text). */
  note: string
}

/** An extra's state, as Settings → Watcher shows it. */
export interface WatcherExtraStatus {
  id: 'pipelock' | 'innerwarden' | 'langfuse'
  enabled: boolean
  /** It can work here (binary, keys or proxy found). */
  available: boolean
  /** Plain words: what it does now, or why it can't here. */
  detail: string
}

/** Approval modes a task or a chat can pick; inherit follows the agent's mode in Settings. */
export const TASK_APPROVAL_MODES = ['inherit', 'ask', 'guarded', 'auto'] as const
export type TaskApprovalMode = typeof TASK_APPROVAL_MODES[number]

/** Hermes's own rule for scheduled jobs (approvals.cron_mode): nobody is there to ask. */
export type CronApprovalMode = 'deny' | 'approve'

/** `*` wildcards; everything else is literal. Case-sensitive (paths and commands are). */
export function trustPatternMatches(pattern: string, value: string): boolean {
  const text = String(value || '').trim()
  const glob = String(pattern || '').trim()
  if (!glob) return false
  if (glob === '*') return true
  const escaped = glob.split('*').map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[\\s\\S]*')
  return new RegExp(`^${escaped}$`).test(text)
}

export function sanitizeWatcherSettings(raw: unknown, base: WatcherSettings = DEFAULT_WATCHER_SETTINGS): WatcherSettings {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Partial<WatcherSettings> & Record<string, any>
  const kinds = {} as Record<WatcherKind, WatcherKindSetting>
  for (const kind of WATCHER_KINDS) {
    const current = base.kinds?.[kind] || DEFAULT_WATCHER_KINDS[kind]
    const next = input.kinds?.[kind] as Partial<WatcherKindSetting> | undefined
    kinds[kind] = {
      alert: typeof next?.alert === 'boolean' ? next.alert : current.alert,
      mattermost: typeof next?.mattermost === 'boolean' ? next.mattermost : current.mattermost,
    }
  }
  const number = (value: unknown, fallback: number, limits: { min: number; max: number }) => {
    const n = Number(value)
    return Number.isFinite(n) ? Math.max(limits.min, Math.min(limits.max, Math.round(n))) : fallback
  }
  const extrasIn = (input.extras || {}) as Partial<WatcherExtrasSettings> & Record<string, any>
  const baseExtras = base.extras || DEFAULT_WATCHER_SETTINGS.extras
  const proxyUrl = typeof extrasIn.pipelock?.proxyUrl === 'string' && /^https?:\/\/[\w.[\]:-]{1,200}\/?$/.test(extrasIn.pipelock.proxyUrl.trim())
    ? extrasIn.pipelock.proxyUrl.trim().replace(/\/$/, '')
    : baseExtras.pipelock.proxyUrl
  const flag = (value: unknown, fallback: boolean) => typeof value === 'boolean' ? value : fallback
  return {
    kinds,
    historySize: number(input.historySize, base.historySize, WATCHER_HISTORY_LIMITS),
    maxAgeDays: number(input.maxAgeDays, base.maxAgeDays, WATCHER_AGE_LIMITS),
    extras: {
      pipelock: { enabled: flag(extrasIn.pipelock?.enabled, baseExtras.pipelock.enabled), proxyUrl },
      innerwarden: { enabled: flag(extrasIn.innerwarden?.enabled, baseExtras.innerwarden.enabled) },
      langfuse: { enabled: flag(extrasIn.langfuse?.enabled, baseExtras.langfuse.enabled) },
    },
  }
}
