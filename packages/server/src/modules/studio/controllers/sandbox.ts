import type { Context } from 'koa'
import { getSandbox, SandboxError } from '../services/sandbox'

/** Sandboxes (docs/sandbox.md): super admins only (routes/sandbox.ts). */

function fail(ctx: Context, error: unknown) {
  const status = error instanceof SandboxError ? error.status : (error as { status?: number })?.status
  ctx.status = typeof status === 'number' && status >= 400 && status < 600 ? status : 500
  ctx.body = { error: error instanceof Error && error.message ? error.message : 'The sandbox action failed' }
}

const body = (ctx: Context) => ((ctx.request.body && typeof ctx.request.body === 'object') ? ctx.request.body : {}) as Record<string, unknown>

export async function list(ctx: Context) {
  try { ctx.body = { sandboxes: await getSandbox().list() } } catch (error) { fail(ctx, error) }
}

export async function remove(ctx: Context) {
  try { ctx.body = await getSandbox().remove({ sandbox: ctx.params.id }) } catch (error) { fail(ctx, error) }
}

/** The agents' entry point (ekko_studio_use_sandbox): arguments are the action's fields. */
export async function tool(ctx: Context) {
  try { ctx.body = await getSandbox().tool(String(ctx.params.action || ''), body(ctx)) } catch (error) { fail(ctx, error) }
}
