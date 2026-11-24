import {
  LIMIT_FIELDS, sanitizeLimitValue, suggestHigherLimit,
  type RunLimitHit, type RunLimitKind, type RunLimitOverrides, type RunLimits,
} from '../../../../../../shared/run-limits'
import { readGatewayTurn, type GatewayProtocol } from './gateway-history'
import { RunLimitTracker } from './tracker'
import type { RunLimitSettingsStore } from './settings'

/**
 * Run limits (docs/agent-limits.md): cost, tokens and time per run, and the
 * loop detector, for every chat type. Studio's chat runs feed it their events
 * (`observeEvent`) and recorded usage (`observeUsage`); the model gateway asks
 * it before passing each request of a coding agent on (`checkGatewayRequest`),
 * which also covers agents that run in a herdr pane, outside Studio's runs.
 *
 * When a limit is hit, the run stops the way Stop stops it for that chat
 * type, the chat says which limit and the numbers, the chat shows blocked (in
 * Studio, herdr and the Inbox) and an optional Mattermost alert goes out. The
 * chat then waits for "Continue with a higher limit" or "Stop".
 */
export interface RunLimitDeps {
  store: RunLimitSettingsStore
  /** Stop the chat's Studio run like Stop does. Resolves false when nothing was running. */
  stopRun: (sessionId: string) => Promise<boolean>
  /** Persist and show a line in the chat (a command result, so it never reaches the model). */
  postNotice: (sessionId: string, text: string, hit: RunLimitHit) => void
  /** The chat's blocked state, read by the chat list, herdr and the Inbox. */
  setHit: (sessionId: string, hit: RunLimitHit | null) => void
  getHit: (sessionId: string) => RunLimitHit | undefined
  /** Optional alert (Mattermost, when Agent work's channel is set). */
  alert?: (sessionId: string, text: string, hit: RunLimitHit) => Promise<void> | void
  /** Price of a gateway call an agent outside Studio's runs made (undefined when the model has no known price). */
  priceGatewayUsage?: (input: { profile?: string; provider?: string; model?: string; usage: GatewayUsage }) => number | undefined
  onError?: (what: string, error: unknown) => void
  now?: () => number
}

export interface GatewayUsage { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }

export interface GatewayRequestInput {
  sessionId?: string
  runId?: string
  protocol: GatewayProtocol
  body: unknown
}

/** What the gateway answers instead of passing the request on. */
export interface GatewayRefusal { status: number; message: string; hit: RunLimitHit }

/** Runs only the gateway sees end on their own after this long without a request. */
const GATEWAY_IDLE_MS = 15 * 60_000
const TICK_MS = 5000

function formatNumber(value: number): string {
  return Math.round(value).toLocaleString('en-US')
}

export function formatLimitValue(kind: RunLimitKind, value: number | null): string {
  if (value == null) return 'off'
  if (kind === 'cost') return `$${value < 1 ? value.toFixed(value < 0.1 ? 3 : 2) : value.toFixed(2)}`
  if (kind === 'tokens') return `${formatNumber(value)} tokens`
  if (kind === 'time') return `${Math.round(value * 10) / 10} min`
  return `${value} in a row`
}

/** The chat line for a hit: which limit, the numbers, and what to do next. */
export function describeHit(hit: RunLimitHit): string {
  let head: string
  if (hit.kind === 'cost') head = `cost limit reached: this run used ${formatLimitValue('cost', hit.value)} of its ${formatLimitValue('cost', hit.limit)} limit`
  else if (hit.kind === 'tokens') head = `token limit reached: this run used ${formatNumber(hit.value)} of its ${formatNumber(hit.limit)} tokens`
  else if (hit.kind === 'time') head = `time limit reached: this run ran ${Math.round(hit.value * 10) / 10} of its ${Math.round(hit.limit * 10) / 10} minutes`
  else head = hit.failing
    ? `loop detected: the same call failed ${hit.value} times in a row (limit ${hit.limit})`
    : `loop detected: the same tool call with the same arguments ran ${hit.value} times in a row (limit ${hit.limit})`
  const detail = hit.kind === 'loop' && hit.detail ? `\n\`${hit.detail.replace(/`/g, "'")}\`` : ''
  const next = `\nContinue with a higher limit (${formatLimitValue(hit.kind, hit.suggested)}) or Stop. /limits shows and changes this chat's limits.`
  return `Run stopped by Studio: ${head}.${detail}${next}`
}

