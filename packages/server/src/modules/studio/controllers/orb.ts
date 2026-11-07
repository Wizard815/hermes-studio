import type { Context } from 'koa'
import { getOrbClient, OrbError } from '../services/orb/client'

function fail(ctx: Context, error: unknown) {
  ctx.status = error instanceof OrbError ? error.status : 500
  ctx.body = { error: error instanceof Error ? error.message : String(error) }
}

export async function status(ctx: Context) {
  try { ctx.body = await getOrbClient().status() } catch (error) { fail(ctx, error) }
}

export async function saveSettings(ctx: Context) {
  try { ctx.body = await getOrbClient().save((ctx.request.body || {}) as any) } catch (error) { fail(ctx, error) }
}

export async function data(ctx: Context) {
  try { ctx.body = { kind: ctx.params.kind, data: await getOrbClient().data(String(ctx.params.kind)) } } catch (error) { fail(ctx, error) }
}

export async function tool(ctx: Context) {
  try {
    const args = (ctx.request.body || {}) as Record<string, unknown>
    ctx.body = { result: await getOrbClient().tool(String(ctx.params.name), args && typeof args === 'object' ? args : {}) }
  } catch (error) { fail(ctx, error) }
}
