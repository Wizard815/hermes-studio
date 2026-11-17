import type { Context } from 'koa'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { getActiveProfileName, getProfileDir } from '../services/profiles/profile'
import { gatewayAutostartDisabledByEnv, restartGatewayForProfile } from '../services/gateway/autostart'
import { readAppConfig, normalizeGatewayAutoStartConfig } from '../../studio/public/app-config'
import { saveEnvValueForProfile, updateConfigYamlForProfile } from '../../studio/public/profile-config'
import { safeFileStore } from '../../studio/public/safe-file-store'
import { logger } from '../../studio/public/logging'

/**
 * "Set up Mattermost for Hermes": once the server URL and bot token are saved, Studio uses
 * Mattermost's REST API to pick the team, create #hermes / #home-alerts / #server-alerts, add
 * the bot and the user to them, and point Hermes's home, free-response and allowed channels
 * and allowed users at them. An admin sign-in (or token) may be passed for one run when the
 * bot lacks permissions; it is used for that request only and never written anywhere.
 */

export type ChannelRole = 'main' | 'home_alerts' | 'server_alerts'
export const CHANNEL_ROLES: ChannelRole[] = ['main', 'home_alerts', 'server_alerts']
export const DEFAULT_CHANNEL_NAMES: Record<ChannelRole, string> = {
  main: 'hermes',
  home_alerts: 'home-alerts',
  server_alerts: 'server-alerts',
}
const CHANNEL_PURPOSE: Record<ChannelRole, string> = {
  main: 'Chat with Hermes. Hermes answers every message here.',
  home_alerts: 'Home Assistant alarms and alerts from Hermes.',
  server_alerts: 'Unraid server status and job results from Hermes.',
}

/** Studio's record of the channels it set up, per profile (read by the Jobs page's delivery targets). */
export interface MattermostSetupRecord {
  url: string
  team: { id: string; name: string; display_name: string }
  user: { id: string; username: string }
  bot: { id: string; username: string }
  channels: Array<{ role: ChannelRole; id: string; name: string; display_name: string }>
  updated_at: string
}

export const setupRecordPath = (profile: string) => join(getProfileDir(profile || 'default'), 'studio-mattermost.json')

export function readSetupRecord(profile: string): MattermostSetupRecord | null {
  const path = setupRecordPath(profile)
  if (!existsSync(path)) return null
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'))
    return parsed && typeof parsed === 'object' && Array.isArray(parsed.channels) ? parsed : null
  } catch {
    return null
  }
}

export class MattermostError extends Error {
  constructor(public code: string, message: string, public status = 400, public detail: Record<string, unknown> = {}) {
    super(message)
  }
}

interface AdminAuth { token?: string; login_id?: string; password?: string }

function resolveProfile(ctx: Context): string {
  return ctx.state?.profile?.name || getActiveProfileName() || 'default'
}

function parseEnv(raw: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    let value = trimmed.slice(eq + 1).trim()
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.endsWith(value[0])) value = value.slice(1, -1)
    env[trimmed.slice(0, eq).trim()] = value
  }
  return env
}

function readProfileEnv(profile: string): Record<string, string> {
  const path = join(getProfileDir(profile || 'default'), '.env')
  return existsSync(path) ? parseEnv(readFileSync(path, 'utf-8')) : {}
}

