import type { Context } from 'koa'
import { getTestLab, TestLabError } from '../services/test-lab'

/** Test Lab (docs/test-lab.md): super admins only (routes/test-lab.ts). */

function fail(ctx: Context, error: unknown, fallback: string) {
  if (error instanceof TestLabError) {
    ctx.status = error.status
    ctx.body = { error: error.message, code: error.code }
    return
  }
  const status = (error as { status?: number })?.status
  ctx.status = typeof status === 'number' && status >= 400 && status < 600 ? status : 500
  ctx.body = { error: error instanceof Error && error.message ? `${fallback}: ${error.message}` : fallback }
}

const userId = (ctx: Context) => Number(ctx.state?.user?.id) || 0
const profile = (ctx: Context) => String(ctx.state?.profile?.name || 'default')

export async function status(ctx: Context) {
  try { ctx.body = await getTestLab().status(userId(ctx), profile(ctx)) } catch (error) { fail(ctx, error, 'Could not read Test Lab') }
}

export async function saveSettings(ctx: Context) {
  try { ctx.body = getTestLab().saveSettings(ctx.request.body) } catch (error) { fail(ctx, error, 'Could not save the settings') }
}

export async function listRuns(ctx: Context) {
  try { ctx.body = { runs: getTestLab().list() } } catch (error) { fail(ctx, error, 'Could not list the runs') }
}

export async function startRun(ctx: Context) {
  try {
    const body = (ctx.request.body || {}) as Record<string, unknown>
    ctx.body = await getTestLab().start(userId(ctx), {
      model: String(body.model || ''),
      apps: Array.isArray(body.apps) ? body.apps.map(String) : [],
      instructions: typeof body.instructions === 'string' ? body.instructions : undefined,
      capUsd: typeof body.capUsd === 'number' ? body.capUsd : undefined,
      minutes: typeof body.minutes === 'number' ? body.minutes : undefined,
      keepRunning: body.keepRunning === true,
      browser: body.browser !== false,
      builds: body.builds && typeof body.builds === 'object' ? Object.fromEntries(Object.entries(body.builds as Record<string, unknown>).map(([key, value]) => [key, String(value || '')])) : undefined,
    }, profile(ctx))
  } catch (error) { fail(ctx, error, 'Could not start the run') }
}

export async function getRun(ctx: Context) {
  try { ctx.body = getTestLab().detail(String(ctx.params.id)) } catch (error) { fail(ctx, error, 'Could not load the run') }
}

export async function stopRun(ctx: Context) {
  try { ctx.body = await getTestLab().stop(String(ctx.params.id), 'user') } catch (error) { fail(ctx, error, 'Could not stop the run') }
}

export async function removeRun(ctx: Context) {
  try { ctx.body = await getTestLab().remove(String(ctx.params.id)) } catch (error) { fail(ctx, error, 'Could not remove the containers') }
}

export async function screenshot(ctx: Context) {
  try {
    ctx.body = getTestLab().screenshot(String(ctx.params.id), String(ctx.params.name))
    ctx.type = 'image/png'
    ctx.set('Cache-Control', 'private, max-age=3600')
  } catch (error) { fail(ctx, error, 'Could not read the screenshot') }
}

export async function appLog(ctx: Context) {
  try {
    ctx.body = getTestLab().log(String(ctx.params.id), String(ctx.params.app))
    ctx.type = 'text/plain; charset=utf-8'
  } catch (error) { fail(ctx, error, 'Could not read the log') }
}

export async function download(ctx: Context) {
  try {
    const id = String(ctx.params.id)
    ctx.body = getTestLab().zip(id)
    ctx.type = 'application/zip'
    ctx.attachment(`test-lab-${id}.zip`)
  } catch (error) { fail(ctx, error, 'Could not pack the run') }
}