function parseAmount(kind: RunLimitKind, raw: string): number | null | 'default' | undefined {
  const text = raw.trim().toLowerCase()
  if (!text) return undefined
  if (['off', 'none', 'no', 'unlimited', '0'].includes(text)) return null
  if (['default', 'settings', 'reset', 'inherit'].includes(text)) return 'default'
  let number = text.replace(/^\$/, '').replace(/,/g, '').replace(/(usd|min|mins|minutes|m|x|times)$/, '')
  let factor = 1
  if (kind === 'tokens') {
    const unit = /([km])$/.exec(number)
    if (unit) { factor = unit[1] === 'k' ? 1000 : 1_000_000; number = number.slice(0, -1) }
  }
  if (kind === 'time' && /h$/.test(number)) { factor = 60; number = number.slice(0, -1) }
  const value = Number(number) * factor
  if (!Number.isFinite(value) || value <= 0) return undefined
  return sanitizeLimitValue(kind, value)
}

const COMMAND_KINDS: Record<string, RunLimitKind> = {
  cost: 'cost', usd: 'cost', '$': 'cost', budget: 'cost',
  tokens: 'tokens', token: 'tokens',
  time: 'time', minutes: 'time', min: 'time',
  loop: 'loop', loops: 'loop', repeats: 'loop',
}

export class RunLimitService {
  readonly tracker: RunLimitTracker
  private readonly hitTurns = new Map<string, string>()
  private readonly stopping = new Set<string>()
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(private readonly deps: RunLimitDeps) {
    this.tracker = new RunLimitTracker(sessionId => this.limits(sessionId), () => this.now())
  }

  private now() { return this.deps.now?.() ?? Date.now() }
  private fail(what: string, error: unknown) { this.deps.onError?.(what, error) }

  start() {
    if (this.timer) return
    this.timer = setInterval(() => this.tick(), TICK_MS)
    this.timer.unref?.()
  }

  close() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  limits(sessionId: string): RunLimits { return this.deps.store.effective(sessionId) }

  /** Settings' limits (every chat follows them unless it sets its own). */
  defaults(): RunLimits { return this.deps.store.defaults() }
  saveDefaults(input: unknown): RunLimits { return this.deps.store.saveDefaults(input) }

  describe(sessionId: string) {
    return {
      defaults: this.deps.store.defaults(),
      overrides: this.deps.store.overrides(sessionId),
      effective: this.limits(sessionId),
      hit: this.deps.getHit(sessionId) || null,
      run: this.runSnapshot(sessionId),
    }
  }

  private runSnapshot(sessionId: string) {
    const run = this.tracker.get(sessionId)
    if (!run) return null
    return {
      via: run.via, startedAt: run.startedAt, tokens: run.tokens,
      costUsd: Math.round(run.costUsd * 10000) / 10000, unpricedCalls: run.unpricedCalls,
      minutes: Math.round((this.now() - run.startedAt) / 600) / 100,
    }
  }

  // --- what runs report ------------------------------------------------------

