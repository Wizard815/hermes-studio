import type { Context } from 'koa'
import { listProfileNamesFromDisk } from '../public/profile-config'
import { chatImportService } from '../services/chat-import/service'
import { ChatImportError } from '../services/chat-import/types'

function owner(ctx: Context): string {
  return String(ctx.state?.user?.id ?? 'local')
}

function fail(ctx: Context, error: unknown, fallback: string) {
  if (error instanceof ChatImportError) {
    ctx.status = error.status
    ctx.body = { error: error.message, code: error.code }
    return
  }
  ctx.status = 500
  ctx.body = { error: error instanceof Error && error.message ? `${fallback}: ${error.message}` : fallback }
}

/** Scan a folder on the Studio server. */
export async function scanPath(ctx: Context) {
  try {
    const body = (ctx.request.body || {}) as { path?: unknown }
    ctx.body = await chatImportService.scanPath(String(body.path ?? ''), owner(ctx))
  } catch (error) { fail(ctx, error, 'Could not read that folder') }
}

/** Upload an archive as the raw request body; `?name=` carries its file name. */
export async function scanUpload(ctx: Context) {
  try {
    const declared = Number(ctx.get('content-length') || 0)
    if (declared > chatImportService.limits.maxUploadBytes) {
      throw new ChatImportError(`The upload is larger than ${Math.round(chatImportService.limits.maxUploadBytes / 1024 / 1024)} MB`, 413, 'chat_import_too_large')
    }
    ctx.body = await chatImportService.scanUpload(ctx.req, String(ctx.query.name || ''), owner(ctx))
  } catch (error) { fail(ctx, error, 'Could not read the upload') }
}

export async function getScan(ctx: Context) {
  try { ctx.body = chatImportService.getScan(String(ctx.params.id), owner(ctx)) } catch (error) { fail(ctx, error, 'Could not load the preview') }
}

export async function discardScan(ctx: Context) {
  try {
    await chatImportService.discardScan(String(ctx.params.id), owner(ctx))
    ctx.body = { ok: true }
  } catch (error) { fail(ctx, error, 'Could not discard the preview') }
}

export async function startImport(ctx: Context) {
  try {
    const body = (ctx.request.body || {}) as { keys?: unknown; profile?: unknown; categoryId?: unknown }
    const profile = String(body.profile || 'default')
    if (!listProfileNamesFromDisk().includes(profile)) throw new ChatImportError('That profile does not exist', 400, 'chat_import_profile_missing')
    const categoryId = body.categoryId == null || body.categoryId === '' ? null : Number(body.categoryId)
    if (categoryId !== null && (!Number.isSafeInteger(categoryId) || categoryId <= 0)) throw new ChatImportError('Pick a folder from the list')
    const keys = Array.isArray(body.keys) ? body.keys.map(String) : undefined
    ctx.body = chatImportService.startImport(String(ctx.params.id), owner(ctx), { keys, profile, categoryId })
  } catch (error) { fail(ctx, error, 'Could not start the import') }
}

export async function getJob(ctx: Context) {
  const job = chatImportService.getJob(String(ctx.params.id))
  if (!job) {
    ctx.status = 404
    ctx.body = { error: 'This import is no longer known. Check the chat list' }
    return
  }
  ctx.body = job
}
