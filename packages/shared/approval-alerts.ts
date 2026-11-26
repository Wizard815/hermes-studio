/**
 * Where approvals reach you (docs/approval-alerts.md): Mattermost, the Studio
 * Own Android app, both, or off, per Studio user, for each kind of question.
 * Shared by the server and the client.
 */

export const APPROVAL_ROUTES = ['mattermost', 'android', 'both', 'off'] as const
export type ApprovalRoute = typeof APPROVAL_ROUTES[number]

/**
 * - `work`: Agent work waiting for approval (Connections → Agent work).
 * - `chat`: a chat's own "Allow once / Deny" (Hermes, Ekko, coding agents).
 * - `phone`: an agent asking to use a phone (Android page, "Agents on the phone").
 * - `blocked`: the watcher's Blocked alerts (run limits, clean-room blocks…). Nothing to answer.
 */
export const APPROVAL_ALERT_KINDS = ['work', 'chat', 'phone', 'blocked'] as const
export type ApprovalAlertKind = typeof APPROVAL_ALERT_KINDS[number]

export interface ApprovalAlertPrefs {
  route: ApprovalRoute
  kinds: Record<ApprovalAlertKind, boolean>
}

/**
 * What a user who never picked gets: what Studio did before this setting.
 * Agent work approvals go to Mattermost (when Connections → Agent work has a
 * channel); nothing else is sent anywhere new.
 */
export const DEFAULT_APPROVAL_ALERT_PREFS: ApprovalAlertPrefs = {
  route: 'mattermost',
  kinds: { work: true, chat: false, phone: false, blocked: false },
}

export function routeIncludes(route: ApprovalRoute, place: 'mattermost' | 'android'): boolean {
  return route === 'both' || route === place
}

export function sanitizeApprovalAlertPrefs(raw: unknown, base: ApprovalAlertPrefs = DEFAULT_APPROVAL_ALERT_PREFS): ApprovalAlertPrefs {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Partial<ApprovalAlertPrefs>
  const route = (APPROVAL_ROUTES as readonly string[]).includes(String(input.route)) ? input.route as ApprovalRoute : base.route
  const kinds = {} as Record<ApprovalAlertKind, boolean>
  for (const kind of APPROVAL_ALERT_KINDS) {
    const value = (input.kinds as Record<string, unknown> | undefined)?.[kind]
    kinds[kind] = typeof value === 'boolean' ? value : base.kinds[kind]
  }
  return { route, kinds }
}

/** One question (or Blocked alert) as the phone gets it. */
export interface ApprovalAlertItem {
  /** `work-…`, `chat-…`, `phone-…` or `alert-…`; what the answer routes take. */
  id: string
  kind: ApprovalAlertKind
  /** Short, for the notification title: "Claude Code asks to run a command". */
  title: string
  /** One or two lines: the command, the task, the phone action. */
  detail: string
  /** ms since epoch */
  at: number
  /** The chat it is in, when there is one (tapping opens it). */
  sessionId: string
  /** Studio route to open (`/hermes/session/<id>`, `/android`, …). */
  link: string
  /** The app asks before answering it from the notification. */
  dangerous: boolean
  /** False for Blocked alerts: they only open Studio. */
  answerable: boolean
}

/** A paired phone, as Settings → Android app lists it (never its key). */
export interface ApprovalDevice {
  id: string
  name: string
  /** `sk-studio-phone-…abcd` */
  preview: string
  userId: number
  createdAt: number
  lastUsedAt: number | null
  /** The phone holds the live stream open right now. */
  connected: boolean
}

export const PHONE_KEY_PREFIX = 'sk-studio-phone-'

/** Commands and tools that make the app ask before answering from a notification. */
const DANGEROUS = /(\brm\s+-[a-z]*[rf]|\bsudo\b|\bmkfs|\bdd\s+if=|\bchmod\s+-R|\bchown\s+-R|\bgit\s+push\b[^\n]*(--force|-f\b)|\bgit\s+reset\s+--hard|(curl|wget)\b[^|\n]*\|\s*(ba|z)?sh\b|\bdrop\s+(table|database)\b|\btruncate\s+table\b|\bshutdown\b|\breboot\b|\bdelete\b|\buninstall\b|\bkill\s+-9\b|>\s*\/dev\/sd)/i

export function looksDangerous(text: string): boolean {
  return DANGEROUS.test(String(text || ''))
}
