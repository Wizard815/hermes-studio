import type { Context, Next } from 'koa'
import { logger } from '../public/logging'
import { authenticateUserToken, getUserJwtExpiresSeconds, issueUserJwt, type AuthenticatedUser } from './auth'
import { config } from '../public/config'
import {
  giveHermesUpstreamTools, giveHermesWikiTools, hermesHasUpstreamTools, hermesHasWikiTools, upstreamMcpServer, upstreamOverview,
  upstreamStatus, upstreamWikiConnection, type ProfileConfigAccess,
} from '../services/upstream/client'
import { getActiveProfileName, readConfigYamlForProfile, saveEnvValueForProfile, updateConfigYamlForProfile } from '../public/profile-config'

const profileConfigAccess: ProfileConfigAccess = {
  read: readConfigYamlForProfile,
  update: (profile, fn) => updateConfigYamlForProfile(profile, fn as any) as any,
}

/**
 * Reverse proxy for the Upstream Management Flask app (Upstream-Upkeep).
 *
 * Studio serves Upstream Management under its own origin at `/upstream`, so it
 * shares the exact same host/port as Studio instead of needing a separate localhost:5001. The Flask app is path-based
 * (Repos / requests / settings / repo/<id>) and its frontend calls its own API
 * at relative paths, so every upstream request is rewritten to strip the
 * `/upstream` prefix and forwarded to the Flask backend.
 *
 * It MUST be registered before the SPA/`securityHeaders()` middleware so the
 * proxied frame responses are not tagged with `X-Frame-Options: DENY` (which
 * would block the in-app iframe) and therefore before the global auth
 * middleware, so it authenticates itself: only a Studio super administrator may
 * reach it. The iframe passes the login token once as `?token=`; it is moved
 * into a path-scoped HttpOnly cookie so the Flask app's relative sub-requests
 * stay authenticated, and neither is forwarded to the Flask app.
 *
 * Working in tandem: every forwarded request also carries `x-studio-url` (how
 * Upstream reaches Studio) and `x-studio-token` (a login for this administrator,
 * renewed well before it expires). Upstream keeps them, so opening the tab once
 * is all it takes for Upstream to start herdr agents as Studio chats and run
 * Studio chats for its tasks. Upstream accepts them only from its trusted proxy
 * (this machine, or an address in its UPSTREAM_TRUSTED_PROXIES).
 * `GET /api/studio/upstream/status` says whether Upstream answers.
 */

const DEFAULT_TARGET = process.env.UPSTREAM_UPKEEP_TARGET || 'http://127.0.0.1:5001'
const DEFAULT_PREFIX = process.env.UPSTREAM_UPKEEP_PATH_PREFIX || '/upstream'

const targetBase = DEFAULT_TARGET.replace(/\/+$/, '')
const prefix = DEFAULT_PREFIX.replace(/^\/+/, '').replace(/\/+$/, '') || 'upstream'
const prefixPath = `/${prefix}`
const upstreamBaseHeader = `/${prefix}` // sent to Flask so it can prefix its assets/nav

function readRawBody(req: any): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

const AUTH_COOKIE = 'studio_upstream_token'

function readCookie(req: any, name: string): string {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const index = part.indexOf('=')
    if (index > 0 && part.slice(0, index).trim() === name) {
      try { return decodeURIComponent(part.slice(index + 1).trim()) } catch { return '' }
    }
  }
  return ''
}

/** How Upstream reaches Studio: HERMES_STUDIO_URL_FOR_UPSTREAM, else this server on loopback. */
export function studioUrlForUpstream(env: NodeJS.ProcessEnv = process.env, port: number = config.port): string {
  return (env.HERMES_STUDIO_URL_FOR_UPSTREAM || `http://127.0.0.1:${port}`).replace(/\/+$/, '')
}

const handedOver = new Map<number, { token: string; at: number }>()

/** A login for Upstream to act as this administrator; the same one until half its life is gone. */
export async function tokenForUpstream(user: Pick<AuthenticatedUser, 'id' | 'username' | 'role'>, now = Date.now()): Promise<string> {
  const life = getUserJwtExpiresSeconds() * 1000
  const kept = handedOver.get(user.id)
  if (kept && now - kept.at < life / 2) return kept.token
  const token = await issueUserJwt({ id: user.id, username: user.username, role: user.role })
  handedOver.set(user.id, { token, at: now })
  return token
}

/** Returns the super administrator, or answers 401/403 and returns null. */
async function authorize(ctx: Context): Promise<AuthenticatedUser | null> {
  const bearer = String(ctx.headers.authorization || '')
  const queryToken = typeof ctx.query.token === 'string' ? ctx.query.token.trim() : ''
  const token = (bearer.startsWith('Bearer ') ? bearer.slice(7).trim() : '')
    || queryToken
    || readCookie(ctx.req, AUTH_COOKIE)
  const user = token ? await authenticateUserToken(token) : null
  if (!user) {
    ctx.status = 401
    ctx.body = { error: 'Unauthorized' }
    return null
  }
  if (user.role !== 'super_admin') {
    ctx.status = 403
    ctx.body = { error: 'Super administrator privileges are required' }
    return null
  }
  if (queryToken) {
    ctx.cookies.set(AUTH_COOKIE, queryToken, {
      httpOnly: true, sameSite: 'strict', path: prefixPath, secure: ctx.secure, overwrite: true,
    })
  }
  return user
}

function stripToken(search: string): string {
  const params = new URLSearchParams(search)
  params.delete('token')
  const rest = params.toString()
  return rest ? `?${rest}` : ''
}

