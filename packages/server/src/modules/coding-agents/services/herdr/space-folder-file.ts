import { ANSI_TO_COLOR, COLOR_TO_ANSI, sanitizeColor, type SpaceFolderState } from './folders'

/**
 * Two-way sync between Studio's chat folders and herdr-space-folders' file
 * (`~/.config/herdr-space-folders.json` on the machine herdr runs on), so
 * Herdr App with the Space Folders mod shows the same folders as Studio.
 *
 * The file is `{ list: [{ id, name, color, path, match, folded, ... }],
 * of: { spaceId: folderId }, at }` (see the mod's `saveFolders`): folders in
 * order, which space went in which folder ("" = taken out of every folder),
 * and when it was written. Studio writes its folders there as `c<category id>`.
 *
 * Studio's folders nest; the mod's are flat. A nested folder is written as its
 * own folder right after its parent, named with its path ("Clients / Acme").
 * Renaming it in the mod renames the last part; a folder made in the mod is a
 * top-level Studio folder.
 *
 * Merging is three-way: what Studio last wrote (`synced`) is the base, so only
 * what changed in the file is applied, field by field. When both sides changed
 * the same thing, the newer side wins (`file.at` against Studio's `at`).
 * Fields and folders Studio does not know are kept as they were.
 *
 * Everything here is pure; space-folder-sync.ts reads and writes the files.
 */

export interface StudioCategory { id: number; name: string; parent_id: number | null }
/** A Studio chat: its folder and, while it is awake, its herdr space. */
export interface StudioChat { id: string; categoryId: number | null; workspaceId: string | null }

export interface StudioSide {
  categories: StudioCategory[]
  meta: SpaceFolderState
  chats: StudioChat[]
}

/** The file without its `at`. */
export interface FileBody {
  list: Array<Record<string, unknown>>
  of: Record<string, string>
  [key: string]: unknown
}

export interface FileDoc {
  list: Array<Record<string, unknown>>
  of: Record<string, string>
  at: number
  [key: string]: unknown
}

/** The folder fields of the file Studio maps; anything else is kept as it was. */
export const KNOWN_FOLDER_FIELDS = ['id', 'name', 'color', 'path', 'match', 'folded'] as const
const MERGED_FIELDS = ['name', 'color', 'path', 'match', 'folded'] as const
type MergedField = typeof MERGED_FIELDS[number]

/** Studio's names are at most this long (session categories). */
export const NAME_MAX = 40
/** How a nested folder's path is written in the mod's flat list. */
export const PATH_SEPARATOR = ' / '

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const FOLDER_ID = /^[A-Za-z0-9_-]{1,64}$/
const SPACE_ID = /^[A-Za-z0-9:_-]{1,128}$/

/** The file's text as a document, or null when it is not one (missing, half written, garbage). */
export function parseFile(text: string | null | undefined): FileDoc | null {
  if (!text || !text.trim()) return null
  try {
    const raw = JSON.parse(text) as unknown
    if (!isRecord(raw)) return null
    const list = (Array.isArray(raw.list) ? raw.list : []).filter((item): item is Record<string, unknown> => isRecord(item) && typeof item.id === 'string' && FOLDER_ID.test(item.id))
    const of: Record<string, string> = {}
    for (const [space, folder] of Object.entries(isRecord(raw.of) ? raw.of : {})) {
      if (SPACE_ID.test(space) && typeof folder === 'string') of[space] = folder
    }
    return { ...raw, list, of, at: Number(raw.at) || 0 }
  } catch {
    return null
  }
}