  observeEvent(sessionId: string, event: string, payload: Record<string, any> = {}) {
    if (!sessionId || payload?.replayed || payload?.restored || payload?.background_snapshot) return
    try {
      if (event === 'run.started') {
        const runId = typeof payload.run_id === 'string' ? payload.run_id : ''
        const existing = this.tracker.get(sessionId)
        // A new run in the chat (a stale one never reported its end): start counting again.
        if (existing && (existing.via === 'gateway' || (runId && existing.runId && existing.runId !== runId))) this.tracker.end(sessionId)
        // The person sent something new: the chat is not waiting on the limit any more.
        if (this.deps.getHit(sessionId) && !this.stopping.has(sessionId)) this.clearHit(sessionId)
        this.tracker.begin(sessionId, { runId, via: 'run' })
        return
      }
      if (event === 'tool.started') {
        const id = String(payload.tool_call_id || payload.call_id || '')
        this.act(sessionId, this.tracker.toolStarted(sessionId, id, payload.name || payload.tool || payload.tool_name, payload.arguments ?? payload.args ?? payload.input))
        return
      }
      if (event === 'tool.completed' || event === 'tool.failed') {
        const id = String(payload.tool_call_id || payload.call_id || '')
        this.act(sessionId, this.tracker.toolFinished(sessionId, id, event === 'tool.failed' || !!payload.error))
        return
      }
      if (event === 'run.completed' || event === 'run.failed' || event === 'abort.completed') {
        const run = this.tracker.get(sessionId)
        if (run?.via === 'run') this.tracker.end(sessionId)
      }
    } catch (error) { this.fail('run event', error) }
  }

  observeUsage(notice: { sessionId: string; tokens: number; costUsd?: number; late: boolean }) {
    try {
      const run = this.tracker.get(notice.sessionId)
      // Gateway-only runs count what the gateway saw; Studio's ledger would count the same call again.
      if (!run || run.via !== 'run') return
      const hit = notice.late
        ? (notice.costUsd !== undefined ? this.tracker.addLateCost(notice.sessionId, notice.costUsd) : null)
        : this.tracker.addUsage(notice.sessionId, notice.tokens, notice.costUsd)
      this.act(notice.sessionId, hit)
    } catch (error) { this.fail('usage', error) }
  }

  /** A response that passed through the gateway for an agent outside Studio's runs (a herdr pane). */
  observeGatewayUsage(input: { sessionId?: string; profile?: string; provider?: string; model?: string; usage: GatewayUsage }) {
    if (!input.sessionId) return
    try {
      const run = this.tracker.get(input.sessionId)
      if (!run || run.via !== 'gateway') return
      const { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens } = input.usage
      const tokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens
      let cost: number | undefined
      try { cost = this.deps.priceGatewayUsage?.(input) } catch { cost = undefined }
      // Gateway-only runs are stopped by refusing their next request (see checkGatewayRequest).
      const hit = this.tracker.addUsage(input.sessionId, tokens, cost)
      if (hit) this.act(input.sessionId, hit)
    } catch (error) { this.fail('gateway usage', error) }
  }

  /**
   * Before the gateway passes a coding agent's request on: the turn's tool
   * calls (loop detector), the run's time, and a limit already hit. A refusal
   * ends the agent's turn with an error the agent shows.
   */
  checkGatewayRequest(input: GatewayRequestInput): GatewayRefusal | null {
    const sessionId = input.sessionId
    if (!sessionId) return null
    try {
      const turn = readGatewayTurn(input.protocol, input.body)
      const pending = this.deps.getHit(sessionId)
      if (pending) {
        const sameTurn = !turn.turnKey || this.hitTurns.get(sessionId) === turn.turnKey
        // The person answered in the pane with a new message: that is their go-ahead.
        if (sameTurn || this.stopping.has(sessionId)) return { status: 400, message: describeHit(pending), hit: pending }
        this.clearHit(sessionId)
      }
      let run = this.tracker.get(sessionId)
      if (run?.via === 'gateway' && ((turn.turnKey && run.turnKey && run.turnKey !== turn.turnKey) || this.now() - run.lastActivity > GATEWAY_IDLE_MS)) {
        this.tracker.end(sessionId)
        run = undefined
      }
      run = this.tracker.begin(sessionId, { via: 'gateway', runId: run ? undefined : input.runId, turnKey: turn.turnKey })
      if (run.via === 'gateway' && turn.turnKey) run.turnKey = turn.turnKey
      const hit = this.tracker.checkHistory(sessionId, turn.calls)
        || this.tracker.checkTime(sessionId)
        || this.usageHit(sessionId)
      if (!hit) return null
      if (turn.turnKey) this.hitTurns.set(sessionId, turn.turnKey)
      this.act(sessionId, hit)
      return { status: 400, message: describeHit(hit), hit }
    } catch (error) {
      this.fail('gateway check', error)
      return null
    }
  }

