import { timingSafeEqual } from 'node:crypto'
import { AGENT_WORK_STATUSES, DECISION_VIAS, type AgentActivity, type AgentWork, type AgentWorkStatus, type AgentWorkStore, type DecisionVia, type MattermostPostRef } from './store'
import { parseMentions, type AgentWorkPublicSettings, type AgentWorkSettings } from './settings'
import { approvalButtons, approvalProps, composeResolvedMessage, composeStatusMessage, decidedPlace, decisionFromReactions, mentionsFor, type MattermostPort } from './mattermost'
import type { OrbSharePort } from './orb-share'
import type { AllGlancePort } from './allglance'
import { buildDigest, dayBounds, localDay, type WikiPort } from './wiki'

/**
 * Agent work: one row per piece of work an agent does on a Vikunja task, its
 * append-only activity log, and its approval. Every change fans out to the
 * Mattermost channel set in Connections → Agent work, to Pondering Orb (only
 * when sharing is on) and to the wiki's daily digest. A decision made in any
 * one place (Studio, Mattermost, Orb or Omi) is final: the first one wins, the
 * others become no-ops, every place stops alerting, and an approved item that
 * links a Vikunja task marks that task done through ALLGlance.
 */

export class AgentWorkError extends Error {
  constructor(message: string, readonly status = 400) { super(message) }
}

export interface SettingsPort {
  load(): Promise<AgentWorkSettings>
  save(next: AgentWorkSettings): Promise<AgentWorkPublicSettings>
  publicSettings(): Promise<AgentWorkPublicSettings>
}

export interface AgentWorkDeps {
  store: AgentWorkStore
  settings: SettingsPort
  mattermost: MattermostPort
  /** What "Set up Mattermost" recorded: its team and the user it set up for. */
  setupRecord: () => { teamId: string; userId: string } | null
  orb: OrbSharePort
  allglance: AllGlancePort
  wiki: WikiPort
  onError?: (what: string, error: unknown) => void
  /** Every change, for the watcher's feed (docs/watcher.md). */
  observe?: (work: AgentWork, change: 'created' | 'status' | 'decided') => void
  /**
   * Whether approval requests are posted to Mattermost (with their buttons).
   * Settings → Watcher → "Where approvals reach you" (docs/approval-alerts.md);
   * missing: always, as before.
   */
  approvalPostWanted?: () => boolean
  now?: () => number
}

export interface DecisionResult { work: AgentWork; changed: boolean; message: string }

const STATUS_WORDS: Record<AgentWorkStatus, string> = {
  queued: 'queued', working: 'working', blocked: 'blocked', awaiting_approval: 'awaiting approval', done: 'done', rejected: 'rejected',
}
const VIA_WORDS: Record<string, string> = { studio: 'Studio', mattermost: 'Mattermost', orb: 'Pondering Orb', omi: 'Omi', phone: 'phone' }

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isStatus(value: unknown): value is AgentWorkStatus {
  return (AGENT_WORK_STATUSES as readonly string[]).includes(String(value))
}

export class AgentWorkService {
  private digestTimer: ReturnType<typeof setTimeout> | null = null
  private userIdCache = new Map<string, string>()

  constructor(private readonly deps: AgentWorkDeps) {}

  private now(): number { return this.deps.now?.() ?? Date.now() }
  private fail(what: string, error: unknown) { this.deps.onError?.(what, error) }
  private observe(work: AgentWork, change: 'created' | 'status' | 'decided') { try { this.deps.observe?.(work, change) } catch { /* the feed never breaks work */ } }

  get store(): AgentWorkStore { return this.deps.store }

  list(filter: { status?: string[]; limit?: number } = {}): AgentWork[] {
    return this.deps.store.list({ status: filter.status?.filter(isStatus), limit: filter.limit })
  }

  get(id: string): { work: AgentWork; activity: AgentActivity[] } {
    const work = this.deps.store.get(id)
    if (!work) throw new AgentWorkError('No such agent work', 404)
    return { work, activity: this.deps.store.activity({ workId: id }) }
  }

