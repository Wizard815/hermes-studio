import type { Context } from 'koa'
import { join } from 'node:path'
import { getWebUiHome } from '../public/config'
import { androidDeviceManager } from '../services/android/manager'

function fail(ctx: Context, error: unknown, fallback: string) {
  const err = error as { status?: number; message?: string }
  ctx.status = err?.status && err.status >= 400 && err.status < 600 ? err.status : 500
  ctx.body = { error: err?.message || fallback }
}

const body = (ctx: Context) => (ctx.request.body || {}) as Record<string, unknown>
const text = (value: unknown) => (typeof value === 'string' ? value : '')

export async function status(ctx: Context) {
  try { ctx.body = await androidDeviceManager.status() } catch (error) { fail(ctx, error, 'Failed to read Android devices') }
}

export async function updateSettings(ctx: Context) {
  try { ctx.body = { settings: await androidDeviceManager.updateSettings(body(ctx)) } } catch (error) { fail(ctx, error, 'Failed to save Android settings') }
}

export async function connect(ctx: Context) {
  try { ctx.body = await androidDeviceManager.connect(text(body(ctx).endpoint)) } catch (error) { fail(ctx, error, 'Failed to connect') }
}

export async function pair(ctx: Context) {
  try { ctx.body = await androidDeviceManager.pair(text(body(ctx).endpoint), text(body(ctx).code)) } catch (error) { fail(ctx, error, 'Failed to pair') }
}

export async function disconnect(ctx: Context) {
  try {
    await androidDeviceManager.disconnect(String(ctx.params.serial || ''))
    ctx.body = { ok: true }
  } catch (error) { fail(ctx, error, 'Failed to disconnect') }
}

export async function startAvd(ctx: Context) {
  try {
    ctx.body = await androidDeviceManager.startAvd(String(ctx.params.name || ''), join(getWebUiHome(), 'android', 'logs'))
  } catch (error) { fail(ctx, error, 'Failed to start the emulator') }
}

export async function stopEmulator(ctx: Context) {
  try {
    await androidDeviceManager.stopEmulator(String(ctx.params.serial || ''))
    ctx.body = { ok: true }
  } catch (error) { fail(ctx, error, 'Failed to stop the emulator') }
}

export async function installApk(ctx: Context) {
  try {
    ctx.body = await androidDeviceManager.installApk(String(ctx.params.serial || ''), text(body(ctx).path))
  } catch (error) { fail(ctx, error, 'Failed to install the APK') }
}

export async function launch(ctx: Context) {
  try {
    await androidDeviceManager.launch(String(ctx.params.serial || ''), text(body(ctx).packageName))
    ctx.body = { ok: true }
  } catch (error) { fail(ctx, error, 'Failed to open the app') }
}

export async function gesture(ctx: Context) {
  try {
    await androidDeviceManager.gesture(String(ctx.params.serial || ''), body(ctx) as any)
    ctx.body = { ok: true }
  } catch (error) { fail(ctx, error, 'Failed to send input') }
}

export async function screenshot(ctx: Context) {
  try {
    ctx.set('cache-control', 'no-store')
    ctx.type = 'image/png'
    ctx.body = await androidDeviceManager.screenshot(String(ctx.params.serial || ''))
  } catch (error) { fail(ctx, error, 'Failed to take a screenshot') }
}
