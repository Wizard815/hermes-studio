import type { TrustRule, WatcherEvent, WatcherExtraStatus, WatcherSettings } from '../../../../../../shared/watcher'
import type { WatcherEventInput, WatcherStore } from './store'
import { sanitizeTrustRule, type WatcherConfigFile } from './config'
import { findTrustRule, type TrustContext, type TrustRequest } from './trust'
import type { WatcherExtras } from './extras'

/**
 * The Watcher (docs/watcher.md). It collects what Studio's guards already do
 * (approvals, run limits, clean rooms, Agent work, plugin installs) into one
 * feed for the bell, posts the kinds Settings picks to Agent work's
 * Mattermost channel, and keeps the "Trust this" rules approvals consult.
 *
 * It never stops anything itself and is not a second approval system: trust
 * rules only answer questions an agent would otherwise ask you, and auto mode
 * never reaches it. What stops a run stays where it was (run limits, the
 * clean room's proxy, pipelock when turned on).
 */
export interface WatcherDeps {
  store: WatcherStore
  config: WatcherConfigFile
  extras?: WatcherExtras
  /** Live update to people who can see the feed (socket room `watcher`). */
  emit?: (event: 'watcher.event' | 'watcher.changed', payload: Record<string, unknown>) => void
  /** Agent work's Mattermost channel; false when none is set. */
  mattermost?: (event: WatcherEvent, title: string) => Promise<boolean>
  /**
   * Blocked alerts for "Where approvals reach you" (docs/approval-alerts.md):
   * `mattermost()` says someone wants them in Mattermost too; `notify` hands
   * each one to paired phones.
   */
  blocked?: { mattermost(): boolean; notify(event: WatcherEvent, title: string): void }
  /** A chat's title, agent and folder. */
  sessionInfo?: (sessionId: string) => { title?: string; agent?: string; folder?: string } | null
  /** A chat's own approval mode (`/yolo`, a task's mode), when it has one. */
  chatApprovalMode?: (sessionId: string) => 'ask' | 'guarded' | 'auto' | undefined
  /** Set (null: clear) a chat's own approval mode: the same store `/yolo` uses. */
  setChatApprovalMode?: (sessionId: string, mode: 'ask' | 'guarded' | 'auto' | null) => void
  /** Agent work tasks running in a chat (for task-scoped trust rules). */
  tasksForSession?: (sessionId: string) => string[]
  onError?: (what: string, error: unknown) => void
  now?: () => number
}

/** The same alert (kind, chat, text) again within this window is dropped: retries must not flood the bell. */
const REPEAT_WINDOW_MS = 60_000

export class WatcherService {
  private recent = new Map<string, number>()

  constructor(private readonly deps: WatcherDeps) {}

  private now() { return this.deps.now?.() ?? Date.now() }
  private fail(what: string, error: unknown) { this.deps.onError?.(what, error) }

  settings(): WatcherSettings { return this.deps.config.settings() }

  saveSettings(input: unknown): WatcherSettings {
    const settings = this.deps.config.saveSettings(input)
    this.prune()
    return settings
  }

  async extras(): Promise<WatcherExtraStatus[]> {
    return this.deps.extras ? this.deps.extras.status(this.settings()) : []
  }

  /** Something happened. Returns the stored alert, or null when Settings does not keep this kind (or it is a repeat). */
  record(input: WatcherEventInput): WatcherEvent | null {
    const settings = this.settings()
    const wanted = settings.kinds[input.kind]
    const forward = input.severity === 'block' && input.kind !== 'approval_denied' ? this.deps.blocked : undefined
    if (!wanted || (!wanted.alert && !wanted.mattermost && !forward)) return null
    const now = this.now()
    const repeatKey = `${input.kind}|${input.sessionId || ''}|${input.taskId || ''}|${input.text}`
    const last = this.recent.get(repeatKey)
    if (last && now - last < REPEAT_WINDOW_MS) return null
    this.recent.set(repeatKey, now)
    if (this.recent.size > 500) for (const [key, at] of this.recent) if (now - at > REPEAT_WINDOW_MS) this.recent.delete(key)

