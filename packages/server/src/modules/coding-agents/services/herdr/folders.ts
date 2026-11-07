import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * Space folders for the Mission view, modelled on herdr-space-folders: colored,
 * foldable folders that hold herdr workspaces, filled by dragging or by rules
 * on the folder a workspace's agents work in.
 */
/** Tile colors by name (the palette herdr-space-folders uses); empty is neutral grey. */
export const FOLDER_COLORS = ['', 'teal', 'orange', 'blue', 'violet', 'green', 'pink'] as const

export interface SpaceFolder {
  id: string
  name: string
  /** One of FOLDER_COLORS. */
  color: string
  folded: boolean
  /** Folder new spaces in this folder start in. */
  start: string
  /** Comma-separated rules: a path (starts with / or ~) or a folder name at any depth; `*` is one name. */
  rules: string
}

export interface SpaceFolderState {
  list: SpaceFolder[]
  /** workspace id → folder id; "" means the user took it out of every folder. */
  of: Record<string, string>
  at: number
}

const ID = /^[A-Za-z0-9_-]{1,64}$/
const SPACE_ID = /^[A-Za-z0-9:_-]{1,64}$/

export function emptyFolders(): SpaceFolderState {
  return { list: [], of: {}, at: 0 }
}

export function sanitizeFolders(input: unknown): SpaceFolderState {
  const raw = (input && typeof input === 'object' ? input : {}) as Partial<SpaceFolderState>
  const seen = new Set<string>()
  const list: SpaceFolder[] = []
  for (const item of Array.isArray(raw.list) ? raw.list.slice(0, 200) : []) {
    const folder = item as Partial<SpaceFolder>
    const id = String(folder?.id || '')
    if (!ID.test(id) || seen.has(id)) continue
    seen.add(id)
    const color = String(folder.color || '')
    list.push({
      id,
      name: String(folder.name || 'New folder').trim().slice(0, 80) || 'New folder',
      color: (FOLDER_COLORS as readonly string[]).includes(color) ? color : '',
      folded: folder.folded === true,
      start: String(folder.start || '').trim().slice(0, 1024),
      rules: String(folder.rules || '').trim().slice(0, 1024),
    })
  }
  const of: Record<string, string> = {}
  for (const [space, folder] of Object.entries(raw.of && typeof raw.of === 'object' ? raw.of : {}).slice(0, 2000)) {
    const target = String(folder ?? '')
    if (SPACE_ID.test(space) && (target === '' || seen.has(target))) of[space] = target
  }
  return { list, of, at: Number.isFinite(Number(raw.at)) ? Number(raw.at) : Date.now() }
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

/** The folder a space belongs in: explicit placement first, then the deepest rule. */
export function folderFor(state: SpaceFolderState, spaceId: string, cwd: string, home: string): string {
  if (Object.prototype.hasOwnProperty.call(state.of, spaceId)) return state.of[spaceId]
  let best = ''
  let bestDepth = 0
  for (const folder of state.list) {
    for (const rule of folder.rules.split(',')) {
      const depth = ruleDepth(rule, cwd, home)
      if (depth > bestDepth) { best = folder.id; bestDepth = depth }
    }
  }
  return best
}

export class SpaceFolderStore {
  constructor(private readonly file: string) {}

  async load(): Promise<SpaceFolderState> {
    try { return sanitizeFolders(JSON.parse(await readFile(this.file, 'utf8'))) } catch { return emptyFolders() }
  }

  async save(input: unknown): Promise<SpaceFolderState> {
    const state = { ...sanitizeFolders(input), at: Date.now() }
    await mkdir(dirname(this.file), { recursive: true })
    const temp = `${this.file}.${process.pid}.tmp`
    await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`)
    await rename(temp, this.file)
    return state
  }
}
