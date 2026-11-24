import type { Context } from 'koa'
import { agentDetails, codexPlanLimits, commandCenterSettings, githubFeed, skillshareCli } from '../services/command-center'

function fail(ctx: Context, error: unknown) {
  const status = Number((error as { status?: number })?.status)
  ctx.status = status >= 400 && status < 600 ? status : 500
  ctx.body = { error: error instanceof Error ? error.message : String(error) }
}

const body = (ctx: Context) => ((ctx.request as any).body || {}) as Record<string, any>

export async function getSettings(ctx: Context) {
  try { ctx.body = await commandCenterSettings().load() } catch (error) { fail(ctx, error) }
}

export async function saveSettings(ctx: Context) {
  try { ctx.body = await commandCenterSettings().save(body(ctx)) } catch (error) { fail(ctx, error) }
}

export async function github(ctx: Context) {
  try {
    ctx.body = await githubFeed().inbox(await commandCenterSettings().load(), { refresh: ctx.query.refresh === '1' })
  } catch (error) { fail(ctx, error) }
}

export async function agents(ctx: Context) {
  try { ctx.body = await agentDetails(body(ctx)) } catch (error) { fail(ctx, error) }
}

export async function planLimits(ctx: Context) {
  try { ctx.body = { limits: [await codexPlanLimits()].filter(Boolean) } } catch (error) { fail(ctx, error) }
}

export async function skillshare(ctx: Context) {
  try { ctx.body = await skillshareCli().overview() } catch (error) { fail(ctx, error) }
}

export async function skillshareCheck(ctx: Context) {
  try { ctx.body = await skillshareCli().checkUpdates() } catch (error) { fail(ctx, error) }
}

/** Writes need `confirm: true`: the dock asks first. */
export function confirmed(ctx: Context): boolean {
  if (body(ctx).confirm === true) return true
  ctx.status = 400
  ctx.body = { error: 'Confirm first' }
  return false
}

export async function skillshareSync(ctx: Context) {
  if (!confirmed(ctx)) return
  try { ctx.body = await skillshareCli().sync() } catch (error) { fail(ctx, error) }
}

export async function skillshareUpdate(ctx: Context) {
  if (!confirmed(ctx)) return
  try { ctx.body = await skillshareCli().update(body(ctx)) } catch (error) { fail(ctx, error) }
}

export async function skillshareInstall(ctx: Context) {
  if (!confirmed(ctx)) return
  try { ctx.body = await skillshareCli().install(String(body(ctx).source || '')) } catch (error) { fail(ctx, error) }
}
