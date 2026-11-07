import type { Socket } from 'socket.io'
import type { AuthenticatedUser } from '../public/auth'
import { logger } from '../public/logging'
import { listSessionStateRecords, markSessionRead, type SessionStateRecord } from '../repositories/session-state-store'
import type { SessionListState } from '../../../../../shared/session-state'
import { getSessionHerdrLink, onSessionHerdrLinkChanged, onSessionListChanged } from '../public/session-status'

interface RuntimeState { working: boolean; backgroundPending: number; collaborationPending?: number }
type Subscriber = { socket: Socket; user: AuthenticatedUser }

/** Uses the authenticated chat transport, but never joins transcript rooms. */
export class SessionStateSync {
  private readonly subscribers = new Set<Subscriber>()
  private readonly foreground = new Map<string, boolean>()
  private readonly pending = new Map<string, number>()
  /** Open approval/clarification ids per session; non-empty means blocked. */
  private readonly interactions = new Map<string, Set<string>>()
  private readonly retries = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly unsubscribe: Array<() => void> = []

  constructor(private readonly runtime: (sessionId: string) => RuntimeState,
    private readonly canAccessProfile: (user: AuthenticatedUser, profile: string) => boolean) {
    this.unsubscribe.push(onSessionHerdrLinkChanged(sessionId => this.publish(sessionId)))
    this.unsubscribe.push(onSessionListChanged(change => {
      for (const subscriber of this.subscribers) subscriber.socket.emit('sessions.list.changed', change)
      if (change.type === 'deleted') this.forget(change.sessionId)
      else this.publish(change.sessionId)
    }))
  }

  private forget(sessionId: string) {
    this.foreground.delete(sessionId); this.pending.delete(sessionId); this.interactions.delete(sessionId)
    const retry = this.retries.get(sessionId)
    if (retry) clearTimeout(retry)
    this.retries.delete(sessionId)
  }

  private allowed(user: AuthenticatedUser, session: SessionStateRecord) {
    if (session.id.startsWith('person-main-')) return String(user.id) === String(session.studio_user_id)
    return this.canAccessProfile(user, session.profile || 'default')
  }

  private states(user: AuthenticatedUser, sessionId?: string): SessionListState[] {
    return listSessionStateRecords(user.id, sessionId).filter(session => this.allowed(user, session)).map(session => {
      const runtime = this.runtime(session.id)
      const backgroundPending = this.pending.get(session.id) ?? runtime.backgroundPending
      // A live runtime always wins: a stale "finished" flag must never hide running work.
      const working = runtime.working || this.foreground.get(session.id) === true || backgroundPending > 0 || (runtime.collaborationPending || 0) > 0
      const blocked = (this.interactions.get(session.id)?.size || 0) > 0
      const herdr = getSessionHerdrLink(session.id)
      return { sessionId: session.id, profile: session.profile || 'default', working, blocked,
        backgroundPending, lastMessageId: session.lastMessageId, readMessageId: session.readMessageId,
        lastAttentionId: session.lastAttentionId, readAttentionId: session.readAttentionId,
        unread: !working && (session.lastMessageId > session.readMessageId || session.lastAttentionId > session.readAttentionId),
        ...(herdr ? { herdr } : {}) }
    })
  }

  attach(socket: Socket) {
    if (socket.data.sessionShare || socket.handshake.query?.session_state !== '1') return
    // Chat auth accepts an anonymous connection only when login is disabled.
    // Keep that installation's ordinary chats in a separate local read scope.
    const user = (socket.data.user as AuthenticatedUser | undefined)
      ?? { id: 0, username: 'local', role: 'super_admin' as const }
    const subscriber = { socket, user }
    this.subscribers.add(subscriber)
    socket.on('disconnect', () => this.subscribers.delete(subscriber))
    socket.on('sessions.state.request', () => this.send(subscriber))
    socket.on('sessions.read', (data: { sessionId?: unknown; messageId?: unknown; attentionId?: unknown }, ack?: (result: { ok: boolean }) => void) => {
      try {
        if (typeof data?.sessionId !== 'string' || !Number.isSafeInteger(data.messageId) || Number(data.messageId) < 0) throw new Error('Invalid read cursor')
        if (data.attentionId != null && (!Number.isSafeInteger(data.attentionId) || Number(data.attentionId) < 0)) throw new Error('Invalid attention cursor')
        const session = listSessionStateRecords(user.id, data.sessionId)[0]
        if (!session || !this.allowed(user, session)) throw new Error('Session not found')
        if (this.states(user, session.id)[0]?.working) throw new Error('Reply is still running')
        markSessionRead(user.id, session.id, Number(data.messageId), Number(data.attentionId || 0))
        this.publish(session.id, user.id)
        if (typeof ack === 'function') ack({ ok: true })
      } catch {
        if (typeof ack === 'function') ack({ ok: false })
      }
    })
    this.send(subscriber)
  }