  summary() {
    const counts = this.deps.store.counts()
    return { counts, awaitingApproval: counts.awaiting_approval, blocked: counts.blocked }
  }

  /**
   * New work. Takes camelCase or the snake_case agents send (`vikunja_task_id`,
   * `session_id`). Work an agent reports from its chat (a run credential names
   * the chat) is linked to that chat when it names none.
   */
  async create(input: { title?: unknown; vikunjaTaskId?: unknown; vikunja_task_id?: unknown; agent?: unknown; sessionId?: unknown; session_id?: unknown; status?: unknown; summary?: unknown }, actor = '', from: { sessionId?: string; agentId?: string } = {}): Promise<AgentWork> {
    const title = String(input.title ?? '').trim().slice(0, 300)
    if (!title) throw new AgentWorkError('Give the work a title')
    const vikunjaTaskId = String(input.vikunjaTaskId ?? input.vikunja_task_id ?? '').trim()
    const sessionId = String(input.sessionId ?? input.session_id ?? '').trim() || String(from.sessionId || '').trim()
    const agent = String(input.agent ?? '').trim() || (from.agentId === 'ekko-agent' ? 'ekko' : String(from.agentId || '').trim())
    if (vikunjaTaskId && !/^[A-Za-z0-9_-]{1,64}$/.test(vikunjaTaskId)) throw new AgentWorkError('vikunjaTaskId must be the Vikunja task id')
    const status = input.status === undefined ? 'queued' : String(input.status)
    if (!isStatus(status) || status === 'done' || status === 'rejected') throw new AgentWorkError('New work starts queued, working, blocked or awaiting_approval')
    const work = this.deps.store.create({
      title, vikunjaTaskId, status,
      agent: agent.slice(0, 80),
      sessionId: sessionId.slice(0, 200),
      summary: String(input.summary ?? '').trim().slice(0, 4000),
    }, this.now())
    const entry = this.deps.store.log(work.id, { kind: 'created', status, actor, message: work.summary || title }, this.now())
    await this.fanOut(work, entry, { posted: status, approvalChanged: status === 'awaiting_approval' })
    this.observe(work, 'created')
    return work
  }

  /**
   * Remove work and its activity (a test record, a task created twice). The
   * Vikunja task is not touched; an approval button left in Mattermost then
   * answers that the work no longer exists.
   */
  remove(id: string): { removed: true; id: string } {
    if (!this.deps.store.delete(id)) throw new AgentWorkError('No such agent work', 404)
    return { removed: true, id }
  }

  async setStatus(id: string, input: { status?: unknown; summary?: unknown }, actor = ''): Promise<AgentWork> {
    const before = this.deps.store.get(id)
    if (!before) throw new AgentWorkError('No such agent work', 404)
    const status = String(input.status ?? '')
    if (!isStatus(status)) throw new AgentWorkError(`status must be one of ${AGENT_WORK_STATUSES.join(', ')}`)
    if (status === 'rejected') throw new AgentWorkError('Reject work with the reject action')
    if (before.decision) throw new AgentWorkError(`This work was already ${before.decision}`, 409)
    const summary = input.summary === undefined ? undefined : String(input.summary).trim().slice(0, 4000)
    if (before.status === status && (summary === undefined || summary === before.summary)) return before
    if (!this.deps.store.setStatus(id, status, summary, this.now())) throw new AgentWorkError(`This work was already decided`, 409)
    const work = this.deps.store.get(id)!
    const entry = this.deps.store.log(id, { kind: 'status', status, actor, message: summary || `${STATUS_WORDS[before.status]} → ${STATUS_WORDS[status]}` }, this.now())
    const statusChanged = before.status !== status
    await this.fanOut(work, entry, {
      posted: statusChanged ? status : null,
      approvalChanged: statusChanged && (status === 'awaiting_approval' || before.status === 'awaiting_approval'),
    })
    if (statusChanged) this.observe(work, 'status')
    return work
  }