  /** Cost or tokens already past a limit that was lowered while the run went on. */
  private usageHit(sessionId: string): RunLimitHit | null {
    return this.tracker.addUsage(sessionId, 0)
  }

  tick() {
    for (const run of this.tracker.active()) {
      if (run.via === 'gateway') {
        if (this.now() - run.lastActivity > GATEWAY_IDLE_MS) this.tracker.end(run.sessionId)
        continue
      }
      this.act(run.sessionId, this.tracker.checkTime(run.sessionId))
    }
  }

  // --- what a hit does ---------------------------------------------------------

  private act(sessionId: string, hit: RunLimitHit | null) {
    if (!hit || this.stopping.has(sessionId) || this.deps.getHit(sessionId)) return
    this.stopping.add(sessionId)
    const run = this.tracker.get(sessionId)
    if (run?.turnKey && !this.hitTurns.has(sessionId)) this.hitTurns.set(sessionId, run.turnKey)
    this.deps.setHit(sessionId, hit)
    // Out of the event that caught it: stopping emits events of its own.
    setTimeout(() => { void this.stop(sessionId, hit) }, 0)
  }

  private async stop(sessionId: string, hit: RunLimitHit) {
    const text = describeHit(hit)
    try {
      if (hit.via === 'run') await this.deps.stopRun(sessionId)
    } catch (error) { this.fail('stop', error) }
    if (this.tracker.get(sessionId)?.via === 'run') this.tracker.end(sessionId)
    this.stopping.delete(sessionId)
    try { this.deps.postNotice(sessionId, text, hit) } catch (error) { this.fail('notice', error) }
    try { await this.deps.alert?.(sessionId, text, hit) } catch (error) { this.fail('alert', error) }
  }

  private clearHit(sessionId: string) {
    this.hitTurns.delete(sessionId)
    this.deps.setHit(sessionId, null)
  }

  /** "Continue with a higher limit": raise the limit that stopped the run for this chat. */
  continueWithHigherLimit(sessionId: string, value?: unknown): { limits: RunLimits; raised?: { kind: RunLimitKind; value: number } } {
    const hit = this.deps.getHit(sessionId)
    if (!hit) return { limits: this.limits(sessionId) }
    const field = LIMIT_FIELDS[hit.kind]
    const requested = value === undefined ? null : sanitizeLimitValue(hit.kind, value)
    const current = this.limits(sessionId)[field] ?? hit.limit
    const next = requested && requested > current ? requested : Math.max(hit.suggested, suggestHigherLimit(hit.kind, current))
    this.deps.store.saveOverrides(sessionId, { [field]: next })
    // A gateway-only run keeps going with the higher limit; the agent's next request passes.
    this.clearHit(sessionId)
    return { limits: this.limits(sessionId), raised: { kind: hit.kind, value: next } }
  }

  /** "Stop": the run already stopped; the chat stops waiting on the limit. */
  dismiss(sessionId: string): void {
    if (!this.deps.getHit(sessionId)) return
    const run = this.tracker.get(sessionId)
    if (run?.via === 'gateway') this.tracker.end(sessionId)
    this.clearHit(sessionId)
  }

