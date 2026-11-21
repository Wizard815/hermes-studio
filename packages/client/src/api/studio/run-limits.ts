import { request } from '../client'
import type { RunLimitHit, RunLimitKind, RunLimitOverrides, RunLimits } from '../../../../shared/run-limits'

/** Run limits (docs/agent-limits.md): Settings' limits and each chat's own. */
export interface ChatRunLimits {
  defaults: RunLimits
  overrides: RunLimitOverrides
  effective: RunLimits
  hit: RunLimitHit | null
  run: { via: 'run' | 'gateway'; startedAt: number; tokens: number; costUsd: number; unpricedCalls: number; minutes: number } | null
  raised?: { kind: RunLimitKind; value: number } | null
}

const base = '/api/studio/run-limits'
const chat = (id: string) => `${base}/chats/${encodeURIComponent(id)}`

export const fetchRunLimitDefaults = () => request<{ defaults: RunLimits }>(base)
export const saveRunLimitDefaults = (defaults: Partial<RunLimits>) =>
  request<{ defaults: RunLimits }>(base, { method: 'PUT', body: JSON.stringify({ defaults }) })
export const fetchChatRunLimits = (sessionId: string) => request<ChatRunLimits>(chat(sessionId))
/** `limits` fields set the chat's own value (null: off in this chat); `clear` fields follow Settings again. */
export const saveChatRunLimits = (sessionId: string, input: { limits?: RunLimitOverrides; clear?: Array<keyof RunLimits>; reset?: boolean }) =>
  request<ChatRunLimits>(chat(sessionId), { method: 'PUT', body: JSON.stringify(input) })
export const continueChatRun = (sessionId: string, value?: number) =>
  request<ChatRunLimits>(`${chat(sessionId)}/continue`, { method: 'POST', body: JSON.stringify(value === undefined ? {} : { value }) })
export const stopChatAtLimit = (sessionId: string) =>
  request<ChatRunLimits>(`${chat(sessionId)}/stop`, { method: 'POST', body: '{}' })
