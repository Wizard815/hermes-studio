import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import {
  DEFAULT_APPROVAL_ALERT_PREFS, looksDangerous, routeIncludes,
  type ApprovalAlertItem, type ApprovalAlertKind, type ApprovalAlertPrefs, type ApprovalDevice,
} from '../../../../../../shared/approval-alerts'
import type { WatcherEvent } from '../../../../../../shared/watcher'
import type { WatcherEventInput } from '../watcher/store'
import {
  ApprovalAlertsError, PAIRING_TTL_MS, cleanDeviceName, newPairingCode, normalizePairingCode,
  type ApprovalAlertsFile, type PhoneKeyRecord,
} from './settings'

/**
 * Where approvals reach you (docs/approval-alerts.md). One list of the
 * questions Studio is waiting on (Agent work, chat approvals, phone tool
 * questions) plus recent Blocked alerts, sent to each person where they chose:
 *
 * - **Mattermost**: Agent work keeps its own posts (Agent work decides them;
 *   this only says whether anyone wants them). Chat approvals and phone
 *   questions get a post with the same Approve / Reject buttons.
 * - **Android app**: a paired phone (Studio Own) holds a stream of the list
 *   and answers with its own key.
 *
 * Every answer, from anywhere, goes to the place that owns the question (Agent
 * work's `decide`, the chat's approval, the phone tools' `respond`); the first
 * answer wins and later ones get "Already approved in Studio".
 */

export type Decision = 'approve' | 'reject'
type Via = 'studio' | 'mattermost' | 'phone' | 'gone'

export interface AlertUser { id: number; username: string; role: string; status: string }

export interface WorkSource {
  pending(): Array<{ id: string; title: string; summary: string; agent: string; sessionId: string; createdAt: number; updatedAt: number }>
  decide(id: string, decision: Decision, via: 'phone' | 'mattermost', by: string): Promise<{ changed: boolean; message: string }>
}

export interface PhoneSource {
  pending(): Array<{ id: string; at: number; device: string; action: string; summary: string; reason: string; agent: string; sessionId: string }>
  respond(id: string, allowed: boolean): boolean
}

export interface ApprovalAlertsDeps {
  file: ApprovalAlertsFile
  user(id: number): AlertUser | null
  /** Active super admins: whoever never picked counts as the default (Agent work to Mattermost). */
  superAdmins(): AlertUser[]
  work(): WorkSource | null
  phone(): PhoneSource | null
  /** Answer a chat's own approval (`once` or `deny`), as the chat's Approve button does. */
  answerChat(sessionId: string, approvalId: string, choice: 'once' | 'deny'): Promise<boolean>
  sessionTitle(sessionId: string): string
  /** Agent work's Mattermost channel. Null when no channel is set. */
  mattermost: {
    post(input: { tags: string[]; title: string; text: string; alertId: string; token: string }): Promise<{ id: string } | null>
    resolve(postId: string, message: string): Promise<void>
  } | null
  /** The watcher's feed ("Approved on phone (Pixel 8): …"). */
  record(input: WatcherEventInput): void
  onError?(what: string, error: unknown): void
  now?(): number
}

interface ChatQuestion { itemId: string; sessionId: string; approvalId: string; agent: string; text: string; title: string; at: number; dangerous: boolean }
interface Answered { verdict: 'approved' | 'rejected' | 'gone'; via: Via; by: string; at: number }
interface Subscriber { userId: number; deviceId: string; send(event: string, data: unknown): void; last: string }

const AGENT_LABELS: Record<string, string> = {
  bridge: 'Hermes', hermes: 'Hermes', ekko: 'Ekko', 'claude-code': 'Claude Code', codex: 'Codex', pi: 'Pi', grok: 'Grok', opencode: 'OpenCode',
  cursor: 'Cursor', antigravity: 'Antigravity', qwen: 'Qwen Code', kimi: 'Kimi Code', copilot: 'Copilot',
}
const RECENT_ALERTS = 20
const ALERT_KEEP_MS = 60 * 60_000
const ANSWERED_KEEP = 500
const CHAT_QUESTION_MAX_AGE_MS = 6 * 3600_000
const MAX_PAIRING_FAILURES = 20

function text(value: unknown, max = 300): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : ''
}

function place(via: Via, by: string): string {
  if (via === 'phone') return `on phone${by ? ` (${by})` : ''}`
  if (via === 'gone') return ''
  return `in ${via === 'mattermost' ? 'Mattermost' : 'Studio'}${by ? ` by ${by}` : ''}`
}