  /** Approve or reject. The first decision wins; later ones from anywhere are no-ops. */
  async decide(id: string, decision: 'approve' | 'reject', via: DecisionVia, by = ''): Promise<DecisionResult> {
    if (!DECISION_VIAS.includes(via)) throw new AgentWorkError('Unknown place')
    const before = this.deps.store.get(id)
    if (!before) throw new AgentWorkError('No such agent work', 404)
    const verdict = decision === 'approve' ? 'approved' : 'rejected'
    const won = this.deps.store.decide(id, verdict, via, String(by).slice(0, 80), this.now())
    const work = this.deps.store.get(id)!
    if (!won) {
      if (work.decision) {
        return { work, changed: false, message: `Already ${work.decision} ${decidedPlace(work.decidedVia, work.decidedBy)}.` }
      }
      throw new AgentWorkError(`This work is ${STATUS_WORDS[work.status]}, not awaiting approval`, 409)
    }
    const entry = this.deps.store.log(id, { kind: verdict, status: work.status, actor: by, via, message: `${verdict} ${via === 'phone' ? decidedPlace(via, by) : `in ${VIA_WORDS[via]}`}` }, this.now())
    await this.fanOut(work, entry, { posted: null, approvalChanged: true })
    if (verdict === 'approved' && work.vikunjaTaskId) await this.completeVikunja(work)
    this.observe(this.deps.store.get(id)!, 'decided')
    return { work: this.deps.store.get(id)!, changed: true, message: `${verdict[0].toUpperCase()}${verdict.slice(1)}.` }
  }

  private async completeVikunja(work: AgentWork): Promise<void> {
    try {
      if (!(await this.deps.allglance.configured())) throw new Error('ALLGlance is not connected')
      await this.deps.allglance.completeTask(work.vikunjaTaskId)
      this.deps.store.setVikunjaResult(work.id, true, '', this.now())
      this.deps.store.log(work.id, { kind: 'vikunja_done', status: work.status, message: `Vikunja task #${work.vikunjaTaskId} marked done through ALLGlance` }, this.now())
    } catch (error) {
      const message = errorText(error)
      // Retries that fail the same way are logged once, not every five minutes.
      const repeated = this.deps.store.get(work.id)?.vikunjaError === message.slice(0, 500)
      this.deps.store.setVikunjaResult(work.id, false, message, this.now())
      if (!repeated) this.deps.store.log(work.id, { kind: 'vikunja_failed', status: work.status, message: `Vikunja task #${work.vikunjaTaskId} not marked done yet: ${message}` }, this.now())
      this.fail('vikunja', error)
    }
  }

  /** Approved work whose Vikunja task is not done yet (ALLGlance was down): try again. */
  async retryVikunja(): Promise<number> {
    let done = 0
    for (const work of this.deps.store.pendingVikunja()) {
      await this.completeVikunja(work)
      if (this.deps.store.get(work.id)?.vikunjaDoneAt) done++
    }
    return done
  }

  // --- fan-out -------------------------------------------------------------

  private async fanOut(work: AgentWork, entry: AgentActivity, change: { posted: AgentWorkStatus | null; approvalChanged: boolean }): Promise<void> {
    const settings = await this.deps.settings.load()
    if (change.posted) await this.postStatus(work, change.posted, settings)
    if (change.approvalChanged && work.status !== 'awaiting_approval') await this.resolvePosts(work, settings)
    if (settings.shareToOrb) await this.shareToOrb(work, entry, change.approvalChanged)
    this.scheduleDigest()
  }