function copyHeaders(req: any): Record<string, string> {
  const headers: Record<string, string> = {}
  const hopByHop = new Set([
    'host', 'connection', 'keep-alive', 'transfer-encoding', 'content-length',
    'te', 'trailer', 'upgrade', 'proxy-authorization', 'authorization', 'cookie',
    // only Studio itself sets these
    'x-studio-token', 'x-studio-url', 'x-upstream-base',
  ])
  for (const [key, value] of Object.entries(req.headers)) {
    if (!value || hopByHop.has(key.toLowerCase())) continue
    headers[key] = Array.isArray(value) ? value.join(', ') : String(value)
  }
  return headers
}

async function forward(ctx: Context, next: Next, backendPath: string, method: string, user?: AuthenticatedUser): Promise<void> {
  const url = `${targetBase}${backendPath}${stripToken(ctx.search ?? '')}`
  const headers = copyHeaders(ctx.req)
  headers['host'] = new URL(url).host
  headers['x-upstream-base'] = upstreamBaseHeader
  if (user) {
    headers['x-studio-url'] = studioUrlForUpstream()
    try { headers['x-studio-token'] = await tokenForUpstream(user) } catch (err) {
      logger.warn({ err }, '[upstream-upkeep] could not make a login for Upstream')
    }
  }
  let body: Buffer | undefined
  if (method !== 'GET' && method !== 'HEAD') {
    try {
      body = await readRawBody(ctx.req)
      headers['content-length'] = String(body?.byteLength ?? 0)
    } catch (err) {
      logger.warn({ err }, '[upstream-upkeep] failed to read request body')
    }
  }
  try {
    const resp = await fetch(url, { method, headers, body: body ? new Uint8Array(body) : undefined })
    ctx.status = resp.status
    for (const [key, value] of resp.headers) {
      // fetch() already decoded the body, so length/encoding no longer apply.
      if (['content-length', 'content-encoding', 'transfer-encoding'].includes(key.toLowerCase())) continue
      try { ctx.set(key, value) } catch { /* ignore header set errors */ }
    }
    if (method !== 'HEAD') {
      const buf = Buffer.from(await resp.arrayBuffer())
      if (buf.length) ctx.body = buf
    }
  } catch (err) {
    logger.warn({ err }, '[upstream-upkeep] proxy request failed')
    ctx.status = 502
    ctx.type = 'application/json'
    ctx.body = JSON.stringify({ ok: false, error: 'upstream_unavailable' })
  }
}

export function upstreamUpkeepProxy(): (ctx: Context, next: Next) => Promise<void> {
  return async (ctx: Context, next: Next): Promise<void> => {
    const { path, method } = ctx
    if (path === '/api/studio/upstream/status' && method === 'GET') {
      if (!(await authorize(ctx))) return
      ctx.body = await upstreamStatus()
      return
    }
    // The Overseer's picture, for the summary above the Upstream tab.
    if (path === '/api/studio/upstream/overview' && method === 'GET') {
      if (!(await authorize(ctx))) return
      const profile = getActiveProfileName()
      const wiki = await upstreamWikiConnection()
      ctx.body = {
        ...(await upstreamOverview()),
        hermesTools: await hermesHasUpstreamTools(profile, profileConfigAccess),
        // the key never goes to the browser: only whether there is a wiki and whether Hermes has it
        wikiAvailable: !!wiki,
        wikiTools: wiki ? await hermesHasWikiTools(profile, profileConfigAccess, wiki.url) : false,
      }
      return
    }
    // Give the active Hermes profile the LLM wiki's own tools, as Upstream reaches the wiki.
    if (path === '/api/studio/upstream/wiki-tools' && method === 'POST') {
      if (!(await authorize(ctx))) return
      const wiki = await upstreamWikiConnection()
      if (!wiki) {
        ctx.status = 404
        ctx.body = { ok: false, error: 'Upstream has no LLM wiki connection (LLMWIKI_MCP_URL in its .env)' }
        return
      }
      const profile = getActiveProfileName()
      const added = await giveHermesWikiTools(profile, wiki, profileConfigAccess, saveEnvValueForProfile)
      logger.info({ profile, added }, '[upstream-upkeep] LLM wiki tools for Hermes')
      ctx.body = { ok: true, added, profile }
      return
    }
    // Give the active Hermes profile Upstream's tools (the board, the Overseer): one click in the Upstream tab.
    if (path === '/api/studio/upstream/hermes-tools' && method === 'POST') {
      if (!(await authorize(ctx))) return
      const server = await upstreamMcpServer()
      if (!server) {
        ctx.status = 502
        ctx.body = { ok: false, error: 'Upstream did not say how to start its tools (is it running, and new enough?)' }
        return
      }
      const profile = getActiveProfileName()
      const added = await giveHermesUpstreamTools(profile, server, profileConfigAccess)
      logger.info({ profile, added }, '[upstream-upkeep] Upstream tools for Hermes')
      ctx.body = { ok: true, added, profile }
      return
    }
    if (!(path === prefixPath || path.startsWith(`${prefixPath}/`))) {
      await next()
      return
    }
    const user = await authorize(ctx)
    if (!user) return
    if (path === prefixPath || path === `${prefixPath}/`) {
      await forward(ctx, next, '/', method, user)
      return
    }
    const rel = path.slice(prefixPath.length)
    if (rel.startsWith('/api/') || rel.startsWith('/static/')) {
      await forward(ctx, next, rel, method, user)
      return
    }
    // View path (Repos / requests / settings / repo/<id>) -> serve the shell;
    // the SPA reads location.pathname to render the right section.
    await forward(ctx, next, '/', method, user)
  }
}