  /** Returns false when the session row is not visible (yet). */
  private send(subscriber: Subscriber, sessionId?: string): boolean {
    try {
      const sessions = this.states(subscriber.user, sessionId)
      if (!sessionId) subscriber.socket.emit('sessions.state.snapshot', { sessions })
      else {
        const state = sessions.find(state => state.sessionId === sessionId)
        if (!state) return false
        subscriber.socket.emit('sessions.state.updated', state)
      }
      return true
    } catch (error) {
      logger.warn(error, '[session-state] snapshot unavailable')
      return true
    }
  }

  publish(sessionId?: string, userId?: number) {
    let missing = false
    for (const subscriber of this.subscribers) {
      if (userId == null || subscriber.user.id === userId) missing = !this.send(subscriber, sessionId) || missing
    }
    // A run can start before its session row is written; retry briefly so the
    // first status change is not lost until the next event.
    if (missing && sessionId && userId == null) this.retry(sessionId)
  }

  private retry(sessionId: string, attempt = 0) {
    if (this.retries.has(sessionId) || attempt > 4) return
    this.retries.set(sessionId, setTimeout(() => {
      this.retries.delete(sessionId)
      let missing = false
      for (const subscriber of this.subscribers) missing = !this.send(subscriber, sessionId) || missing
      if (missing) this.retry(sessionId, attempt + 1)
    }, 150 * (attempt + 1)))
  }

  observe(event: string, payload: Record<string, any>) {
    const id = payload?.session_id
    if (typeof id !== 'string' || id.startsWith('person-task-') || payload.replayed || payload.restored || payload.background_snapshot) return
    const started = event === 'run.started' || (event === 'session.command' && payload.started === true && !payload.terminal)
    const terminal = ['run.completed', 'run.failed', 'abort.completed'].includes(event) || (event === 'session.command' && payload.terminal === true)
    const interaction = event === 'approval.requested' || event === 'clarify.requested'
    const resolved = event === 'approval.resolved' || event === 'clarify.resolved'
    if (interaction || resolved) {
      const key = String(payload.approval_id ?? payload.clarify_id ?? payload.request_id ?? event)
      const open = this.interactions.get(id) ?? new Set<string>()
      if (interaction) open.add(key)
      else if (open.has(key)) open.delete(key)
      else open.clear()
      if (open.size) this.interactions.set(id, open)
      else this.interactions.delete(id)
    }
    if (started) this.foreground.set(id, true)
    if (terminal) {
      this.interactions.delete(id)
      if (Number(payload.queue_remaining || payload.queue_length || 0) > 0) this.foreground.set(id, true)
      else this.foreground.delete(id)
    }
    if (event === 'run.queued') {
      if (this.runtime(id).working || Number(payload.queue_length || 0) > 0) this.foreground.set(id, true)
      else this.foreground.delete(id)
    }
    if (Number.isSafeInteger(payload.background_pending) && payload.background_pending >= 0) this.pending.set(id, payload.background_pending)
    if (started || terminal || interaction || resolved || event === 'run.queued' || event === 'session.command' || event === 'message.interim'
      || event === 'delegation.updated' || event === 'subagent.start' || event === 'subagent.complete') {
      if (payload.background_pending == null) this.pending.delete(id)
      this.publish(id)
    }
  }

  refreshPerson(userId: number) {
    // Person task receipts can change without a foreground run or a transcript subscriber.
    for (const id of this.pending.keys()) if (id.startsWith('person-main-')) this.pending.delete(id)
    this.publish(undefined, userId)
  }

  close() {
    for (const stop of this.unsubscribe.splice(0)) stop()
    for (const retry of this.retries.values()) clearTimeout(retry)
    this.retries.clear(); this.interactions.clear()
    this.subscribers.clear(); this.foreground.clear(); this.pending.clear()
  }
}