  private async postStatus(work: AgentWork, status: AgentWorkStatus, settings: AgentWorkSettings): Promise<void> {
    const mm = settings.mattermost
    if (!mm.channel) return
    // Settings → Watcher → "Where approvals reach you": nobody wants approvals in Mattermost.
    if (status === 'awaiting_approval' && this.deps.approvalPostWanted && !safeWanted(this.deps.approvalPostWanted)) return
    try {
      const channelId = mm.channelId || (await this.deps.mattermost.findChannel(mm.channel, mm.teamId || this.deps.setupRecord()?.teamId))?.id
      if (!channelId) throw new Error(`Mattermost has no channel ~${mm.channel}`)
      const message = composeStatusMessage(work, status, mm)
      const props = status === 'awaiting_approval' ? approvalProps(work, this.deps.store.actionToken(work.id), mm.actionUrl) : undefined
      const post = await this.deps.mattermost.createPost(channelId, message, props)
      this.deps.store.setPosts(work.id, [...this.deps.store.posts(work.id), { id: post.id, channelId, kind: status }])
    } catch (error) {
      this.deps.store.log(work.id, { kind: 'mattermost_failed', status: work.status, message: errorText(error) }, this.now())
      this.fail('mattermost', error)
    }
  }

  /** Approval posts stop alerting: their buttons go and they say how it ended. */
  private async resolvePosts(work: AgentWork, _settings: AgentWorkSettings): Promise<void> {
    const posts = this.deps.store.posts(work.id)
    const open = posts.filter(p => p.kind === 'awaiting_approval' && !p.resolved)
    if (!open.length) return
    const message = work.decision ? composeResolvedMessage(work) : `#agentwork ~~#approval~~ **${work.title}** no longer needs approval (now ${STATUS_WORDS[work.status]}).`
    const next: MattermostPostRef[] = []
    for (const post of posts) {
      if (!open.includes(post)) { next.push(post); continue }
      try {
        await this.deps.mattermost.patchPost(post.id, message, { attachments: [] })
        next.push({ ...post, resolved: true })
      } catch (error) {
        next.push(post)
        this.deps.store.log(work.id, { kind: 'mattermost_failed', status: work.status, message: `Could not update the approval post: ${errorText(error)}` }, this.now())
        this.fail('mattermost', error)
      }
    }
    this.deps.store.setPosts(work.id, next)
  }

  private async shareToOrb(work: AgentWork, entry: AgentActivity, approvalChanged: boolean): Promise<void> {
    try {
      if (!(await this.deps.orb.connected())) return
      await this.deps.orb.activity(work, entry)
      if (approvalChanged) await this.deps.orb.approval(work)
    } catch (error) {
      // Logged without sharing it again (it is about the sharing).
      this.deps.store.log(work.id, { kind: 'orb_failed', status: work.status, message: errorText(error) }, this.now())
      this.fail('orb', error)
    }
  }

  /**
   * A one-off #blocked alert in Agent work's Mattermost channel (run limits use
   * it, docs/agent-limits.md), with the usual @mentions. False when no channel is set.
   */
  async alertBlocked(title: string, text: string): Promise<boolean> {
    const settings = await this.deps.settings.load()
    const mm = settings.mattermost
    if (!mm.channel) return false
    const channelId = mm.channelId || (await this.deps.mattermost.findChannel(mm.channel, mm.teamId || this.deps.setupRecord()?.teamId))?.id
    if (!channelId) throw new Error(`Mattermost has no channel ~${mm.channel}`)
    const mention = mentionsFor('blocked', mm)
    const quoted = text.trim().replace(/\n+/g, '\n> ')
    await this.deps.mattermost.createPost(channelId, `#agentlimit #blocked${mention ? ` ${mention}` : ''} **${title}** was stopped by a run limit and needs you\n> ${quoted}`)
    return true
  }

  /**
   * A watcher alert (docs/watcher.md) in Agent work's Mattermost channel, with
   * the @mentions it uses for blocked work. False when no channel is set.
   */
  async postAlert(tags: string[], title: string, text: string, mention = false): Promise<boolean> {
    const settings = await this.deps.settings.load()
    const mm = settings.mattermost
    if (!mm.channel) return false
    const channelId = mm.channelId || (await this.deps.mattermost.findChannel(mm.channel, mm.teamId || this.deps.setupRecord()?.teamId))?.id
    if (!channelId) throw new Error(`Mattermost has no channel ~${mm.channel}`)
    const mentions = mention ? mentionsFor('blocked', mm) : ''
    const hashtags = tags.map(tag => `#${tag.replace(/[^a-z0-9_]/gi, '')}`).filter(tag => tag.length > 1).join(' ')
    const quoted = text.trim().replace(/\n+/g, '\n> ')
    await this.deps.mattermost.createPost(channelId, `${hashtags}${mentions ? ` ${mentions}` : ''}${title ? ` **${title}**` : ''}\n> ${quoted}`)
    return true
  }

