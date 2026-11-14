import type { Context } from 'koa'
import { hermesApi, hermesApiPathAllowed } from '../services/hermes-api'

/** Status of Studio's private Hermes Agent API. */
export async function status(ctx: Context) {
  ctx.body = hermesApi.status()
}

/** Start it now (pages also start it on their first call). */
export async function start(ctx: Context) {
  try { await hermesApi.ensureRunning(); ctx.body = hermesApi.status() } catch (error: any) {
    ctx.status = error?.status || 503
    ctx.body = { ...hermesApi.status(), error: error?.message || String(error) }
  }
}

/** Hermes's errors point at its own dashboard; in Studio, that place is Studio. */
export function studioWording(body: Buffer): Buffer {
  const text = body.toString('utf8')
  const fixed = text.replace(/\b(in|from|via|on) the (Hermes )?dashboard\b/gi, '$1 Studio')
  return fixed === text ? body : Buffer.from(fixed)
}

/** /api/hermes-agent/<path>: one call to Hermes's API, as the active profile. */
export async function forward(ctx: Context) {
  const raw = (ctx.params as any).path
  const path = Array.isArray(raw) ? raw.join('/') : String(raw || '')
  if (!hermesApiPathAllowed(path)) { ctx.status = 404; ctx.body = { error: 'Not available through Studio' }; return }
  try {
    const query = new URLSearchParams(ctx.querystring)
    // Uploads (multipart) are left unparsed by Studio and streamed to Hermes as they are.
    const upload = ctx.is('multipart/form-data')
      ? { stream: ctx.req, contentType: String(ctx.get('content-type')), length: ctx.get('content-length') || undefined }
      : undefined
    const result = await hermesApi.request(ctx.method, path, query, ctx.request.body, ctx.state.profile?.name, upload)
    ctx.status = result.status
    ctx.type = result.contentType
    ctx.body = result.status >= 400 && result.contentType.includes('json') ? studioWording(result.body) : result.body
  } catch (error: any) {
    ctx.status = error?.status || 502
    ctx.body = { error: error?.message || String(error) }
  }
}
