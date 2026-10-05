import type { Context, Next } from 'koa'
import { logger } from '../public/logging'

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
 * would block the in-app iframe) and before the auth middleware (Upstream
 * Management is a local tool, no Studio token required).
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

function copyHeaders(req: any): Record<string, string> {
  const headers: Record<string, string> = {}
  const hopByHop = new Set([
    'host', 'connection', 'keep-alive', 'transfer-encoding', 'content-length',
    'te', 'trailer', 'upgrade', 'proxy-authorization',
  ])
  for (const [key, value] of Object.entries(req.headers)) {
    if (!value || hopByHop.has(key.toLowerCase())) continue
    headers[key] = Array.isArray(value) ? value.join(', ') : String(value)
  }
  return headers
}

async function forward(ctx: Context, next: Next, backendPath: string, method: string): Promise<void> {
  const url = `${targetBase}${backendPath}${ctx.search ?? ''}`
  const headers = copyHeaders(ctx.req)
  headers['host'] = new URL(url).host
  headers['x-upstream-base'] = upstreamBaseHeader
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
    if (path === prefixPath || path === `${prefixPath}/`) {
      await forward(ctx, next, '/', method)
      return
    }
    if (path.startsWith(`${prefixPath}/`)) {
      const rel = path.slice(prefixPath.length)
      if (rel.startsWith('/api/') || rel.startsWith('/static/')) {
        await forward(ctx, next, rel, method)
        return
      }
      // View path (Repos / requests / settings / repo/<id>) -> serve the shell;
      // the SPA reads location.pathname to render the right section.
      await forward(ctx, next, '/', method)
      return
    }
    await next()
  }
}
