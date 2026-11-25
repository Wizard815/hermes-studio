/**
 * Too many tools for a small model (docs/hermes-tool-load.md): when a Hermes chat
 * starts with more tools than the threshold, Studio shows a one-time notice in the
 * chat and notes it in the watcher. Shared by the server and the client.
 */

/** Hermes's `tools.tool_search.enabled` in config.yaml. */
export type ToolSearchSetting = 'auto' | 'on' | 'off'

export interface ToolLoadNotice {
  sessionId: string
  profile: string
  /** Every tool the chat has: the visible ones plus the ones tool search hides. */
  total: number
  /** Tools hidden behind tool_search / tool_describe / tool_call. */
  deferred: number
  /** Tool search replaced tools in this chat. */
  toolSearchActive: boolean
  toolSearch: ToolSearchSetting
  threshold: number
  /** ms since epoch */
  at: number
  dismissed: boolean
}

export interface ToolLoadSettings {
  /** Warn when a chat has more tools than this. 0 turns the notice off. */
  threshold: number
}

export const DEFAULT_TOOL_LOAD_THRESHOLD = 80
export const TOOL_LOAD_THRESHOLD_LIMITS = { min: 0, max: 2000 }

export function sanitizeToolLoadThreshold(value: unknown, fallback = DEFAULT_TOOL_LOAD_THRESHOLD): number {
  if (value === null || value === undefined || value === '') return fallback
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(TOOL_LOAD_THRESHOLD_LIMITS.min, Math.min(TOOL_LOAD_THRESHOLD_LIMITS.max, Math.round(n)))
}

/** Hermes's own reading of the value: bool-ish words count, anything else is auto. */
export function toToolSearchSetting(value: unknown): ToolSearchSetting {
  const text = String(value ?? 'auto').trim().toLowerCase()
  if (['off', 'false', '0', 'no'].includes(text)) return 'off'
  if (['on', 'true', '1', 'yes'].includes(text)) return 'on'
  return 'auto'
}