  saveChatLimits(sessionId: string, input: unknown, options: { reset?: boolean; clear?: Array<keyof RunLimits> } = {}): RunLimitOverrides {
    return this.deps.store.saveOverrides(sessionId, input, options)
  }

  forgetChat(sessionId: string) {
    this.tracker.end(sessionId)
    this.hitTurns.delete(sessionId)
    try { this.deps.store.forget(sessionId) } catch (error) { this.fail('forget', error) }
  }

  // --- /limits -------------------------------------------------------------------

  /**
   * `/limits` in any chat: show this chat's limits, or change them.
   *   /limits                         show
   *   /limits cost 2 | tokens 500k | time 30 | loop 8
   *   /limits cost off                no cost limit in this chat
   *   /limits cost default            follow Settings again
   *   /limits off                     no limits at all in this chat (yolo)
   *   /limits reset                   follow Settings for everything
   */
  command(sessionId: string, args: string): { ok: boolean; message: string } {
    const words = args.trim().split(/\s+/).filter(Boolean)
    const show = (prefix = '') => ({ ok: true, message: `${prefix}${this.summary(sessionId)}` })
    if (!words.length || words[0] === 'show' || words[0] === 'status') return show()
    const first = words[0].toLowerCase()
    if (first === 'help') return { ok: true, message: COMMAND_HELP }
    if (first === 'reset' || first === 'default' || first === 'settings') {
      this.deps.store.saveOverrides(sessionId, {}, { reset: true })
      return show('This chat follows the limits in Settings again.\n')
    }
    if (first === 'off' || first === 'yolo' || first === 'none') {
      this.deps.store.saveOverrides(sessionId, { costUsd: null, tokens: null, minutes: null, loopRepeats: null }, { reset: true })
      return show('All run limits are off for this chat, the loop detector too. /limits reset turns them back on.\n')
    }
    const changes: RunLimitOverrides = {}
    const clear: Array<keyof RunLimits> = []
    for (let index = 0; index < words.length; index += 2) {
      const kind = COMMAND_KINDS[words[index].toLowerCase().replace(/[:=]$/, '')]
      const amount = kind ? parseAmount(kind, words[index + 1] || '') : undefined
      if (!kind || amount === undefined) return { ok: false, message: `Could not read "${words.slice(index, index + 2).join(' ')}".\n${COMMAND_HELP}` }
      if (amount === 'default') clear.push(LIMIT_FIELDS[kind])
      else changes[LIMIT_FIELDS[kind]] = amount
    }
    this.deps.store.saveOverrides(sessionId, changes, { clear })
    return show('Saved for this chat.\n')
  }

  summary(sessionId: string): string {
    const effective = this.limits(sessionId)
    const own = this.deps.store.overrides(sessionId)
    const line = (kind: RunLimitKind, label: string) => {
      const field = LIMIT_FIELDS[kind]
      const source = field in own ? 'this chat' : 'Settings'
      return `${label}: ${formatLimitValue(kind, effective[field])} (${source})`
    }
    const run = this.runSnapshot(sessionId)
    const lines = [
      'Run limits for this chat:',
      line('cost', 'Cost per run'),
      line('tokens', 'Tokens per run'),
      line('time', 'Time per run'),
      line('loop', 'Loop detector (same call)'),
    ]
    if (run) lines.push(`This run so far: $${run.costUsd.toFixed(4)}${run.unpricedCalls ? ` (+${run.unpricedCalls} calls with no known price)` : ''}, ${formatNumber(run.tokens)} tokens, ${run.minutes} min.`)
    return lines.join('\n')
  }
}

const COMMAND_HELP = [
  'Usage: /limits [cost <usd>|tokens <n>|time <minutes>|loop <n>] … ',
  'Values: a number, off (no limit in this chat) or default (follow Settings).',
  '/limits off turns every limit off for this chat; /limits reset follows Settings again.',
].join('\n')