export class ApprovalAlertsService {
  private chat = new Map<string, ChatQuestion>()
  private chatByApproval = new Map<string, string>()
  private answered = new Map<string, Answered>()
  /** Answers started here (phone, Mattermost): the chat's own "resolved" event must not say Studio. */
  private answering = new Map<string, { via: Via; by: string }>()
  private alerts: ApprovalAlertItem[] = []
  private posts = new Map<string, { postId: string; token: string; title: string }>()
  private knownPhone = new Set<string>()
  private subscribers = new Set<Subscriber>()
  private pairing = new Map<string, { userId: number; name: string; expiresAt: number }>()
  private pairingFailures: number[] = []
  private flushTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly deps: ApprovalAlertsDeps) {}

  private now() { return this.deps.now?.() ?? Date.now() }
  private fail(what: string, error: unknown) { this.deps.onError?.(what, error) }

  // --- who wants what -------------------------------------------------------

  prefs(userId: number): ApprovalAlertPrefs {
    return this.deps.file.savedPrefs(userId) || structuredClone(DEFAULT_APPROVAL_ALERT_PREFS)
  }

  savePrefs(userId: number, input: unknown): ApprovalAlertPrefs {
    const prefs = this.deps.file.savePrefs(userId, input, this.prefs(userId))
    this.changed()
    return prefs
  }

  /** Mattermost gets a kind when at least one super admin's choice (or the default) sends it there. */
  mattermostWants(kind: ApprovalAlertKind): boolean {
    const admins = safe(() => this.deps.superAdmins(), [] as AlertUser[])
    const choices = admins.length
      ? admins.map(user => this.prefs(user.id))
      : this.deps.file.allSaved().map(entry => entry.prefs)
    if (!choices.length) return DEFAULT_APPROVAL_ALERT_PREFS.kinds[kind]
    return choices.some(prefs => routeIncludes(prefs.route, 'mattermost') && prefs.kinds[kind])
  }

  private activeAdmin(userId: number): AlertUser | null {
    const user = safe(() => this.deps.user(userId), null)
    return user && user.status === 'active' && user.role === 'super_admin' ? user : null
  }

  // --- the list ---------------------------------------------------------------

  /** Everything waiting, before anyone's choice is applied. */
  items(): ApprovalAlertItem[] {
    const items: ApprovalAlertItem[] = []
    for (const work of safe(() => this.deps.work()?.pending() || [], [])) {
      items.push({
        id: `work-${work.id}`, kind: 'work',
        title: 'Agent work waits for your approval',
        detail: `${work.title}${work.summary ? ` — ${work.summary.slice(0, 240)}` : ''}`,
        at: work.updatedAt || work.createdAt, sessionId: work.sessionId || '',
        link: '/hermes/connections?tab=agent-work', dangerous: looksDangerous(`${work.title} ${work.summary}`), answerable: true,
      })
    }
    const cutoff = this.now() - CHAT_QUESTION_MAX_AGE_MS
    for (const question of [...this.chat.values()]) {
      if (question.at < cutoff) { this.dropChat(question, 'gone'); continue }
      items.push({
        id: question.itemId, kind: 'chat', title: question.title, detail: question.text, at: question.at,
        sessionId: question.sessionId, link: `/hermes/session/${encodeURIComponent(question.sessionId)}`,
        dangerous: question.dangerous, answerable: true,
      })
    }
    for (const ask of safe(() => this.deps.phone()?.pending() || [], [])) {
      const risky = ['shell', 'install', 'uninstall', 'push'].includes(ask.action) || !!ask.reason
      items.push({
        id: `phone-${ask.id}`, kind: 'phone',
        title: `${AGENT_LABELS[ask.agent] || ask.agent || 'An agent'} wants to use ${ask.device}`,
        detail: `${ask.summary}${ask.reason ? ` (${ask.reason})` : ''}`,
        at: ask.at, sessionId: ask.sessionId || '', link: '/android', dangerous: risky || looksDangerous(ask.summary), answerable: true,
      })
    }
    const since = this.now() - ALERT_KEEP_MS
    this.alerts = this.alerts.filter(alert => alert.at >= since)
    items.push(...this.alerts)
    return items.sort((a, b) => b.at - a.at)
  }

  /** What one person's phone gets: nothing unless they chose the Android app (or both). */
  forUser(userId: number): ApprovalAlertItem[] {
    if (!this.activeAdmin(userId)) return []
    const prefs = this.prefs(userId)
    if (!routeIncludes(prefs.route, 'android')) return []
    return this.items().filter(item => prefs.kinds[item.kind])
  }

  // --- sources ----------------------------------------------------------------

  /** The chat-run event stream (every chat type): approvals asked and answered, runs ending. */
  observeChat(sessionId: string, event: string, payload: Record<string, any> | undefined, agent = ''): void {
    if (!sessionId) return
    if (event === 'run.completed' || event === 'run.failed') {
      for (const question of [...this.chat.values()]) if (question.sessionId === sessionId) this.dropChat(question, 'gone')
      return
    }
    const approvalId = text(payload?.approval_id, 200)
    if (!approvalId) return
    const key = `${sessionId}\u0000${approvalId}`
    if (event === 'approval.requested') {
      if (this.chatByApproval.has(key)) return
      const who = AGENT_LABELS[agent] || AGENT_LABELS[text(payload?.source, 40)] || 'The agent'
      const command = text(payload?.command, 500)
      const what = command || text(payload?.title, 300) || text(payload?.description, 300) || 'an action'
      const chatTitle = safe(() => this.deps.sessionTitle(sessionId), '')
      const question: ChatQuestion = {
        itemId: `chat-${randomUUID()}`, sessionId, approvalId, agent,
        title: `${who} asks ${command ? 'to run a command' : 'for approval'}${chatTitle ? ` in ${chatTitle.slice(0, 60)}` : ''}`,
        text: what, at: this.now(), dangerous: looksDangerous(`${what} ${text(payload?.description, 300)}`) || payload?.dangerous === true,
      }
      this.chat.set(question.itemId, question)
      this.chatByApproval.set(key, question.itemId)
      void this.postQuestion(question.itemId, 'chat', question.title, question.text)
      this.changed()
      return
    }
    if (event !== 'approval.resolved' || payload?.resolved === false) return
    const itemId = this.chatByApproval.get(key)
    const question = itemId ? this.chat.get(itemId) : undefined
    if (!question) return
    const choice = String(payload?.choice || 'deny').toLowerCase()
    const started = this.answering.get(question.itemId)
    this.dropChat(question, choice === 'deny' ? 'rejected' : 'approved', started?.via || 'studio', started?.by || '')
  }

  private dropChat(question: ChatQuestion, verdict: Answered['verdict'], via: Via = 'gone', by = ''): void {
    this.chat.delete(question.itemId)
    this.chatByApproval.delete(`${question.sessionId}\u0000${question.approvalId}`)
    this.settle(question.itemId, question.title, verdict, via, by)
  }

  /** The phone tools' live events (Android page): a question asked or answered. */
  observePhone(event: string, payload: any): void {
    if (event === 'agent.approval' && payload?.id) {
      const id = `phone-${String(payload.id)}`
      if (this.knownPhone.has(id)) return
      this.knownPhone.add(id)
      const title = `${AGENT_LABELS[payload.agent] || payload.agent || 'An agent'} wants to use ${payload.device || 'a phone'}`
      void this.postQuestion(id, 'phone', title, `${payload.summary || ''}${payload.reason ? ` (${payload.reason})` : ''}`)
      this.changed()
    } else if (event === 'agent.approval.resolved' && payload?.id) {
      const id = `phone-${String(payload.id)}`
      this.knownPhone.delete(id)
      const started = this.answering.get(id)
      const title = this.posts.get(id)?.title || 'A phone action'
      // A question nobody answered in time is denied by the phone tools: it is just no longer waiting.
      if (payload.timedOut && !started) this.settle(id, title, 'gone', 'gone', '')
      else this.settle(id, title, payload.allowed ? 'approved' : 'rejected', started?.via || 'studio', started?.by || '')
    }
  }

  /** Agent work changed (asked, answered, dropped): phones get the new list. */
  workChanged(): void { this.changed() }

  /** A watcher Blocked alert. Kept an hour for phones that want Blocked alerts; never answered. */
  observeBlocked(event: WatcherEvent, title: string): void {
    if (event.severity !== 'block' || event.kind === 'approval_denied' || event.kind === 'approval_remote') return
    this.alerts = [{
      id: `alert-${event.id || randomUUID()}`, kind: 'blocked' as const,
      title: title ? `Blocked: ${title.slice(0, 80)}` : 'Blocked in Studio',
      detail: event.text.slice(0, 400), at: event.time || this.now(), sessionId: event.sessionId || '',
      link: event.link || '/hermes/chat', dangerous: false, answerable: false,
    }, ...this.alerts].slice(0, RECENT_ALERTS)
    this.changed()
  }

  /** A test notification from Settings → Android app. */
  sendTest(userId: number): ApprovalAlertItem {
    const item: ApprovalAlertItem = {
      id: `alert-test-${randomUUID()}`, kind: 'blocked', title: 'Test from Studio', detail: 'Approval alerts reach this phone.',
      at: this.now(), sessionId: '', link: '/hermes/config/settings?tab=android-app', dangerous: false, answerable: false,
    }
    for (const sub of this.subscribers) if (sub.userId === userId) sub.send('test', item)
    return item
  }

  // --- answers ----------------------------------------------------------------

  private settle(itemId: string, title: string, verdict: Answered['verdict'], via: Via, by: string): void {
    this.answering.delete(itemId)
    this.answered.set(itemId, { verdict, via, by, at: this.now() })
    if (this.answered.size > ANSWERED_KEEP) this.answered.delete(this.answered.keys().next().value as string)
    const post = this.posts.get(itemId)
    if (post && this.deps.mattermost) {
      this.posts.delete(itemId)
      const message = verdict === 'gone'
        ? `~~#approval~~ **${post.title}** is no longer waiting.`
        : `#${verdict} ~~#approval~~ **${post.title}** was ${verdict} ${place(via, by)}.`
      void this.deps.mattermost.resolve(post.postId, message).catch(error => this.fail('mattermost', error))
    }
    this.changed()
  }

  private alreadyText(itemId: string): string {
    const done = this.answered.get(itemId)
    if (!done || done.verdict === 'gone') return 'This is no longer waiting for an answer.'
    return `Already ${done.verdict} ${place(done.via, done.by)}.`
  }

  /**
   * Answer one question from the phone or a Mattermost button. The first
   * answer wins: a second one changes nothing and says where it was answered.
   */
  async answer(itemId: string, decision: Decision, from: { via: 'phone' | 'mattermost'; by: string }): Promise<{ changed: boolean; message: string }> {
    const verdict = decision === 'approve' ? 'approved' : 'rejected'
    const detail = (this.items().find(item => item.id === itemId)?.detail || this.lastDetail.get(itemId) || '').slice(0, 200)
    if (itemId.startsWith('alert-')) throw new ApprovalAlertsError('A Blocked alert has nothing to answer. Open Studio to see it.')
    let result: { changed: boolean; message: string }
    if (itemId.startsWith('work-')) {
      const work = this.deps.work()
      if (!work) throw new ApprovalAlertsError('Agent work is not running', 503)
      try {
        const decided = await work.decide(itemId.slice(5), decision, from.via, from.by)
        result = { changed: decided.changed, message: decided.message }
      } catch (error) {
        if ((error as { status?: number })?.status === 404) throw new ApprovalAlertsError('No such approval', 404)
        throw error
      }
    } else if (itemId.startsWith('chat-')) {
      const question = this.chat.get(itemId)
      if (!question) return this.notWaiting(itemId)
      if (this.answering.has(itemId)) return { changed: false, message: 'Someone is answering this right now.' }
      this.answering.set(itemId, { via: from.via, by: from.by })
      let ok = false
      try { ok = await this.deps.answerChat(question.sessionId, question.approvalId, decision === 'approve' ? 'once' : 'deny') }
      catch (error) { this.fail('chat answer', error) }
      if (!ok) {
        this.answering.delete(itemId)
        // Answered elsewhere in the meantime, or the run is gone.
        if (this.chat.has(itemId)) this.dropChat(question, 'gone')
        return this.notWaiting(itemId)
      }
      if (this.chat.has(itemId)) this.dropChat(question, verdict, from.via, from.by)
      result = { changed: true, message: `${verdict === 'approved' ? 'Approved' : 'Rejected'}.` }
    } else if (itemId.startsWith('phone-')) {
      const phone = this.deps.phone()
      const ask = phone?.pending().find(item => `phone-${item.id}` === itemId)
      if (!phone || !ask) return this.notWaiting(itemId)
      this.answering.set(itemId, { via: from.via, by: from.by })
      if (!phone.respond(ask.id, decision === 'approve')) { this.answering.delete(itemId); return this.notWaiting(itemId) }
      // respond() fires agent.approval.resolved, which settles it with this place.
      if (!this.answered.has(itemId)) this.settle(itemId, `${ask.agent} on ${ask.device}`, verdict, from.via, from.by)
      result = { changed: true, message: `${verdict === 'approved' ? 'Approved' : 'Rejected'}.` }
    } else {
      throw new ApprovalAlertsError('No such approval', 404)
    }
    if (result.changed) {
      this.deps.record({
        kind: 'approval_remote', severity: 'info',
        text: `${verdict === 'approved' ? 'Approved' : 'Rejected'} ${place(from.via, from.by)}${detail ? `: ${detail}` : ''}`.slice(0, 600),
        link: itemId.startsWith('phone-') ? '/android' : itemId.startsWith('work-') ? '/hermes/connections?tab=agent-work' : undefined,
      })
    }
    this.changed()
    return result
  }

  private lastDetail = new Map<string, string>()

  private notWaiting(itemId: string): { changed: false; message: string } {
    return { changed: false, message: this.alreadyText(itemId) }
  }

  /** What a phone may answer: only what its owner's list shows. */
  async answerFromPhone(device: PhoneKeyRecord, itemId: string, decision: Decision) {
    const user = this.activeAdmin(device.userId)
    if (!user) throw new ApprovalAlertsError("The phone's owner is not a Studio super admin any more.", 403)
    const prefs = this.prefs(user.id)
    if (!routeIncludes(prefs.route, 'android')) throw new ApprovalAlertsError('Approval alerts for the Android app are off in Studio: Settings → Watcher → Where approvals reach you.', 403)
    const kind = itemId.startsWith('work-') ? 'work' : itemId.startsWith('chat-') ? 'chat' : itemId.startsWith('phone-') ? 'phone' : null
    if (kind && !prefs.kinds[kind]) throw new ApprovalAlertsError('This kind of approval is not sent to your phone. Answer it in Studio.', 403)
    return this.answer(itemId, decision, { via: 'phone', by: device.name })
  }

  /** A Mattermost button on a chat approval or phone question post. */
  async answerFromMattermost(input: { alertId: string; token: string; decision: Decision; by: string }): Promise<{ message: string; resolved: string }> {
    const post = this.posts.get(input.alertId)
    if (!post) {
      const message = this.alreadyText(input.alertId)
      return { message, resolved: message }
    }
    if (input.token.length !== post.token.length || !timingSafeEqual(Buffer.from(input.token), Buffer.from(post.token))) {
      throw new ApprovalAlertsError('This button is not valid any more', 403)
    }
    const result = await this.answer(input.alertId, input.decision, { via: 'mattermost', by: input.by })
    const done = this.answered.get(input.alertId)
    const resolved = done && done.verdict !== 'gone'
      ? `#${done.verdict} ~~#approval~~ **${post.title}** was ${done.verdict} ${place(done.via, done.by)}.`
      : `~~#approval~~ **${post.title}** is no longer waiting.`
    return { message: result.message, resolved }
  }

  private async postQuestion(itemId: string, kind: 'chat' | 'phone', title: string, detail: string): Promise<void> {
    this.lastDetail.set(itemId, detail.slice(0, 200))
    if (this.lastDetail.size > ANSWERED_KEEP) this.lastDetail.delete(this.lastDetail.keys().next().value as string)
    if (!this.deps.mattermost || !this.mattermostWants(kind)) return
    const token = randomBytes(24).toString('base64url')
    try {
      const post = await this.deps.mattermost.post({ tags: ['approval', kind === 'chat' ? 'chatapproval' : 'phone'], title, text: detail, alertId: itemId, token })
      if (!post) return
      // Answered while the post was being made: close it at once.
      if (this.answered.has(itemId)) {
        const done = this.answered.get(itemId)!
        await this.deps.mattermost.resolve(post.id, `~~#approval~~ **${title}** was ${done.verdict === 'gone' ? 'no longer waiting' : `${done.verdict} ${place(done.via, done.by)}`}.`)
        return
      }
      this.posts.set(itemId, { postId: post.id, token, title })
    } catch (error) { this.fail('mattermost', error) }
  }

  // --- phones -----------------------------------------------------------------

  startPairing(userId: number, name: unknown): { code: string; expiresAt: number } {
    const now = this.now()
    for (const [code, entry] of this.pairing) if (entry.expiresAt <= now || entry.userId === userId) this.pairing.delete(code)
    const code = newPairingCode()
    const expiresAt = now + PAIRING_TTL_MS
    this.pairing.set(code, { userId, name: cleanDeviceName(name), expiresAt })
    return { code, expiresAt }
  }

  /** The phone trades a pairing code (once, within ten minutes) for its own key. */
  pair(rawCode: unknown, name: unknown): { key: string; device: ApprovalDevice; username: string } {
    const now = this.now()
    this.pairingFailures = this.pairingFailures.filter(at => now - at < PAIRING_TTL_MS)
    if (this.pairingFailures.length >= MAX_PAIRING_FAILURES) throw new ApprovalAlertsError('Too many wrong codes. Wait ten minutes, then make a new code in Studio.', 429)
    const code = normalizePairingCode(rawCode)
    const entry = code ? this.pairing.get(code) : undefined
    if (!entry || entry.expiresAt <= now) {
      this.pairingFailures.push(now)
      if (entry) this.pairing.delete(code)
      throw new ApprovalAlertsError('This code is wrong or has expired. Make a new one in Studio: Settings → Android app → Pair this phone.', 401)
    }
    this.pairing.delete(code)
    const user = this.activeAdmin(entry.userId)
    if (!user) throw new ApprovalAlertsError("The code's owner is not a Studio super admin any more.", 403)
    const deviceName = String(name ?? '').trim() ? cleanDeviceName(name) : entry.name
    const { device, key } = this.deps.file.createDevice(user.id, deviceName, now)
    return { key, device: this.publicDevice(device), username: user.username }
  }

  devices(userId: number): ApprovalDevice[] {
    return this.deps.file.devices(userId).map(device => this.publicDevice(device))
  }

  private publicDevice(device: PhoneKeyRecord): ApprovalDevice {
    const { hash: _hash, ...rest } = device
    return { ...rest, connected: [...this.subscribers].some(sub => sub.deviceId === device.id) }
  }

  /** Revoke a phone: its key stops working at once and its open stream closes. */
  removeDevice(userId: number, id: string): void {
    if (!this.deps.file.removeDevice(id, userId)) throw new ApprovalAlertsError('No such phone', 404)
    for (const sub of [...this.subscribers]) if (sub.deviceId === id) { sub.send('revoked', {}); this.subscribers.delete(sub) }
  }

  /** The phone's key, from the Authorization header only. */
  authenticate(token: string): PhoneKeyRecord | null {
    const device = this.deps.file.findDevice(token)
    if (device) this.deps.file.touchDevice(device.id, this.now())
    return device
  }

  /** The phone a request signed in as (the auth middleware checked its key). */
  device(id: string | undefined): PhoneKeyRecord {
    const device = id ? this.deps.file.devices().find(item => item.id === id) : undefined
    if (!device) throw new ApprovalAlertsError('This phone is not paired any more. Pair it again in Studio: Settings → Android app.', 401)
    return device
  }

  deviceStatus(device: PhoneKeyRecord) {
    const user = this.activeAdmin(device.userId)
    const prefs = this.prefs(device.userId)
    return {
      device: this.publicDevice(device),
      username: user?.username || '',
      android: !!user && routeIncludes(prefs.route, 'android'),
      kinds: prefs.kinds,
    }
  }

  /** A phone's live stream: the whole list now, and again each time it changes. Returns the unsubscribe. */
  subscribe(device: PhoneKeyRecord, send: (event: string, data: unknown) => void): () => void {
    const sub: Subscriber = { userId: device.userId, deviceId: device.id, send, last: '' }
    this.subscribers.add(sub)
    this.push(sub)
    return () => { this.subscribers.delete(sub) }
  }

  connectedDevices(): number { return this.subscribers.size }

  private push(sub: Subscriber): void {
    const items = this.forUser(sub.userId)
    const body = JSON.stringify(items)
    if (body === sub.last) return
    sub.last = body
    try { sub.send('approvals', { items }) } catch (error) { this.fail('stream', error) }
  }

  /** Something changed: every open stream gets its new list (once, a moment later). */
  changed(): void {
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      for (const sub of [...this.subscribers]) this.push(sub)
    }, 25)
    this.flushTimer.unref?.()
  }

  /** For tests: push now. */
  flush(): void {
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null }
    for (const sub of [...this.subscribers]) this.push(sub)
  }

  close(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = null
    for (const sub of [...this.subscribers]) { try { sub.send('bye', {}) } catch { /* closing */ } }
    this.subscribers.clear()
  }
}

function safe<T>(fn: () => T, fallback: T): T {
  try { return fn() } catch { return fallback }
}
