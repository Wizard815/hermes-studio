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

/** /api/hermes-agent/<path>: one call to Hermes's API, as the active profile. */
export async function forward(ctx: Context) {
  const raw = (ctx.params as any).path
  const path = Array.isArray(raw) ? raw.join('/') : String(raw || '')
  if (!hermesApiPathAllowed(path)) { ctx.status = 404; ctx.body = { error: 'Not available through Studio' }; return }
  try {
    const query = new URLSearchParams(ctx.querystring)
    const result = await hermesApi.request(ctx.method, path, query, ctx.request.body, ctx.state.profile?.name)
    ctx.status = result.status
    ctx.type = result.contentType
    ctx.body = result.body
  } catch (error: any) {
    ctx.status = error?.status || 502
    ctx.body = { error: error?.message || String(error) }
  }
}