/** Studio's folders in the order they show: parents before children, siblings in the saved order (else by name). */
export function orderedCategories(categories: StudioCategory[], meta: Pick<SpaceFolderState, 'list'>): Array<{ category: StudioCategory; depth: number; path: string[] }> {
  const ids = new Set(categories.map(category => category.id))
  const rank = new Map(meta.list.map((folder, index) => [folder.id, index]))
  const children = new Map<number | null, StudioCategory[]>()
  for (const category of categories) {
    const parent = category.parent_id != null && ids.has(category.parent_id) ? category.parent_id : null
    children.set(parent, [...(children.get(parent) || []), category])
  }
  const out: Array<{ category: StudioCategory; depth: number; path: string[] }> = []
  const seen = new Set<number>()
  const walk = (parent: number | null, depth: number, path: string[]) => {
    const list = (children.get(parent) || []).slice().sort((a, b) => {
      const ra = rank.get(`c${a.id}`) ?? Infinity
      const rb = rank.get(`c${b.id}`) ?? Infinity
      if (ra !== rb) return ra - rb
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.id - b.id
    })
    for (const category of list) {
      if (seen.has(category.id)) continue
      seen.add(category.id)
      const next = [...path, category.name]
      out.push({ category, depth, path: next })
      if (depth < 10) walk(category.id, depth + 1, next)
    }
  }
  walk(null, 0, [])
  return out
}

/** A Studio color as the mod stores it. */
export function fileColor(color: string): string | null {
  if (!color) return null
  return COLOR_TO_ANSI[color] ?? color
}

/** Studio's side as the file should say it (without `at`). Unknown fields come from `meta.extra`/`meta.fileExtra`. */
export function buildFile(studio: StudioSide): FileBody {
  const { meta } = studio
  const extras = new Map(meta.list.map(folder => [folder.id, folder]))
  const list = orderedCategories(studio.categories, meta).map(({ category, path }) => {
    const id = `c${category.id}`
    const folder = extras.get(id)
    const start = folder?.start || ''
    const rules = folder?.rules || ''
    return {
      ...(meta.extra?.[id] || {}),
      id,
      name: path.join(PATH_SEPARATOR),
      color: fileColor(folder?.color || ''),
      path: start || null,
      // The mod collects by `match` only; Studio also files by the start folder while a folder has no rules.
      match: rules || start || null,
      folded: folder?.folded === true,
    }
  })
  const known = new Set(list.map(folder => folder.id as string))
  const of: Record<string, string> = {}
  const chatSpaces = new Set<string>()
  const out = new Set(meta.out || [])
  for (const chat of studio.chats) {
    if (!chat.workspaceId) continue
    chatSpaces.add(chat.workspaceId)
    if (chat.categoryId != null && known.has(`c${chat.categoryId}`)) of[chat.workspaceId] = `c${chat.categoryId}`
    else if (out.has(chat.id)) of[chat.workspaceId] = ''
  }
  for (const [space, folder] of Object.entries(meta.of || {})) {
    if (chatSpaces.has(space)) continue
    if (folder === '' || known.has(folder)) of[space] = folder
  }
  return { ...(meta.fileExtra || {}), list, of }
}

/** Two documents say the same (`at` aside). */
export function sameFile(a: FileBody | null, b: FileBody | null): boolean {
  if (!a || !b) return a === b
  const strip = (doc: FileBody) => JSON.stringify(canonical({ ...doc, at: undefined }))
  return strip(a) === strip(b)
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (!isRecord(value)) return value
  return Object.fromEntries(Object.keys(value).filter(key => value[key] !== undefined).sort().map(key => [key, canonical(value[key])]))
}

/** One field as compared: colors by Studio name, empty and missing alike. */
function norm(field: MergedField, value: unknown): string {
  if (field === 'folded') return value === true ? 'true' : 'false'
  if (field === 'color') return sanitizeColor(value)
  return value == null ? '' : String(value).trim()
}

export type SyncOp =
  | { kind: 'create'; fileId: string; name: string; color: string; folded: boolean; start: string; rules: string; extra: Record<string, unknown> }
  | { kind: 'update'; folderId: string; patch: Partial<{ name: string; color: string; folded: boolean; start: string; rules: string }> }
  | { kind: 'extra'; folderId: string; extra: Record<string, unknown> }
  | { kind: 'delete'; folderId: string }
  /** Folder ids (`c<id>`, or `new:<file id>` for folders being made) in the file's order. */
  | { kind: 'order'; ids: string[] }
  /** folderId: a folder id, '' for taken out of every folder, null for none (rules decide). */
  | { kind: 'placeChat'; sessionId: string; folderId: string | null }
  | { kind: 'placeSpace'; workspaceId: string; folderId: string | null }
  | { kind: 'fileExtra'; value: Record<string, unknown> }

