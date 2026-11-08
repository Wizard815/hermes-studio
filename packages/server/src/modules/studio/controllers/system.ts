import type { Context } from 'koa'
import { dockerClient, type DockerAction } from '../services/system/docker'
import { signalProcess, systemSnapshot, type ProcessSignal } from '../services/system/monitor'

function fail(ctx: Context, error: unknown, fallback: string) {
  const err = error as { status?: number; message?: string }
  ctx.status = err?.status && err.status >= 400 && err.status < 600 ? err.status : 500
  ctx.body = { error: err?.message || fallback }
}

export async function snapshot(ctx: Context) {
  try {
    ctx.set('cache-control', 'no-store')
    ctx.body = await systemSnapshot()
  } catch (error) { fail(ctx, error, 'Failed to read system usage') }
}

export async function signal(ctx: Context) {
  try {
    const body = (ctx.request.body || {}) as { signal?: unknown }
    signalProcess(Number(ctx.params.pid), (body.signal === 'SIGKILL' ? 'SIGKILL' : 'SIGTERM') as ProcessSignal)
    ctx.body = { ok: true }
  } catch (error) { fail(ctx, error, 'Failed to end the process') }
}

export async function dockerStatus(ctx: Context) {
  try {
    const status = await dockerClient.status()
    ctx.body = { ...status, containers: status.available ? await dockerClient.containers() : [] }
  } catch (error) { fail(ctx, error, 'Failed to read Docker') }
}

export async function dockerAction(ctx: Context) {
  try {
    await dockerClient.action(String(ctx.params.id || ''), String(ctx.params.action || '') as DockerAction)
    ctx.body = { ok: true }
  } catch (error) { fail(ctx, error, 'Docker could not do that') }
}

export async function dockerLogs(ctx: Context) {
  try {
    ctx.body = { logs: await dockerClient.logs(String(ctx.params.id || ''), Number(ctx.query.tail) || 200) }
  } catch (error) { fail(ctx, error, 'Failed to read container logs') }
}
