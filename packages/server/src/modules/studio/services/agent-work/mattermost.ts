import type { AgentWork, AgentWorkStatus } from './store'
import type { AgentWorkSettings } from './settings'

/**
 * Agent work in Mattermost: one post per change in the channel set in
 * Connections → Agent work, tagged (#agentwork #blocked, #done …). #blocked
 * posts @mention the usernames set there (none when that is empty); approval
 * requests carry Approve / Reject buttons (when Studio's address for Mattermost
 * is set) and can also be answered with a ✅ / ❌ reaction. Uses the bot that
 * "Set up Mattermost" connected (MATTERMOST_URL / MATTERMOST_TOKEN).
 */

export interface MattermostPort {
  /** The bot's own user id, so its reactions are ignored. */
  botUserId(): Promise<string>
  createPost(channelId: string, message: string, props?: Record<string, unknown>): Promise<{ id: string }>
  patchPost(postId: string, message: string, props?: Record<string, unknown>): Promise<void>
  reactions(postId: string): Promise<Array<{ user_id: string; emoji_name: string }>>
  /** A channel by name, in the given team (or any of the bot's teams). */
  findChannel(name: string, teamId?: string): Promise<{ id: string; teamId: string; name: string } | null>
  userIds(usernames: string[]): Promise<Record<string, string>>
}

export const STATUS_TAG: Record<AgentWorkStatus, string> = {
  queued: 'queued',
  working: 'working',
  blocked: 'blocked',
  awaiting_approval: 'approval',
  done: 'done',
  rejected: 'rejected',
}

const STATUS_TEXT: Record<AgentWorkStatus, string> = {
  queued: 'is queued',
  working: 'is being worked on',
  blocked: 'is blocked and needs you',
  awaiting_approval: 'is waiting for your approval',
  done: 'is done',
  rejected: 'was rejected',
}

const VIA_TEXT: Record<string, string> = { studio: 'Studio', mattermost: 'Mattermost', orb: 'Pondering Orb', omi: 'Omi' }

/**
 * Where a decision was made, for people: "in Mattermost by robin", or
 * "on phone (Pixel 8)" for the Studio Own app, whose `by` is the phone's name.
 */
export function decidedPlace(via: string, by = ''): string {
  if (via === 'phone') return `on phone${by ? ` (${by})` : ''}`
  return `in ${VIA_TEXT[via] || via}${by ? ` by ${by}` : ''}`
}

export function mentionsFor(status: AgentWorkStatus, settings: AgentWorkSettings['mattermost']): string {
  const wants = status === 'blocked' || (status === 'awaiting_approval' && settings.mentionOnApproval)
  if (!wants || !settings.mention.length) return ''
  return settings.mention.map(name => `@${name}`).join(' ')
}

function describe(work: AgentWork): string {
  const bits = [work.agent ? `agent ${work.agent}` : '', work.vikunjaTaskId ? `Vikunja task #${work.vikunjaTaskId}` : ''].filter(Boolean)
  return bits.length ? ` _(${bits.join(' · ')})_` : ''
}

/** The text of a status post. */
export function composeStatusMessage(work: AgentWork, status: AgentWorkStatus, settings: AgentWorkSettings['mattermost']): string {
  const tags = `#agentwork #${STATUS_TAG[status]}`
  const mention = mentionsFor(status, settings)
  const head = `${tags}${mention ? ` ${mention}` : ''} **${work.title}** ${STATUS_TEXT[status]}${describe(work)}`
  const lines = [head]
  if (work.summary) lines.push(`> ${work.summary.replace(/\n+/g, '\n> ')}`)
  if (status === 'awaiting_approval') {
    lines.push(settings.actionUrl
      ? 'Approve or reject with the buttons, a :white_check_mark: / :x: reaction, or in Studio or Pondering Orb.'
      : 'React :white_check_mark: to approve or :x: to reject, or decide in Studio or Pondering Orb.')
  }
  return lines.join('\n')
}

export function approvalProps(work: AgentWork, token: string, actionUrl: string): Record<string, unknown> | undefined {
  return approvalButtons({ work_id: work.id, token }, actionUrl)
}

/**
 * Approve / Reject buttons that call Studio's one Mattermost action route.
 * `context` names what they answer: `work_id` for Agent work, `alert_id` for
 * a chat approval or a phone question (docs/approval-alerts.md), plus its secret.
 */
export function approvalButtons(context: Record<string, string>, actionUrl: string): Record<string, unknown> | undefined {
  if (!actionUrl) return undefined
  const url = `${actionUrl}/api/studio/agent-work/mattermost/action`
  const action = (decision: 'approve' | 'reject', name: string, style: string) => ({
    id: decision, name, style, type: 'button',
    integration: { url, context: { ...context, decision } },
  })
  return { attachments: [{ text: '', actions: [action('approve', 'Approve', 'primary'), action('reject', 'Reject', 'danger')] }] }
}

