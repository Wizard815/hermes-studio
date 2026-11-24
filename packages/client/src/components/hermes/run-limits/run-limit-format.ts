import { LIMIT_FIELDS, type RunLimitHit, type RunLimitKind, type RunLimits } from '../../../../../shared/run-limits'

export const LIMIT_KINDS: RunLimitKind[] = ['cost', 'tokens', 'time', 'loop']

/** Input steps and bounds for each limit's number box. */
export const LIMIT_INPUT: Record<RunLimitKind, { min: number; step: number; precision?: number; default: number }> = {
  cost: { min: 0.01, step: 0.5, precision: 2, default: 2 },
  tokens: { min: 1000, step: 50000, default: 500000 },
  time: { min: 1, step: 5, default: 30 },
  loop: { min: 2, step: 1, default: 5 },
}

export function limitValue(limits: RunLimits, kind: RunLimitKind): number | null {
  return limits[LIMIT_FIELDS[kind]]
}

/** "$1.50", "500,000", "30", "5": the number in the limit's own unit (the label carries the unit). */
export function formatLimitNumber(kind: RunLimitKind, value: number, locale?: string): string {
  if (kind === 'cost') return `$${value < 0.1 ? value.toFixed(3) : value.toFixed(2)}`
  if (kind === 'time') return String(Math.round(value * 10) / 10)
  return Math.round(value).toLocaleString(locale)
}

/** The limit with its unit, or the "off" word. */
export function formatLimit(kind: RunLimitKind, value: number | null, words: { off: string; unit: Record<RunLimitKind, string> }, locale?: string): string {
  if (value == null) return words.off
  const number = formatLimitNumber(kind, value, locale)
  return kind === 'cost' ? number : `${number} ${words.unit[kind]}`
}

/** Which banner sentence describes the hit. */
export function hitMessageKey(hit: RunLimitHit): string {
  if (hit.kind === 'loop') return hit.failing ? 'runLimits.banner.loopFailing' : 'runLimits.banner.loop'
  return `runLimits.banner.${hit.kind}`
}