/** Unknown fields of a folder in the file. */
export function folderExtra(entry: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(entry).filter(([key]) => !(KNOWN_FOLDER_FIELDS as readonly string[]).includes(key)))
}

/** The last part of a nested folder's name, as written in the file. */
export function leafName(written: string, parentPath: string[]): string {
  const prefix = parentPath.length ? `${parentPath.join(PATH_SEPARATOR)}${PATH_SEPARATOR}` : ''
  const name = prefix && written.startsWith(prefix) ? written.slice(prefix.length) : written
  return name.trim().replace(/\s+/g, ' ').slice(0, NAME_MAX).trim()
}

/** A folder made in the mod, as Studio makes it. */
function created(entry: Record<string, unknown>): SyncOp {
  const start = norm('path', entry.path)
  const match = norm('match', entry.match)
  return {
    kind: 'create',
    fileId: entry.id as string,
    name: (norm('name', entry.name).replace(/\s+/g, ' ').slice(0, NAME_MAX).trim()) || 'New folder',
    color: sanitizeColor(entry.color),
    folded: entry.folded === true,
    start,
    rules: match === start ? '' : match,
    extra: folderExtra(entry),
  }
}

/**
 * What to change in Studio so it matches the file's changes since Studio last
 * wrote it. `fileWins` decides conflicts (both sides changed the same thing):
 * true when the file was written after Studio's last change. With no base
 * (the first sync), the file's folders and placements are added and Studio
 * wins every conflict.
 */
