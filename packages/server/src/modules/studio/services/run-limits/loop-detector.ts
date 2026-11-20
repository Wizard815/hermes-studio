/**
 * Loop detector: the same tool call with the same arguments N times in a row,
 * or the same call failing N times while nothing else succeeds in between.
 * Pure and runtime-neutral: Studio feeds it the tool events of a run, and the
 * model gateway feeds it the tool calls in a request's history.
 */

export interface LoopVerdict {
  repeats: number
  failing: boolean
  /** The repeated call, shortened for the chat message. */
  detail: string
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) out[key] = canonical((value as Record<string, unknown>)[key])
    return out
  }
  return value
}

/** Arguments arrive as objects or JSON text depending on the runtime; both give the same signature. */
export function toolArgumentsText(args: unknown): string {
  let value = args
  if (typeof value === 'string') {
    const text = value.trim()
    if (!text) return ''
    try { value = JSON.parse(text) } catch { return text }
  }
  if (value === undefined || value === null) return ''
  try { return JSON.stringify(canonical(value)) } catch { return String(value) }
}

export function toolSignature(name: unknown, args: unknown): string {
  return `${String(name || '').trim()}\u0000${toolArgumentsText(args)}`
}

export function describeToolCall(name: unknown, args: unknown, max = 160): string {
  const text = toolArgumentsText(args)
  const call = `${String(name || 'tool').trim() || 'tool'}(${text})`
  return call.length > max ? `${call.slice(0, max - 1)}…` : call
}

export class LoopDetector {
  private lastSignature = ''
  private streak = 0
  private readonly calls = new Map<string, { signature: string; detail: string }>()
  private readonly failures = new Map<string, number>()
  private readonly seenStarts = new Set<string>()
  private readonly seenEnds = new Set<string>()

  /** threshold() is read on every check, so a raised limit applies to the running run. */
  constructor(private readonly threshold: () => number | null) {}

  started(callId: string, name: unknown, args: unknown): LoopVerdict | null {
    const id = callId || `call_${this.seenStarts.size}`
    if (this.seenStarts.has(id)) return null
    this.seenStarts.add(id)
    const signature = toolSignature(name, args)
    const detail = describeToolCall(name, args)
    this.calls.set(id, { signature, detail })
    if (this.calls.size > 500) this.calls.delete(this.calls.keys().next().value as string)
    this.streak = signature === this.lastSignature ? this.streak + 1 : 1
    this.lastSignature = signature
    const limit = this.threshold()
    return limit && this.streak >= limit ? { repeats: this.streak, failing: false, detail } : null
  }

  finished(callId: string, failed: boolean): LoopVerdict | null {
    if (!callId || this.seenEnds.has(callId)) return null
    this.seenEnds.add(callId)
    const call = this.calls.get(callId)
    if (!call) return null
    if (!failed) {
      // Something worked: the agent is making progress, failure streaks start over.
      this.failures.clear()
      return null
    }
    const count = (this.failures.get(call.signature) || 0) + 1
    this.failures.set(call.signature, count)
    const limit = this.threshold()
    return limit && count >= limit ? { repeats: count, failing: true, detail: call.detail } : null
  }
}

/** One tool call found in a model request's history (the current turn only). */
export interface HistoryToolCall { id: string; name: string; args: unknown; failed?: boolean; answered: boolean }

/**
 * Replays a turn's tool calls through a fresh detector and returns what the
 * latest call shows. The gateway checks every request, so an earlier loop in
 * the same turn was already caught by the request that followed it.
 */
export function detectLoopInCalls(calls: HistoryToolCall[], threshold: number | null): LoopVerdict | null {
  if (!threshold) return null
  const detector = new LoopDetector(() => threshold)
  let verdict: LoopVerdict | null = null
  calls.forEach((call, index) => {
    const id = call.id || `history_${index}`
    const started = detector.started(id, call.name, call.args)
    const finished = call.answered ? detector.finished(id, call.failed === true) : null
    verdict = finished || started
  })
  return verdict
}
