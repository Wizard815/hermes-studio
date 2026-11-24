import { suggestHigherLimit, type RunLimitHit, type RunLimitKind, type RunLimits } from '../../../../../../shared/run-limits'
import { detectLoopInCalls, LoopDetector, type HistoryToolCall, type LoopVerdict } from './loop-detector'

/**
 * What one run has used so far, checked against its limits. Pure: the
 * service feeds it events, usage and the clock, and acts on the hits.
 */
export interface ActiveRun {
  sessionId: string
  runId: string
  /** 'run': Studio runs the agent (Stop works); 'gateway': only the model gateway sees it (an agent in a herdr pane). */
  via: 'run' | 'gateway'
  startedAt: number
  lastActivity: number
  tokens: number
  costUsd: number
  /** Set when the run used a model whose price is unknown: cost alone cannot stop it. */
  unpricedCalls: number
  turnKey?: string
  loop: LoopDetector
}

export class RunLimitTracker {
  private readonly runs = new Map<string, ActiveRun>()

  constructor(
    private readonly limitsFor: (sessionId: string) => RunLimits,
    private readonly now: () => number = Date.now,
  ) {}

  get(sessionId: string): ActiveRun | undefined { return this.runs.get(sessionId) }
  active(): ActiveRun[] { return [...this.runs.values()] }

  begin(sessionId: string, input: { runId?: string; via: 'run' | 'gateway'; turnKey?: string }): ActiveRun {
    const existing = this.runs.get(sessionId)
    if (existing) {
      // Studio's own run wins over the gateway's view of the same chat.
      if (input.via === 'run') existing.via = 'run'
      if (input.runId && !existing.runId) existing.runId = input.runId
      existing.lastActivity = this.now()
      return existing
    }
    const run: ActiveRun = {
      sessionId, runId: input.runId || '', via: input.via, startedAt: this.now(), lastActivity: this.now(),
      tokens: 0, costUsd: 0, unpricedCalls: 0, turnKey: input.turnKey,
      loop: new LoopDetector(() => this.limitsFor(sessionId).loopRepeats),
    }
    this.runs.set(sessionId, run)
    return run
  }

  end(sessionId: string) { this.runs.delete(sessionId) }

  private hit(run: ActiveRun, kind: RunLimitKind, limit: number, value: number, extra: Partial<RunLimitHit> = {}): RunLimitHit {
    return { kind, limit, value, via: run.via, runId: run.runId || undefined, at: this.now(), suggested: suggestHigherLimit(kind, limit), ...extra }
  }

  private loopHit(run: ActiveRun, verdict: LoopVerdict | null): RunLimitHit | null {
    const limit = this.limitsFor(run.sessionId).loopRepeats
    if (!verdict || !limit) return null
    return this.hit(run, 'loop', limit, verdict.repeats, { detail: verdict.detail, failing: verdict.failing })
  }

  /** Usage of one model call. Cost is undefined when the model has no known price. */
  addUsage(sessionId: string, tokens: number, costUsd?: number): RunLimitHit | null {
    const run = this.runs.get(sessionId)
    if (!run) return null
    run.lastActivity = this.now()
    run.tokens += Math.max(0, tokens || 0)
    if (typeof costUsd === 'number' && Number.isFinite(costUsd)) run.costUsd += Math.max(0, costUsd)
    else if (tokens > 0) run.unpricedCalls++
    return this.checkUsage(run)
  }

  /** A price that arrived after the call was recorded (the model catalog was still loading). */
  addLateCost(sessionId: string, costUsd: number): RunLimitHit | null {
    const run = this.runs.get(sessionId)
    if (!run || !Number.isFinite(costUsd)) return null
    run.costUsd += Math.max(0, costUsd)
    if (run.unpricedCalls > 0) run.unpricedCalls--
    return this.checkUsage(run)
  }

  private checkUsage(run: ActiveRun): RunLimitHit | null {
    const limits = this.limitsFor(run.sessionId)
    if (limits.costUsd != null && run.costUsd >= limits.costUsd) return this.hit(run, 'cost', limits.costUsd, Math.round(run.costUsd * 10000) / 10000)
    if (limits.tokens != null && run.tokens >= limits.tokens) return this.hit(run, 'tokens', limits.tokens, run.tokens)
    return null
  }

  toolStarted(sessionId: string, callId: string, name: unknown, args: unknown): RunLimitHit | null {
    const run = this.runs.get(sessionId)
    if (!run) return null
    run.lastActivity = this.now()
    return this.loopHit(run, run.loop.started(callId, name, args))
  }

  toolFinished(sessionId: string, callId: string, failed: boolean): RunLimitHit | null {
    const run = this.runs.get(sessionId)
    if (!run) return null
    run.lastActivity = this.now()
    return this.loopHit(run, run.loop.finished(callId, failed))
  }

  /** The tool calls of the current turn, as a model request through the gateway carries them. */
  checkHistory(sessionId: string, calls: HistoryToolCall[]): RunLimitHit | null {
    const run = this.runs.get(sessionId)
    if (!run) return null
    return this.loopHit(run, detectLoopInCalls(calls, this.limitsFor(sessionId).loopRepeats))
  }

  checkTime(sessionId: string): RunLimitHit | null {
    const run = this.runs.get(sessionId)
    if (!run) return null
    const minutes = this.limitsFor(sessionId).minutes
    if (minutes == null) return null
    const elapsed = (this.now() - run.startedAt) / 60_000
    return elapsed >= minutes ? this.hit(run, 'time', minutes, Math.round(elapsed * 100) / 100) : null
  }
}