    const info = input.sessionId ? safeCall(() => this.deps.sessionInfo?.(input.sessionId!)) : null
    const filled: WatcherEventInput = {
      ...input,
      agent: input.agent || info?.agent || '',
      folder: input.folder || info?.folder || '',
      link: input.link || (input.sessionId ? `/hermes/session/${encodeURIComponent(input.sessionId)}` : input.taskId ? '/hermes/connections?tab=agent-work' : ''),
    }
    if (!filled.trace && filled.sessionId && (filled.agent === 'hermes' || !filled.agent) && this.deps.extras) {
      filled.trace = this.deps.extras.traceLink(settings, filled.sessionId) || undefined
    }
    const title = info?.title?.trim() || (input.sessionId ? `Chat ${input.sessionId.slice(0, 8)}` : '')
    let event: WatcherEvent | null = null
    if (wanted.alert) {
      event = this.deps.store.add(filled, now)
      this.prune()
      this.deps.emit?.('watcher.event', { event, unread: this.deps.store.unreadCount() })
    }
    const post = event || { ...filled, id: 0, time: now, read: false, sessionId: filled.sessionId || '', taskId: filled.taskId || '', agent: filled.agent || '', folder: filled.folder || '', link: filled.link || '' } as WatcherEvent
    const extraMattermost = !!forward && !wanted.mattermost && !!safeCall(() => forward.mattermost())
    if ((wanted.mattermost || extraMattermost) && this.deps.mattermost) {
      void this.deps.mattermost(post, title).catch(error => this.fail('mattermost', error))
    }
    if (forward) safeCall(() => forward.notify(post, title))
    return event
  }

  list(options: { limit?: number; unreadOnly?: boolean; before?: number } = {}) {
    return { events: this.deps.store.list(options), unread: this.deps.store.unreadCount(), total: this.deps.store.total() }
  }

  markRead(ids: number[]) { this.deps.store.markRead(ids); return this.changed() }
  markAllRead() { this.deps.store.markAllRead(); return this.changed() }
  clear(ids?: number[]) { this.deps.store.clear(ids); return this.changed() }

  private changed() {
    const unread = this.deps.store.unreadCount()
    this.deps.emit?.('watcher.changed', { unread })
    return { unread }
  }

  prune(): void {
    const settings = this.settings()
    try { this.deps.store.prune(settings.historySize, settings.maxAgeDays * 86_400_000, this.now()) } catch (error) { this.fail('prune', error) }
  }

  /** A chat's own approval mode, for agents whose approvals Studio only relays (Hermes). */
  chatMode(sessionId: string): 'ask' | 'guarded' | 'auto' | undefined {
    return sessionId ? safeCall(() => this.deps.chatApprovalMode?.(sessionId)) || undefined : undefined
  }

  setChatMode(sessionId: string, mode: 'ask' | 'guarded' | 'auto' | null): void {
    if (!this.deps.setChatApprovalMode) throw Object.assign(new Error('Approval modes are not available'), { status: 503 })
    this.deps.setChatApprovalMode(sessionId, mode)
  }

  // --- Trust rules -----------------------------------------------------------

  rules(): TrustRule[] {
    this.deps.config.dropExpired(this.now())
    return this.deps.config.rules()
  }

  addRule(input: unknown, by = ''): TrustRule {
    const rule = sanitizeTrustRule(input, this.now(), by)
    this.deps.config.addRule(rule)
    this.deps.emit?.('watcher.changed', { unread: this.deps.store.unreadCount(), rules: true })
    return rule
  }

  removeRule(id: string): boolean {
    const removed = this.deps.config.removeRule(id)
    if (removed) this.deps.emit?.('watcher.changed', { unread: this.deps.store.unreadCount(), rules: true })
    return removed
  }

  /**
   * Whether a trust rule answers this question. Called by every approval path
   * before it asks you; a match is answered "once" and noted in the feed.
   */
  trusts(context: TrustContext, request: TrustRequest | null, note = ''): TrustRule | null {
    if (!request) return null
    const rules = this.deps.config.rules()
    if (!rules.length) return null
    const taskIds = context.taskIds || (context.sessionId ? safeCall(() => this.deps.tasksForSession?.(context.sessionId!)) || [] : [])
    const rule = findTrustRule(rules, { ...context, taskIds }, request, this.now())
    if (rule) {
      this.record({
        kind: 'approval_trusted', severity: 'info', sessionId: context.sessionId, agent: context.agentId, folder: context.folder,
        text: `Allowed by a trust rule (${rule.scope}: "${rule.pattern}"): ${note || request.values.join(' ')}`.slice(0, 600),
      })
    }
    return rule
  }
}

function safeCall<T>(fn: () => T): T | null {
  try { return fn() } catch { return null }
}
