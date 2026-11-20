import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * Space folders for Studio's herdr page, modelled on herdr-space-folders:
 * colored, foldable folders that hold herdr spaces (Studio chats), filled by
 * dragging or by rules on the folder a space works in. The folders themselves
 * are Studio's chat folders (session categories, id `c<category id>`); this
 * store keeps only what categories have no column for (color, folded, start
 * folder, rules, order) and what the sync with herdr-space-folders' own file
 * needs (see space-folder-file.ts).
 */
/** Tile colors by name (the palette herdr-space-folders uses); empty is neutral grey. */
export const FOLDER_COLORS = ['', 'teal', 'orange', 'blue', 'violet', 'green', 'pink'] as const

/** herdr-space-folders stores herdr's ANSI color names; Studio's names map 1:1. */
export const COLOR_TO_ANSI: Record<string, string> = { teal: 'ansi6', orange: 'ansi3', blue: 'ansi4', violet: 'ansi5', green: 'ansi2', pink: 'ansi1' }
export const ANSI_TO_COLOR: Record<string, string> = Object.fromEntries(Object.entries(COLOR_TO_ANSI).map(([name, ansi]) => [ansi, name]))

/** A color Studio keeps: one of FOLDER_COLORS, or a hex color another app chose (kept as is). */
export function sanitizeColor(value: unknown): string {
  const color = String(value ?? '').trim()
  if (ANSI_TO_COLOR[color]) return ANSI_TO_COLOR[color]
  if ((FOLDER_COLORS as readonly string[]).includes(color)) return color
  return /^#[0-9a-fA-F]{3,8}$/.test(color) ? color : ''
}

export interface SpaceFolder {
  id: string
  name: string
  /** One of FOLDER_COLORS, or a hex color. */
  color: string
  folded: boolean
  /** Folder new spaces in this folder start in. */
  start: string
  /** Comma-separated rules: a path (starts with / or ~) or a folder name at any depth; `*` is one name. */
  rules: string
}

/** What Studio last wrote to herdr-space-folders' file (the base of a three-way merge). */
export interface SyncedFile {
  at: number
  /** The folders as written, in order, with every field. */
  list: Array<Record<string, unknown>>
  of: Record<string, string>
}

export interface SpaceFolderState {
  /** Folder extras, in the order folders show (siblings keep this order). */
  list: SpaceFolder[]
  /**
   * Spaces that are not Studio chats (a plain shell made by a folder's +):
   * workspace id → folder id; "" means the user took it out of every folder.
   */
  of: Record<string, string>
  /** Chats the user took out of every folder (rules no longer collect them). */
  out?: string[]
  /** Folder ids another app made (`f…` in herdr-space-folders) → the `c<id>` Studio made for them. */
  alias?: Record<string, string>
  /** Per folder id: fields of herdr-space-folders' file Studio does not use, kept as they were. */
  extra?: Record<string, Record<string, unknown>>
  /** Top-level fields of the file Studio does not use. */
  fileExtra?: Record<string, unknown>
  synced?: SyncedFile | null
  /** When Studio's side last changed (ms). */
  at: number
}

const ID = /^[A-Za-z0-9_-]{1,64}$/
const SPACE_ID = /^[A-Za-z0-9:_-]{1,64}$/