/** Mattermost channel names: lowercase letters, digits, dashes and underscores, 2-64 characters. */
export function channelSlug(value: string): string {
  return String(value || '').trim().replace(/^[#~]/, '').toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64)
}

export function mergeCsv(existing: string | undefined, add: string[]): string {
  const items = String(existing || '').split(',').map(s => s.trim()).filter(Boolean)
  for (const value of add) if (value && !items.includes(value)) items.push(value)
  return items.join(',')
}

class MattermostClient {
  constructor(private base: string, private token: string) {}

  async call<T = any>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T; headers: Headers }> {
    let res: Response
    try {
      res = await fetch(`${this.base}/api/v4${path}`, {
        method,
        headers: {
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15_000),
      })
    } catch (err: any) {
      throw new MattermostError('unreachable', `Studio could not reach Mattermost at ${this.base}: ${err?.cause?.code || err?.message || err}`, 502)
    }
    const text = await res.text()
    let data: any = null
    try { data = text ? JSON.parse(text) : null } catch { data = text }
    return { status: res.status, data, headers: res.headers }
  }

  async get<T = any>(path: string): Promise<T | null> {
    const r = await this.call<T>('GET', path)
    if (r.status === 404) return null
    if (r.status >= 400) throw apiError(r.status, r.data, `GET ${path}`)
    return r.data
  }
}

function apiError(status: number, data: any, what: string): MattermostError {
  const msg = (data && typeof data === 'object' && data.message) || `Mattermost answered ${status} to ${what}`
  if (status === 401) return new MattermostError('unauthorized', `Mattermost did not accept the token (${msg}).`, 400)
  if (status === 403) return new MattermostError('forbidden', String(msg), 422)
  return new MattermostError('api_error', String(msg), 502)
}

interface Session {
  base: string
  bot: MattermostClient
  /** The client that does the work: the admin's when one was given, else the bot's. */
  actor: MattermostClient
  botUser: { id: string; username: string }
  usingAdmin: boolean
  logout?: () => Promise<void>
}

async function openSession(profile: string, admin: AdminAuth | undefined): Promise<Session> {
  const env = readProfileEnv(profile)
  const base = String(env.MATTERMOST_URL || '').trim().replace(/\/+$/, '')
  const token = String(env.MATTERMOST_TOKEN || '').trim()
  if (!base || !token) throw new MattermostError('not_configured', 'Save the Mattermost server URL and bot token first.')
  const bot = new MattermostClient(base, token)
  const me = await bot.get<any>('/users/me')
  if (!me?.id) throw new MattermostError('unauthorized', 'Mattermost did not accept the bot token.')
  const botUser = { id: me.id, username: me.username }

  let actor = bot
  let logout: Session['logout']
  const adminToken = String(admin?.token || '').trim()
  const loginId = String(admin?.login_id || '').trim()
  if (adminToken) {
    actor = new MattermostClient(base, adminToken)
    const who = await actor.get<any>('/users/me')
    if (!who?.id) throw new MattermostError('admin_unauthorized', 'Mattermost did not accept the admin token.')
  } else if (loginId && admin?.password) {
    const login = await new MattermostClient(base, '').call<any>('POST', '/users/login', { login_id: loginId, password: admin.password })
    const sessionToken = login.headers.get('token')
    if (login.status >= 400 || !sessionToken) {
      throw new MattermostError('admin_unauthorized', `Mattermost refused the admin sign-in${login.data?.message ? `: ${login.data.message}` : ''}.`)
    }
    actor = new MattermostClient(base, sessionToken)
    // A sign-in session is ended as soon as the setup is done, so nothing usable stays behind.
    logout = async () => { await actor.call('POST', '/users/logout').catch(() => {}) }
  }
  return { base, bot, actor, botUser, usingAdmin: actor !== bot, logout }
}

async function withSession<T>(profile: string, admin: AdminAuth | undefined, fn: (s: Session) => Promise<T>): Promise<T> {
  const session = await openSession(profile, admin)
  try {
    return await fn(session)
  } finally {
    await session.logout?.()
  }
}

async function listTeams(s: Session) {
  // An admin sees every team; a bot only the teams it was added to.
  const teams = (s.usingAdmin ? await s.actor.get<any[]>('/teams?per_page=200') : await s.bot.get<any[]>('/users/me/teams')) || []
  const botTeams = new Set(((await s.bot.get<any[]>('/users/me/teams')) || []).map(t => t.id))
  return teams
    .filter(t => !t.delete_at)
    .map(t => ({ id: t.id, name: t.name, display_name: t.display_name || t.name, bot_member: botTeams.has(t.id) }))
}

/** What the setup step shows: the bot, its teams, defaults and whatever Studio set up last time. */
export async function inspectSetup(profile: string, admin?: AdminAuth) {
  return withSession(profile, admin, async (s) => ({
    url: s.base,
    bot: s.botUser,
    using_admin: s.usingAdmin,
    teams: await listTeams(s),
    defaults: DEFAULT_CHANNEL_NAMES,
    current: readSetupRecord(profile),
  }))
}

export interface ApplyInput {
  team_id: string
  username: string
  channels?: Partial<Record<ChannelRole, string>>
  admin?: AdminAuth
  restart?: boolean
}

async function ensureTeamMember(s: Session, teamId: string, userId: string, who: 'bot' | 'user') {
  if ((await s.actor.call('GET', `/teams/${teamId}/members/${userId}`)).status === 200) return false
  const r = await s.actor.call('POST', `/teams/${teamId}/members`, { team_id: teamId, user_id: userId })
  if (r.status < 300) return true
  if (r.status === 403) {
    throw new MattermostError(who === 'bot' ? 'bot_not_in_team' : 'user_not_in_team',
      who === 'bot'
        ? 'The bot is not in this team and is not allowed to join it.'
        : 'Your account is not in this team and the bot is not allowed to add it.', 422)
  }
  throw apiError(r.status, r.data, 'add team member')
}

async function ensureChannel(s: Session, teamId: string, role: ChannelRole, name: string) {
  const existing = await s.actor.get<any>(`/teams/${teamId}/channels/name/${encodeURIComponent(name)}?include_deleted=true`)
  if (existing?.id) {
    if (existing.delete_at) {
      const r = await s.actor.call('POST', `/channels/${existing.id}/restore`)
      if (r.status >= 300) throw new MattermostError('channel_archived', `~${name} exists but is archived. Unarchive it in Mattermost or pick another name.`, 409)
    }
    return { channel: existing, created: false }
  }
  const r = await s.actor.call<any>('POST', '/channels', {
    team_id: teamId,
    name,
    display_name: name,
    type: 'O',
    purpose: CHANNEL_PURPOSE[role],
  })
  if (r.status < 300) return { channel: r.data, created: true }
  if (r.status === 403) throw new MattermostError('bot_cannot_create_channels', 'The bot is not allowed to create channels.', 422, { channel: name })
  throw apiError(r.status, r.data, `create channel ${name}`)
}

async function ensureChannelMember(s: Session, channelId: string, userId: string, channelName: string) {
  if ((await s.actor.call('GET', `/channels/${channelId}/members/${userId}`)).status === 200) return false
  const r = await s.actor.call('POST', `/channels/${channelId}/members`, { user_id: userId })
  if (r.status < 300) return true
  if (r.status === 403) throw new MattermostError('bot_cannot_add_members', `The bot is not allowed to add members to ~${channelName}.`, 422, { channel: channelName })
  throw apiError(r.status, r.data, `add member to ${channelName}`)
}

/** Hermes's own channel aliases: lets the agent and cron address these channels by name. */
async function writeChannelAliases(profile: string, channels: Array<{ id: string; name: string }>) {
  const path = join(getProfileDir(profile || 'default'), 'channel_aliases.json')
  let aliases: Record<string, any> = {}
  try { if (existsSync(path)) aliases = JSON.parse(readFileSync(path, 'utf-8')) || {} } catch { aliases = {} }
  if (!aliases || typeof aliases !== 'object' || Array.isArray(aliases)) aliases = {}
  const mm = aliases.mattermost && typeof aliases.mattermost === 'object' ? aliases.mattermost : {}
  for (const c of channels) mm[c.id] = c.name
  aliases.mattermost = mm
  await safeFileStore.writeText(path, JSON.stringify(aliases, null, 2) + '\n')
}

async function gatewayRestartAllowed(): Promise<boolean> {
  if (gatewayAutostartDisabledByEnv()) return false
  return normalizeGatewayAutoStartConfig((await readAppConfig()).gatewayAutoStart).enabled === true
}

export async function applySetup(profile: string, input: ApplyInput) {
  const teamId = String(input.team_id || '').trim()
  const username = String(input.username || '').trim().replace(/^@/, '').toLowerCase()
  if (!teamId) throw new MattermostError('team_required', 'Pick a team.')
  if (!username) throw new MattermostError('username_required', 'Enter your Mattermost username.')
  const names = {} as Record<ChannelRole, string>
  for (const role of CHANNEL_ROLES) {
    const slug = channelSlug(input.channels?.[role] || DEFAULT_CHANNEL_NAMES[role])
    if (slug.length < 2) throw new MattermostError('bad_channel_name', `"${input.channels?.[role]}" is not a usable channel name.`)
    names[role] = slug
  }
  if (new Set(Object.values(names)).size !== CHANNEL_ROLES.length) throw new MattermostError('duplicate_channel_name', 'Use three different channel names.')

  const result = await withSession(profile, input.admin, async (s) => {
    const teamRes = await s.actor.call<any>('GET', `/teams/${teamId}`)
    if (teamRes.status === 403) throw new MattermostError('bot_not_in_team', 'The bot is not in this team, so it cannot see it.', 422)
    const team = teamRes.status < 300 ? teamRes.data : null
    if (!team?.id) throw new MattermostError('team_not_found', 'That team was not found.')
    const user = await s.actor.get<any>(`/users/username/${encodeURIComponent(username)}`)
    if (!user?.id) throw new MattermostError('user_not_found', `No Mattermost user is called @${username}.`, 404)

    const steps: string[] = []
    if (await ensureTeamMember(s, teamId, s.botUser.id, 'bot')) steps.push(`added @${s.botUser.username} to the team`)
    if (await ensureTeamMember(s, teamId, user.id, 'user')) steps.push(`added @${user.username} to the team`)

    const channels: MattermostSetupRecord['channels'] = []
    for (const role of CHANNEL_ROLES) {
      const { channel, created } = await ensureChannel(s, teamId, role, names[role])
      if (created) steps.push(`created ~${channel.name}`)
      for (const member of [s.botUser, { id: user.id, username: user.username }]) {
        if (await ensureChannelMember(s, channel.id, member.id, channel.name)) steps.push(`added @${member.username} to ~${channel.name}`)
      }
      channels.push({ role, id: channel.id, name: channel.name, display_name: channel.display_name || channel.name })
    }
    return {
      base: s.base,
      team: { id: team.id, name: team.name, display_name: team.display_name || team.name },
      user: { id: user.id as string, username: user.username as string },
      bot: s.botUser,
      channels,
      steps,
    }
  })

  // Hermes's settings: #hermes is home and answers without an @mention; Hermes listens only in
  // these three channels (alerts need an @mention), and the user is on the allowed list.
  const env = readProfileEnv(profile)
  const ids = Object.fromEntries(result.channels.map(c => [c.role, c.id])) as Record<ChannelRole, string>
  const envUpdates: Record<string, string> = {
    MATTERMOST_HOME_CHANNEL: ids.main,
    MATTERMOST_FREE_RESPONSE_CHANNELS: mergeCsv(env.MATTERMOST_FREE_RESPONSE_CHANNELS, [ids.main]),
    MATTERMOST_ALLOWED_CHANNELS: mergeCsv(env.MATTERMOST_ALLOWED_CHANNELS, result.channels.map(c => c.id)),
    MATTERMOST_ALLOWED_USERS: mergeCsv(env.MATTERMOST_ALLOWED_USERS, [result.user.id]),
  }
  for (const [key, value] of Object.entries(envUpdates)) await saveEnvValueForProfile(profile, key, value)
  // The gateway connects with only the URL and token in .env, but Hermes's cron delivery refuses a
  // platform that config.yaml has off ("mattermost has no gateway credentials configured"), so
  // jobs could never post to these channels. Setting Hermes up for Mattermost turns it on.
  const enabled = await updateConfigYamlForProfile<boolean>(profile, (config) => {
    if (!config.platforms || typeof config.platforms !== 'object') config.platforms = {}
    const mm = config.platforms.mattermost && typeof config.platforms.mattermost === 'object' ? config.platforms.mattermost : {}
    const changed = mm.enabled !== true
    mm.enabled = true
    config.platforms.mattermost = mm
    return { data: config, result: changed, write: changed }
  })

  const record: MattermostSetupRecord = {
    url: result.base,
    team: result.team,
    user: result.user,
    bot: result.bot,
    channels: result.channels,
    updated_at: new Date().toISOString(),
  }
  await safeFileStore.writeText(setupRecordPath(profile), JSON.stringify(record, null, 2) + '\n')
  await writeChannelAliases(profile, result.channels)

  let restarted = false
  let restartError: string | null = null
  if (input.restart !== false && await gatewayRestartAllowed()) {
    try {
      await restartGatewayForProfile(profile)
      restarted = true
    } catch (err: any) {
      restartError = err?.message || String(err)
      logger.error(err, '[mattermost-setup] gateway restart failed profile=%s', profile)
    }
  }
  logger.info('[mattermost-setup] profile=%s team=%s channels=%j steps=%j restarted=%s', profile, result.team.name, result.channels.map(c => c.name), result.steps, restarted)
  return { ok: true, ...record, steps: enabled ? [...result.steps, 'turned Mattermost on in Hermes'] : result.steps, env: envUpdates, restarted, restart_error: restartError }
}

function adminFromBody(body: any): AdminAuth | undefined {
  const admin = body?.admin
  if (!admin || typeof admin !== 'object') return undefined
  return { token: admin.token, login_id: admin.login_id, password: admin.password }
}

function sendError(ctx: Context, err: unknown) {
  if (err instanceof MattermostError) {
    ctx.status = err.status
    ctx.body = { error: err.message, code: err.code, ...err.detail }
    return
  }
  logger.error(err, '[mattermost-setup] unexpected error')
  ctx.status = 500
  ctx.body = { error: err instanceof Error ? err.message : String(err), code: 'internal' }
}

export async function inspect(ctx: Context) {
  try {
    ctx.body = await inspectSetup(resolveProfile(ctx), adminFromBody((ctx.request as any).body))
  } catch (err) {
    sendError(ctx, err)
  }
}

export async function apply(ctx: Context) {
  const body = ((ctx.request as any).body || {}) as Record<string, any>
  try {
    ctx.body = await applySetup(resolveProfile(ctx), {
      team_id: body.team_id,
      username: body.username,
      channels: body.channels,
      admin: adminFromBody(body),
      restart: body.restart,
    })
  } catch (err) {
    sendError(ctx, err)
  }
}

export function current(ctx: Context) {
  ctx.body = { current: readSetupRecord(resolveProfile(ctx)) }
}
