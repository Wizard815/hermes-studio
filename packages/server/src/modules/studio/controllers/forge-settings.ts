import type { Context } from 'koa'
import { ForgeSettingsError, getForgeSettings } from '../services/forge-settings'

/** Settings → Git forges (docs/forge.md). Super admins only (routes/forge-settings.ts). */

function fail(ctx: Context, error: unknown) {
  ctx.status = error instanceof ForgeSettingsError ? error.status : 500
  ctx.body = { error: error instanceof Error && error.message ? error.message : 'The forge settings could not be saved' }
}

const body = (ctx: Context) => ((ctx.request.body && typeof ctx.request.body === 'object') ? ctx.request.body : {}) as Record<string, any>

export async function read(ctx: Context) {
  try { ctx.body = await getForgeSettings().read() } catch (error) { fail(ctx, error) }
}

export async function save(ctx: Context) {
  try { ctx.body = await getForgeSettings().save(body(ctx)) } catch (error) { fail(ctx, error) }
}

export async function test(ctx: Context) {
  try { ctx.body = await getForgeSettings().test(body(ctx)) } catch (error) { fail(ctx, error) }
}