export function emptyFolders(): SpaceFolderState {
  return { list: [], of: {}, out: [], alias: {}, extra: {}, fileExtra: {}, synced: null, at: 0 }
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

export function sanitizeFolders(input: unknown): SpaceFolderState {
  const raw = (isRecord(input) ? input : {}) as Partial<SpaceFolderState> & Record<string, unknown>
  const seen = new Set<string>()
  const list: SpaceFolder[] = []
  for (const item of Array.isArray(raw.list) ? raw.list.slice(0, 500) : []) {
    const folder = item as Partial<SpaceFolder>
    const id = String(folder?.id || '')
    if (!ID.test(id) || seen.has(id)) continue
    seen.add(id)
    list.push({
      id,
      name: String(folder.name || 'New folder').trim().slice(0, 80) || 'New folder',
      color: sanitizeColor(folder.color),
      folded: folder.folded === true,
      start: String(folder.start || '').trim().slice(0, 1024),
      rules: String(folder.rules || '').trim().slice(0, 1024),
    })
  }
  const of: Record<string, string> = {}
  for (const [space, folder] of Object.entries(isRecord(raw.of) ? raw.of : {}).slice(0, 2000)) {
    const target = String(folder ?? '')
    if (SPACE_ID.test(space) && (target === '' || seen.has(target))) of[space] = target
  }
  const out = [...new Set((Array.isArray(raw.out) ? raw.out : []).map(String).filter(id => SPACE_ID.test(id)))].slice(0, 20000)
  const alias: Record<string, string> = {}
  for (const [from, to] of Object.entries(isRecord(raw.alias) ? raw.alias : {}).slice(0, 2000)) {
    if (ID.test(from) && /^c\d+$/.test(String(to))) alias[from] = String(to)
  }
  const extra: Record<string, Record<string, unknown>> = {}
  for (const [id, fields] of Object.entries(isRecord(raw.extra) ? raw.extra : {}).slice(0, 2000)) {
    if (ID.test(id) && isRecord(fields)) extra[id] = fields
  }
  const synced = isRecord(raw.synced) && Array.isArray(raw.synced.list) && isRecord(raw.synced.of)
    ? {
        at: Number(raw.synced.at) || 0,
        list: (raw.synced.list as unknown[]).filter(isRecord),
        of: Object.fromEntries(Object.entries(raw.synced.of as Record<string, unknown>).map(([k, v]) => [k, String(v ?? '')])),
      }
    : null
  return {
    list,
    of,
    out,
    alias,
    extra,
    fileExtra: isRecord(raw.fileExtra) ? raw.fileExtra : {},
    synced,
    at: Number.isFinite(Number(raw.at)) ? Number(raw.at) : Date.now(),
  }
}

function normalizePath(path: string, home: string): string {
  const expanded = path.startsWith('~') ? `${home}${path.slice(1)}` : path
  return expanded.replace(/\\/g, '/').replace(/\/+$/, '')
}

function segmentMatches(rule: string, segment: string): boolean {
  if (rule === '*') return true
  if (!rule.includes('*')) return rule === segment
  const pattern = new RegExp(`^${rule.split('*').map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}$`)
  return pattern.test(segment)
}

/**
 * How deep a rule matches a working folder, or -1. Paths match as prefixes
 * (`~/code` takes everything under it); plain names match a folder name at any
 * depth (`client-*`). Deeper matches win so `~/code/client` beats `~/code`.
 */
export function ruleDepth(rule: string, cwd: string, home: string): number {
  const value = rule.trim()
  if (!value || !cwd) return -1
  const parts = normalizePath(cwd, home).split('/').filter(Boolean)
  if (value.startsWith('/') || value.startsWith('~')) {
    const ruleParts = normalizePath(value, home).split('/').filter(Boolean)
    if (ruleParts.length > parts.length) return -1
    return ruleParts.every((part, index) => segmentMatches(part, parts[index])) ? ruleParts.length : -1
  }
  const index = parts.findIndex(part => segmentMatches(value, part))
  return index >= 0 ? index + 1 : -1
}

/**
 * A folder's rules: its own, or its start folder while it has none (the edit
 * dialog fills the rules from the start folder, as herdr-space-folders does).
 */
export function effectiveRules(folder: Pick<SpaceFolder, 'rules' | 'start'>): string {
  return folder.rules.trim() || folder.start.trim()
}

/** The folder whose rules reach deepest into `cwd`, the first one on a tie; '' for none. */
export function deepestFolder(list: Array<Pick<SpaceFolder, 'id' | 'rules' | 'start'>>, cwd: string, home: string): string {
  let best = ''
  let bestDepth = 0
  for (const folder of list) {
    for (const rule of effectiveRules(folder).split(',')) {
      const depth = ruleDepth(rule, cwd, home)
      if (depth > bestDepth) { best = folder.id; bestDepth = depth }
    }
  }
  return best
}

/**
 * The folder a space belongs in: explicit placement first, then the deepest
 * match of a folder's rules (or its start folder, while it has no rules).
 */
export function folderFor(state: SpaceFolderState, spaceId: string, cwd: string, home: string): string {
  if (Object.prototype.hasOwnProperty.call(state.of, spaceId)) return state.of[spaceId]
  return deepestFolder(state.list, cwd, home)
}

export class SpaceFolderStore {
  constructor(private readonly file: string) {}

  async load(): Promise<SpaceFolderState> {
    try { return sanitizeFolders(JSON.parse(await readFile(this.file, 'utf8'))) } catch { return emptyFolders() }
  }

  /** Saves the state; `keepAt` keeps its `at` (the time of the change it holds). */
  async save(input: unknown, options: { keepAt?: boolean } = {}): Promise<SpaceFolderState> {
    const clean = sanitizeFolders(input)
    const state = { ...clean, at: options.keepAt ? clean.at : Date.now() }
    await mkdir(dirname(this.file), { recursive: true })
    const temp = `${this.file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`
    await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`)
    await rename(temp, this.file)
    return state
  }
}