  /**
   * A chat approval or a phone question in Agent work's channel, with the same
   * Approve / Reject buttons as Agent work (docs/approval-alerts.md). The
   * buttons' `alert_id` and secret come back to `setAlertActionHandler`. Null
   * when no channel is set.
   */
  async postQuestion(input: { tags: string[]; title: string; text: string; alertId: string; token: string }): Promise<{ id: string; channelId: string } | null> {
    const settings = await this.deps.settings.load()
    const mm = settings.mattermost
    if (!mm.channel) return null
    const channelId = mm.channelId || (await this.deps.mattermost.findChannel(mm.channel, mm.teamId || this.deps.setupRecord()?.teamId))?.id
    if (!channelId) throw new Error(`Mattermost has no channel ~${mm.channel}`)
    const mention = mentionsFor('awaiting_approval', mm)
    const hashtags = input.tags.map(tag => `#${tag.replace(/[^a-z0-9_]/gi, '')}`).filter(tag => tag.length > 1).join(' ')
    const quoted = input.text.trim().replace(/\n+/g, '\n> ')
    const how = mm.actionUrl ? 'Approve or reject with the buttons, in Studio or on your phone.' : 'Answer it in Studio or on your phone.'
    const message = `${hashtags}${mention ? ` ${mention}` : ''} **${input.title}**\n> ${quoted}\n${how}`
    const post = await this.deps.mattermost.createPost(channelId, message, approvalButtons({ alert_id: input.alertId, token: input.token }, mm.actionUrl))
    return { id: post.id, channelId }
  }

  /** The question was answered somewhere: its post loses its buttons and says how it ended. */
  async resolveQuestion(postId: string, message: string): Promise<void> {
    await this.deps.mattermost.patchPost(postId, message, { attachments: [] })
  }

  private alertAction: ((input: { alertId: string; token: string; decision: 'approve' | 'reject'; by: string }) => Promise<{ message: string; resolved: string }>) | null = null

  /** Who answers the buttons of `postQuestion` posts (the approval alerts service). */
  setAlertActionHandler(handler: typeof this.alertAction): void {
    this.alertAction = handler
  }

  // --- Mattermost decisions --------------------------------------------------

  private async allowedDeciders(settings: AgentWorkSettings): Promise<Set<string> | null> {
    const ids = new Set<string>()
    const record = this.deps.setupRecord()
    if (record?.userId) ids.add(record.userId)
    const missing = settings.mattermost.mention.filter(name => !this.userIdCache.has(name))
    if (missing.length) {
      try { for (const [name, id] of Object.entries(await this.deps.mattermost.userIds(missing))) this.userIdCache.set(name, id) } catch { /* next time */ }
    }
    for (const name of settings.mattermost.mention) { const id = this.userIdCache.get(name); if (id) ids.add(id) }
    // Nobody named: anyone in the channel but the bot may decide.
    return ids.size ? ids : null
  }

