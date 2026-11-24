/**
 * Per-run limits that stop a runaway agent (see docs/agent-limits.md).
 * Shared by the server (enforcement) and the client (Settings, chat card).
 */

export type RunLimitKind = 'cost' | 'tokens' | 'time' | 'loop'

/** Limits for one run. null means "no limit". */
export interface RunLimits {
  /** USD spent by the run's model calls. */
  costUsd: number | null
  /** Tokens the model read and wrote in the run (cached included). */
  tokens: number | null
  /** Wall-clock minutes from the run's start. */
  minutes: number | null
  /** Same tool call with the same arguments this many times in a row (or the same failing call this many times). */
  loopRepeats: number | null
}

/** A chat's own limits: any field set here wins over Settings; absent fields follow Settings. */
export type RunLimitOverrides = Partial<RunLimits>

export const DEFAULT_LOOP_REPEATS = 5

export const DEFAULT_RUN_LIMITS: RunLimits = { costUsd: null, tokens: null, minutes: null, loopRepeats: DEFAULT_LOOP_REPEATS }

/** What stopped a run. Kept while the chat waits for "Continue with a higher limit" or "Stop". */
export interface RunLimitHit {
  kind: RunLimitKind
  /** The limit in force (USD, tokens, minutes or repeats). */
  limit: number
  /** What the run reached (same unit). */
  value: number
  /** For the loop detector: the repeated tool call, shortened. */
  detail?: string
  /** For the loop detector: the repeats were failures of the same call. */
  failing?: boolean
  runId?: string
  /** Where the run was stopped: Studio stopped its run, or the model gateway refused the agent's next request. */
  via: 'run' | 'gateway'
  at: number
  /** The higher limit Studio suggests for "Continue". */
  suggested: number
}

export function sanitizeLimitValue(kind: RunLimitKind, value: unknown): number | null {
  if (value === null || value === undefined || value === '' || value === false || value === 'off') return null
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number) || number <= 0) return null
  if (kind === 'cost') return Math.round(number * 10000) / 10000
  if (kind === 'loop') return Math.max(2, Math.min(1000, Math.round(number)))
  if (kind === 'time') return Math.round(number * 100) / 100
  return Math.round(number)
}

export const LIMIT_FIELDS: Record<RunLimitKind, keyof RunLimits> = {
  cost: 'costUsd',
  tokens: 'tokens',
  time: 'minutes',
  loop: 'loopRepeats',
}

/** A comfortable next limit: double it (rounded up to a tidy number). */
export function suggestHigherLimit(kind: RunLimitKind, limit: number): number {
  const doubled = limit * 2
  if (kind === 'cost') return Math.ceil(doubled * 100) / 100
  if (kind === 'loop') return Math.max(limit + 1, Math.ceil(doubled))
  return Math.ceil(doubled)
}