export function fileChanges(file: FileDoc, studio: StudioSide): SyncOp[] {
  const { meta } = studio
  const base = meta.synced || null
  const fileWins = !!base && file.at > meta.at
  const desired = buildFile(studio)
  const ordered = orderedCategories(studio.categories, meta)
  const existing = new Set(ordered.map(item => `c${item.category.id}`))
  const parentPath = new Map(ordered.map(item => [`c${item.category.id}`, item.path.slice(0, -1)]))
  const studioEntry = new Map(desired.list.map(entry => [entry.id as string, entry]))
  const baseEntry = new Map((base?.list || []).map(entry => [String(entry.id), entry]))
  const alias = meta.alias || {}
  const fileIds = new Set(file.list.map(entry => entry.id as string))

  const resolve = (id: string | undefined): string | null => {
    if (id === undefined) return null
    if (id === '') return ''
    if (existing.has(id)) return id
    if (alias[id] && existing.has(alias[id])) return alias[id]
    if (fileIds.has(id)) return `new:${id}`
    return null
  }

  const ops: SyncOp[] = []
  const claimed = new Set<string>()
  for (const entry of file.list) {
    const id = entry.id as string
    const target = resolve(id)
    if (!target || target.startsWith('new:') || claimed.has(target)) {
      if (target && !target.startsWith('new:')) continue // a second entry for the same folder
      ops.push(created(entry))
      continue
    }
    claimed.add(target)
    const was = baseEntry.get(target) ?? baseEntry.get(id)
    const now = studioEntry.get(target)!
    const patch: Extract<SyncOp, { kind: 'update' }>['patch'] = {}
    for (const field of MERGED_FIELDS) {
      const fv = norm(field, entry[field])
      const sv = norm(field, now[field])
      if (fv === sv) continue
      if (was) {
        const bv = norm(field, was[field])
        if (fv === bv) continue // only Studio changed it
        if (sv !== bv && !fileWins) continue // both changed it: Studio is newer
      } else if (!fileWins) {
        continue // first sync: Studio's folder stays as it is
      }
      if (field === 'name') {
        const name = leafName(fv, parentPath.get(target) || [])
        if (name) patch.name = name
      } else if (field === 'color') patch.color = sanitizeColor(entry.color)
      else if (field === 'folded') patch.folded = entry.folded === true
      else if (field === 'path') patch.start = fv
      else if (field === 'match') patch.rules = fv
    }
    // The mod's dialog mirrors the start folder into the rules: that is "no rules of its own".
    if (patch.rules !== undefined && patch.rules === (patch.start ?? norm('path', entry.path))) patch.rules = ''
    if (Object.keys(patch).length) ops.push({ kind: 'update', folderId: target, patch })
    const extra = folderExtra(entry)
    if (JSON.stringify(canonical(extra)) !== JSON.stringify(canonical(meta.extra?.[target] || {}))) ops.push({ kind: 'extra', folderId: target, extra })
  }

  // Folders Studio wrote that the file no longer has: deleted in the mod.
  const deleted = new Set<string>()
  if (base) {
    for (const entry of base.list) {
      const id = String(entry.id)
      if (!existing.has(id) || claimed.has(id)) continue
      // Changed in Studio since (renamed, recolored) and the file is older: keep it.
      const now = studioEntry.get(id)
      const changed = now && MERGED_FIELDS.some(field => norm(field, now[field]) !== norm(field, entry[field]))
      if (changed && !fileWins) continue
      deleted.add(id)
      ops.push({ kind: 'delete', folderId: id })
    }
  }

  // Folder order.
  const fileOrder = file.list.map(entry => resolve(entry.id as string)).filter((id): id is string => !!id && !deleted.has(id))
  const uniqueOrder = [...new Set(fileOrder)]
  const baseOrder = (base?.list || []).map(entry => String(entry.id)).filter(id => uniqueOrder.includes(id))
  const studioOrder = desired.list.map(entry => entry.id as string)
  const fileKnownOrder = uniqueOrder.filter(id => !id.startsWith('new:'))
  if (base && fileKnownOrder.join() !== baseOrder.join()) {
    const studioMoved = studioOrder.filter(id => baseOrder.includes(id)).join() !== baseOrder.join()
    if (!studioMoved || fileWins) ops.push({ kind: 'order', ids: uniqueOrder })
  } else if (uniqueOrder.some(id => id.startsWith('new:'))) {
    ops.push({ kind: 'order', ids: [...studioOrder.filter(id => !deleted.has(id) && !uniqueOrder.includes(id)), ...uniqueOrder].filter((id, index, all) => all.indexOf(id) === index) })
  }

  // Which space is in which folder.
  const chatOf = new Map(studio.chats.filter(chat => chat.workspaceId).map(chat => [chat.workspaceId as string, chat.id]))
  const spaces = new Set([...Object.keys(file.of), ...Object.keys(base?.of || {})])
  for (const space of spaces) {
    const fv = file.of[space]
    const bv = base?.of[space]
    if (fv === bv) continue
    const was = resolve(bv)
    // Its folder was deleted: Studio moves its chats up a level itself.
    if (fv === undefined && was && deleted.has(was)) continue
    const next = fv === undefined ? null : resolve(fv)
    // A placement in a folder nobody knows: ignore it (it is kept in the file).
    if (fv !== undefined && fv !== '' && next === null) continue
    const sv = desired.of[space]
    const studioValue = sv === undefined ? null : sv
    if (studioValue === next) continue
    if (base ? sv !== bv && !fileWins : sv !== undefined) continue // both changed it: newer wins; first sync: Studio wins
    const sessionId = chatOf.get(space)
    if (sessionId) ops.push({ kind: 'placeChat', sessionId, folderId: next })
    else ops.push({ kind: 'placeSpace', workspaceId: space, folderId: next })
  }

  const extraTop = Object.fromEntries(Object.entries(file).filter(([key]) => key !== 'list' && key !== 'of' && key !== 'at'))
  if (JSON.stringify(canonical(extraTop)) !== JSON.stringify(canonical(meta.fileExtra || {}))) ops.push({ kind: 'fileExtra', value: extraTop })
  return ops
}

/** A folder id in the file (an alias Studio gave a folder made in the mod) as Studio's own. */
export function aliasOf(meta: Pick<SpaceFolderState, 'alias'>, id: string): string {
  return meta.alias?.[id] || id
}

export { ANSI_TO_COLOR, COLOR_TO_ANSI }