  /** Approve / Reject button on an approval post (Mattermost calls this). */
  async mattermostAction(payload: any): Promise<{ update?: { message: string; props: Record<string, unknown> }; ephemeral_text: string }> {
    const context = payload?.context || {}
    if (context.alert_id) return this.alertButton(payload)
    const workId = String(context.work_id || '')
    const token = String(context.token || '')
    const decision = context.decision === 'reject' ? 'reject' : context.decision === 'approve' ? 'approve' : null
    const expected = workId ? this.deps.store.actionToken(workId) : ''
    if (!expected || !decision || token.length !== expected.length || !timingSafeEqual(Buffer.from(token), Buffer.from(expected))) {
      throw new AgentWorkError('This button is not valid any more', 403)
    }
    const settings = await this.deps.settings.load()
    const allowed = await this.allowedDeciders(settings)
    const userId = String(payload?.user_id || '')
    if (allowed && !allowed.has(userId)) return { ephemeral_text: 'You are not one of the people who can approve agent work.' }
    const by = String(payload?.user_name || '') || (await this.usernameFor(userId))
    const result = await this.decide(workId, decision, 'mattermost', by)
    return {
      update: { message: composeResolvedMessage(result.work), props: { attachments: [] } },
      ephemeral_text: result.message,
    }
  }

  /** A chat approval's or phone question's button: the same people may answer as for Agent work. */
  private async alertButton(payload: any): Promise<{ update?: { message: string; props: Record<string, unknown> }; ephemeral_text: string }> {
    const context = payload?.context || {}
    const decision = context.decision === 'reject' ? 'reject' : context.decision === 'approve' ? 'approve' : null
    if (!this.alertAction || !decision) throw new AgentWorkError('This button is not valid any more', 403)
    const settings = await this.deps.settings.load()
    const allowed = await this.allowedDeciders(settings)
    const userId = String(payload?.user_id || '')
    if (allowed && !allowed.has(userId)) return { ephemeral_text: 'You are not one of the people who can answer approvals.' }
    const by = String(payload?.user_name || '') || (await this.usernameFor(userId))
    const result = await this.alertAction({ alertId: String(context.alert_id), token: String(context.token || ''), decision, by })
    return { update: { message: result.resolved, props: { attachments: [] } }, ephemeral_text: result.message }
  }

  private async usernameFor(userId: string): Promise<string> {
    for (const [name, id] of this.userIdCache) if (id === userId) return name
    return userId ? `mattermost:${userId.slice(0, 8)}` : ''
  }

  /** ✅ / ❌ reactions on approval posts (works without Mattermost reaching Studio). */
  async pollMattermostReactions(): Promise<number> {
    const settings = await this.deps.settings.load()
    if (!settings.mattermost.channel) return 0
    const pending = this.deps.store.pendingApprovalPosts()
    if (!pending.length) return 0
    let decided = 0
    const botId = await this.deps.mattermost.botUserId()
    const allowed = await this.allowedDeciders(settings)
    for (const { work, posts } of pending) {
      for (const post of posts) {
        try {
          const found = decisionFromReactions(await this.deps.mattermost.reactions(post.id), botId, allowed)
          if (!found) continue
          const result = await this.decide(work.id, found.decision, 'mattermost', await this.usernameFor(found.userId))
          if (result.changed) decided++
          break
        } catch (error) { this.fail('mattermost reactions', error) }
      }
    }
    return decided
  }

  // --- digest ------------------------------------------------------------------

  private scheduleDigest(): void {
    if (this.digestTimer) clearTimeout(this.digestTimer)
    this.digestTimer = setTimeout(() => { this.digestTimer = null; void this.writeDigest().catch(error => this.fail('wiki', error)) }, 3000)
    this.digestTimer.unref?.()
  }

  digest(day = localDay(this.now())): string {
    const { start, end } = dayBounds(day)
    const activity = this.deps.store.activity({ since: start, until: end, limit: 1000 })
    return buildDigest(day, this.deps.store.list({ limit: 500 }), activity)
  }

  async writeDigest(day = localDay(this.now())): Promise<{ written: boolean; path?: string; markdown: string }> {
    const markdown = this.digest(day)
    if (!(await this.deps.wiki.configured())) return { written: false, markdown }
    const { path } = await this.deps.wiki.writeSection(day, markdown)
    return { written: true, path, markdown }
  }

  // --- settings ----------------------------------------------------------------

  publicSettings(): Promise<AgentWorkPublicSettings> {
    return this.deps.settings.publicSettings()
  }