/** What an approval post turns into once it is decided anywhere: no buttons, no further alert. */
export function composeResolvedMessage(work: AgentWork): string {
  const verdict = work.decision === 'approved' ? 'approved' : 'rejected'
  return `#agentwork #${verdict} ~~#approval~~ **${work.title}** was ${verdict} ${decidedPlace(work.decidedVia, work.decidedBy)}.${describe(work)}`
}

export const APPROVE_EMOJI = new Set(['white_check_mark', 'heavy_check_mark', '+1', 'ballot_box_with_check'])
export const REJECT_EMOJI = new Set(['x', '-1', 'no_entry', 'negative_squared_cross_mark'])

/** The first approving or rejecting reaction from someone allowed to decide. */
export function decisionFromReactions(reactions: Array<{ user_id: string; emoji_name: string }>, botUserId: string, allowed: Set<string> | null): { decision: 'approve' | 'reject'; userId: string } | null {
  for (const r of reactions) {
    if (r.user_id === botUserId) continue
    if (allowed && allowed.size && !allowed.has(r.user_id)) continue
    if (APPROVE_EMOJI.has(r.emoji_name)) return { decision: 'approve', userId: r.user_id }
    if (REJECT_EMOJI.has(r.emoji_name)) return { decision: 'reject', userId: r.user_id }
  }
  return null
}

export class MattermostError extends Error {
  constructor(message: string, readonly status = 502) { super(message) }
}

/** The real Mattermost API, through the bot "Set up Mattermost" saved for the profile. */
export class MattermostRest implements MattermostPort {
  private botId = ''
  constructor(private readonly connection: () => { url: string; token: string }, private readonly fetcher: typeof fetch = fetch) {}

  private async call<T = any>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
    const { url, token } = this.connection()
    if (!url || !token) throw new MattermostError('Mattermost is not connected. Save its server URL and bot token, then run "Set up Mattermost".', 409)
    let res: Response
    try {
      res = await this.fetcher(`${url}/api/v4${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15_000),
      })
    } catch (error) {
      throw new MattermostError(`Studio could not reach Mattermost at ${url}: ${error instanceof Error ? error.message : String(error)}`)
    }
    const text = await res.text()
    let data: any = null
    try { data = text ? JSON.parse(text) : null } catch { data = text }
    return { status: res.status, data }
  }

  private async ok<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    const r = await this.call<T>(method, path, body)
    if (r.status >= 400) throw new MattermostError((r.data as any)?.message || `Mattermost answered ${r.status} to ${method} ${path}`, r.status === 404 ? 404 : 502)
    return r.data
  }

  async botUserId(): Promise<string> {
    if (!this.botId) this.botId = String((await this.ok<any>('GET', '/users/me'))?.id || '')
    return this.botId
  }

  async createPost(channelId: string, message: string, props?: Record<string, unknown>) {
    const post = await this.ok<any>('POST', '/posts', { channel_id: channelId, message, ...(props ? { props } : {}) })
    return { id: String(post.id) }
  }

  async patchPost(postId: string, message: string, props?: Record<string, unknown>) {
    await this.ok('PUT', `/posts/${encodeURIComponent(postId)}/patch`, { message, props: props || { attachments: [] } })
  }

  async reactions(postId: string) {
    const r = await this.call<any[]>('GET', `/posts/${encodeURIComponent(postId)}/reactions`)
    if (r.status === 404) return []
    if (r.status >= 400) throw new MattermostError(`Mattermost answered ${r.status} for reactions`)
    return Array.isArray(r.data) ? r.data.map(x => ({ user_id: String(x.user_id), emoji_name: String(x.emoji_name) })) : []
  }

  async findChannel(name: string, teamId?: string) {
    const teams = teamId ? [teamId] : ((await this.ok<any[]>('GET', '/users/me/teams')) || []).map(t => String(t.id))
    for (const team of teams) {
      const r = await this.call<any>('GET', `/teams/${encodeURIComponent(team)}/channels/name/${encodeURIComponent(name)}`)
      if (r.status < 300 && r.data?.id && !r.data.delete_at) return { id: String(r.data.id), teamId: team, name: String(r.data.name) }
      if (r.status >= 400 && r.status !== 404 && r.status !== 403) throw new MattermostError(r.data?.message || `Mattermost answered ${r.status} looking up ~${name}`)
    }
    return null
  }

  async userIds(usernames: string[]) {
    if (!usernames.length) return {}
    const users = await this.ok<any[]>('POST', '/users/usernames', usernames)
    return Object.fromEntries((users || []).map(u => [String(u.username), String(u.id)]))
  }
}
