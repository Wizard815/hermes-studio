import type { Context } from 'koa'
import { homedir } from 'node:os'
import { herdrManager } from '../services/herdr/manager'
import { SpaceGitCache } from '../services/herdr/space-git'

/**
 * Studio's herdr page: the Spaces sidebar (space folders). Folders are Studio's
 * chat folders; every change is also written to herdr-space-folders' file.
 */

function fail(ctx: Context, error: unknown, fallback: string) {
  const err = error as { status?: number; message?: string }
  ctx.status = err?.status && err.status >= 400 && err.status < 600 ? err.status : 400
  ctx.body = { error: err?.message || fallback }
}

const FOLDER_ID = /^c\d+$/
const text = (value: unknown, max: number): string | undefined => (typeof value === 'string' ? value.trim().slice(0, max) : undefined)
/** A folder id, '' (out of every folder) or null (rules decide). */
function target(value: unknown): string | null {
  if (value === null || value === undefined) return null
  const id = String(value)
  if (id !== '' && !FOLDER_ID.test(id)) throw Object.assign(new Error('Unknown folder'), { status: 400 })
  return id
}

export async function view(ctx: Context) {
  try { ctx.body = { ...(await herdrManager.spaceFolders().view()), home: homedir() } } catch (error) { fail(ctx, error, 'Failed to read space folders') }
}

export async function createFolder(ctx: Context) {
  try {
    const body = (ctx.request.body || {}) as Record<string, unknown>
    const name = text(body.name, 40)
    if (!name) throw Object.assign(new Error('Folder name is required'), { status: 400 })
    const parentId = text(body.parentId, 32)
    if (parentId && !FOLDER_ID.test(parentId)) throw Object.assign(new Error('Unknown parent folder'), { status: 400 })
    const id = await herdrManager.spaceFolders().createFolder({ name, parentId, color: text(body.color, 16), start: text(body.start, 1024), rules: text(body.rules, 1024) })
    ctx.body = { id }
  } catch (error) { fail(ctx, error, 'Failed to create folder') }
}

export async function updateFolder(ctx: Context) {
  try {
    const id = String(ctx.params.id || '')
    if (!FOLDER_ID.test(id)) throw Object.assign(new Error('Unknown folder'), { status: 404 })
    const body = (ctx.request.body || {}) as Record<string, unknown>
    await herdrManager.spaceFolders().updateFolder(id, {
      name: text(body.name, 40),
      color: text(body.color, 16),
      folded: typeof body.folded === 'boolean' ? body.folded : undefined,
      start: text(body.start, 1024),
      rules: text(body.rules, 1024),
    })
    ctx.body = { ok: true }
  } catch (error) { fail(ctx, error, 'Failed to change folder') }
}

export async function deleteFolder(ctx: Context) {
  try {
    const id = String(ctx.params.id || '')
    if (!FOLDER_ID.test(id)) throw Object.assign(new Error('Unknown folder'), { status: 404 })
    await herdrManager.spaceFolders().deleteFolder(id)
    ctx.body = { ok: true }
  } catch (error) { fail(ctx, error, 'Failed to delete folder') }
}

export async function orderFolders(ctx: Context) {
  try {
    const body = (ctx.request.body || {}) as { ids?: unknown; move?: { id?: unknown; parentId?: unknown } }
    const ids = (Array.isArray(body.ids) ? body.ids : []).map(String).filter(id => FOLDER_ID.test(id)).slice(0, 1000)
    const move = body.move && FOLDER_ID.test(String(body.move.id)) ? { id: String(body.move.id), parentId: String(body.move.parentId || '') } : undefined
    if (move && move.parentId && !FOLDER_ID.test(move.parentId)) throw Object.assign(new Error('Unknown parent folder'), { status: 400 })
    await herdrManager.spaceFolders().orderFolders(ids, move)
    ctx.body = { ok: true }
  } catch (error) { fail(ctx, error, 'Failed to move folder') }
}

export async function placeChat(ctx: Context) {
  try {
    const sessionId = String(ctx.params.sessionId || '')
    if (!/^[A-Za-z0-9:_-]{1,128}$/.test(sessionId)) throw Object.assign(new Error('Unknown chat'), { status: 404 })
    await herdrManager.spaceFolders().placeChat(sessionId, target((ctx.request.body as any)?.folderId))
    ctx.body = { ok: true }
  } catch (error) { fail(ctx, error, 'Failed to move chat') }
}

export async function placeSpace(ctx: Context) {
  try {
    const workspaceId = String(ctx.params.workspaceId || '')
    if (!/^[A-Za-z0-9:_-]{1,128}$/.test(workspaceId)) throw Object.assign(new Error('Unknown space'), { status: 404 })
    await herdrManager.spaceFolders().placeSpace(workspaceId, target((ctx.request.body as any)?.folderId))
    ctx.body = { ok: true }
  } catch (error) { fail(ctx, error, 'Failed to move space') }
}

/** A new herdr space in a folder's start folder, in that folder ("+" / New space here). */
export async function newSpaceInFolder(ctx: Context) {
  try {
    const id = String(ctx.params.id || '')
    const sync = herdrManager.spaceFolders()
    const folder = id ? (await sync.view()).folders.find(item => item.id === id) : undefined
    if (id && !folder) throw Object.assign(new Error('Unknown folder'), { status: 404 })
    const start = folder?.start || ''
    const cwd = start.startsWith('~') ? `${homedir()}${start.slice(1)}` : start
    const created = await herdrManager.requireBridge().createWorkspace({ cwd: cwd.startsWith('/') ? cwd : undefined, label: folder?.name })
    if (folder && created.workspaceId) await sync.placeSpace(created.workspaceId, folder.id)
    ctx.body = created
  } catch (error) { fail(ctx, error, 'Failed to create space') }
}

const gitCache = new SpaceGitCache()

/** Repo, branch and ahead/behind of the folders spaces work in. */
export async function spaceRepos(ctx: Context) {
  try {
    const body = (ctx.request.body || {}) as { cwds?: unknown }
    const cwds = (Array.isArray(body.cwds) ? body.cwds : []).filter((cwd): cwd is string => typeof cwd === 'string' && cwd.length < 4096)
    ctx.body = { repos: await gitCache.lookup(cwds) }
  } catch (error) { fail(ctx, error, 'Failed to read git') }
}
