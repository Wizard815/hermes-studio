import type { Context } from 'koa'
import { getLlmWiki } from '../services/llm-wiki'

function fail(ctx: Context, error: unknown) {
  const status = Number((error as { status?: number })?.status)
  ctx.status = status >= 400 && status < 600 ? status : 500
  ctx.body = { error: error instanceof Error ? error.message : String(error) }
}

const body = (ctx: Context) => ((ctx.request as { body?: unknown }).body || {}) as Record<string, unknown>

export async function status(ctx: Context) {
  try { ctx.body = await getLlmWiki().status() } catch (error) { fail(ctx, error) }
}

/** Save one profile's settings. A token in the body goes to the profile's .env and is never sent back. */
export async function saveProfile(ctx: Context) {
  try { ctx.body = await getLlmWiki().save(ctx.params.profile, body(ctx)) } catch (error) { fail(ctx, error) }
}

export async function testProfile(ctx: Context) {
  try { ctx.body = await getLlmWiki().test(ctx.params.profile, body(ctx)) } catch (error) { fail(ctx, error) }
}