  /** Save settings. The channel must exist in Mattermost (checked through the bot) before it is kept. */
  async saveSettings(input: any): Promise<AgentWorkPublicSettings> {
    const current = await this.deps.settings.load()
    const mmIn = input?.mattermost || {}
    const next: AgentWorkSettings = structuredClone(current)
    if (input?.shareToOrb !== undefined) next.shareToOrb = input.shareToOrb === true
    if (mmIn.mention !== undefined) next.mattermost.mention = parseMentions(mmIn.mention)
    if (mmIn.mentionOnApproval !== undefined) next.mattermost.mentionOnApproval = mmIn.mentionOnApproval !== false
    if (mmIn.actionUrl !== undefined) {
      const url = String(mmIn.actionUrl || '').trim().replace(/\/+$/, '')
      if (url && !/^https?:\/\/\S+$/i.test(url)) throw new AgentWorkError('Studio address for Mattermost must start with http:// or https://')
      next.mattermost.actionUrl = url
    }
    if (mmIn.channel !== undefined) {
      const channel = String(mmIn.channel || '').trim().replace(/^[#~]/, '').toLowerCase()
      if (!channel) { next.mattermost.channel = ''; next.mattermost.channelId = ''; next.mattermost.teamId = '' }
      else if (channel !== current.mattermost.channel || !current.mattermost.channelId) {
        let found: { id: string; teamId: string } | null
        try { found = await this.deps.mattermost.findChannel(channel, this.deps.setupRecord()?.teamId || undefined) }
        catch (error) { throw new AgentWorkError(`Could not check the channel in Mattermost: ${errorText(error)}`, 422) }
        if (!found) throw new AgentWorkError(`Mattermost has no channel called ~${channel} that the bot can see. Create it (or run "Set up Mattermost") and add the bot, then save again.`, 422)
        next.mattermost.channel = channel
        next.mattermost.channelId = found.id
        next.mattermost.teamId = found.teamId
      }
    }
    if (next.mattermost.mention.length && next.mattermost.mention.join() !== current.mattermost.mention.join()) {
      let ids: Record<string, string> = {}
      try { ids = await this.deps.mattermost.userIds(next.mattermost.mention) }
      catch (error) { throw new AgentWorkError(`Could not check the usernames in Mattermost: ${errorText(error)}`, 422) }
      const unknown = next.mattermost.mention.filter(name => !ids[name])
      if (unknown.length) throw new AgentWorkError(`Mattermost has no user ${unknown.map(n => `@${n}`).join(', ')}`, 422)
      for (const [name, id] of Object.entries(ids)) this.userIdCache.set(name, id)
    }
    const ag = input?.allglance, wiki = input?.wiki
    if (ag) {
      if (ag.url !== undefined) {
        const url = String(ag.url || '').trim().replace(/\/+$/, '')
        if (url && !/^https?:\/\/\S+$/i.test(url)) throw new AgentWorkError('ALLGlance address must start with http:// or https://')
        next.allglance.url = url
      }
      next.allglance.token = typeof ag.token === 'string' && ag.token.trim() ? ag.token.trim() : ''
    } else next.allglance.token = ''
    if (wiki) {
      if (wiki.url !== undefined) {
        const url = String(wiki.url || '').trim().replace(/\/+$/, '')
        if (url && !/^https?:\/\/\S+$/i.test(url)) throw new AgentWorkError('Wiki address must start with http:// or https://')
        next.wiki.url = url
      }
      if (wiki.folder !== undefined) next.wiki.folder = String(wiki.folder || '')
      if (wiki.section !== undefined) next.wiki.section = String(wiki.section || '')
      next.wiki.token = typeof wiki.token === 'string' && wiki.token.trim() ? wiki.token.trim() : ''
    } else next.wiki.token = ''
    return this.deps.settings.save(next)
  }

  close(): void {
    if (this.digestTimer) clearTimeout(this.digestTimer)
    this.digestTimer = null
  }
}

function safeWanted(wanted: () => boolean): boolean {
  try { return wanted() } catch { return true }
}
