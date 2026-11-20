import { watch, type FSWatcher } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { sanitizeColor, type SpaceFolder, type SpaceFolderState, type SpaceFolderStore } from './folders'
import { buildFile, fileChanges, orderedCategories, parseFile, sameFile, type FileDoc, type StudioCategory, type StudioChat, type SyncOp } from './space-folder-file'

/**
 * Keeps Studio's chat folders and herdr-space-folders' file in sync (the file
 * Herdr App's Space Folders mod reads, on the machine herdr runs on), and is
 * where Studio's herdr page changes folders: every change is saved, then
 * written to the file at once. The file is watched (and looked at every few
 * seconds) for changes Herdr App makes.
 */

/** herdr-space-folders' file, in the home of the machine herdr runs on. */
export function spaceFoldersFile(env: NodeJS.ProcessEnv = process.env): string | null {
  const override = env.HERMES_HERDR_SPACE_FOLDERS_FILE
  if (override !== undefined) return override && override !== 'off' ? override : null
  const home = env.HOME || env.USERPROFILE
  return home ? join(home, '.config', 'herdr-space-folders.json') : null
}

export interface SpaceFolderChat extends StudioChat {
  title: string
  agent: string
  workspace: string | null
  lastActive: number
}

export interface SpaceFolderSyncDeps {
  /** herdr-space-folders' file; null turns the file sync off (folders still work in Studio). */
  file: string | null
  store: SpaceFolderStore
  categories: () => StudioCategory[]
  chats: () => SpaceFolderChat[]
  createCategory: (name: string, parentId: number | null) => { id: number }
  renameCategory: (id: number, name: string) => void
  moveCategory: (id: number, parentId: number | null) => void
  deleteCategory: (id: number) => void
  setChatCategory: (sessionId: string, categoryId: number | null) => void
  /** Folders or chats' folders changed (clients reload their view). */
  changed: () => void
  log?: (level: 'info' | 'warn', message: string, data?: Record<string, unknown>) => void
  /** Whether the file is synced now (herdr turned on). */
  enabled?: () => boolean
  /** How often the file is looked at besides watching it (ms). */
  pollMs?: number
  now?: () => number
}

export interface SpaceFolderView {
  folders: Array<SpaceFolder & { categoryId: number; parentId: string; depth: number }>
  chats: Array<Omit<SpaceFolderChat, 'categoryId'> & { folderId: string; out: boolean }>
  /** Placements of spaces that are no Studio chat (workspace id → folder id, '' = out). */
  spaces: Record<string, string>
  file: { path: string; at: number } | null
}

const categoryIdOf = (folderId: string): number | null => (/^c\d+$/.test(folderId) ? Number(folderId.slice(1)) : null)

function ensureEntry(meta: SpaceFolderState, id: string): SpaceFolder {
  let entry = meta.list.find(folder => folder.id === id)
  if (!entry) {
    entry = { id, name: '', color: '', folded: false, start: '', rules: '' }
    meta.list.push(entry)
  }
  return entry
}

/** Every Studio folder has an entry in `meta.list`, in the order they show (so the order is kept). */
function completeOrder(meta: SpaceFolderState, categories: StudioCategory[]): void {
  const ordered = orderedCategories(categories, meta).map(item => `c${item.category.id}`)
  const byId = new Map(meta.list.map(folder => [folder.id, folder]))
  const known = new Set(ordered)
  meta.list = [
    ...ordered.map(id => byId.get(id) ?? { id, name: '', color: '', folded: false, start: '', rules: '' }),
    ...meta.list.filter(folder => !known.has(folder.id) && !/^c\d+$/.test(folder.id)),
  ]
}

export class SpaceFolderSync {
  private queue: Promise<unknown> = Promise.resolve()
  private watcher: FSWatcher | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private debounce: ReturnType<typeof setTimeout> | null = null
  private badReads = 0


  constructor(private readonly deps: SpaceFolderSyncDeps) {}

  private now(): number { return this.deps.now?.() ?? Date.now() }

  /** Watch the file and look at both sides every few seconds. */
  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => { void this.sync().catch(() => undefined) }, this.deps.pollMs ?? 5000)
    this.timer.unref?.()
    const file = this.deps.file
    if (file) {
      void mkdir(dirname(file), { recursive: true }).then(() => {
        if (!this.timer) return
        try {
          this.watcher = watch(dirname(file), (_event, name) => {
            if (name && !String(name).startsWith(basename(file))) return
            if (this.debounce) clearTimeout(this.debounce)
            this.debounce = setTimeout(() => { this.debounce = null; void this.sync().catch(() => undefined) }, 250)
          })
          this.watcher.on('error', () => { this.watcher?.close(); this.watcher = null })
        } catch { /* polling still works */ }
      }).catch(() => undefined)
    }
    void this.sync().catch(() => undefined)
  }

  /** Sync shortly (a burst of changes is one sync). */
  soon(): void {
    if (!this.timer) return
    if (this.debounce) clearTimeout(this.debounce)
    this.debounce = setTimeout(() => { this.debounce = null; void this.sync().catch(() => undefined) }, 300)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    if (this.debounce) clearTimeout(this.debounce)
    this.debounce = null
    this.watcher?.close()
    this.watcher = null
  }

  /** One step at a time: a sync and a change never interleave. */
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work)
    this.queue = next.catch(() => undefined)
    return next
  }

  private studio(meta: SpaceFolderState) {
    return { categories: this.deps.categories(), meta, chats: this.deps.chats() }
  }

  /** Bring Studio and the file together (both directions). */
  sync(): Promise<{ applied: SyncOp[]; wrote: boolean }> {
    return this.serial(() => this.syncNow())
  }

  private async readFileText(): Promise<string | null> {
    if (!this.deps.file) return null
    try { return await readFile(this.deps.file, 'utf8') } catch { return null }
  }

  private async syncNow(): Promise<{ applied: SyncOp[]; wrote: boolean }> {
    if (this.deps.enabled && !this.deps.enabled()) return { applied: [], wrote: false }
    const meta = await this.deps.store.load()
    let studio = this.studio(meta)
    // Studio changed since it last wrote the file (outside this page too, such
    // as a chat moved in the chat list): that change is from now.
    const synced = meta.synced
    if (synced && meta.at <= synced.at) {
      const desired = buildFile(studio)
      if (!sameFile({ list: desired.list, of: desired.of }, { list: synced.list, of: synced.of })) meta.at = this.now()
    }
    if (!this.deps.file) {
      completeOrder(meta, studio.categories)
      await this.deps.store.save(meta, { keepAt: true })
      return { applied: [], wrote: false }
    }
    const text = await this.readFileText()
    const file = parseFile(text)
    if (text && text.trim() && !file) {
      // Half written or broken: leave it for a moment (the mod writes atomically, an editor may not).
      this.badReads += 1
      if (this.badReads < 3) return { applied: [], wrote: false }
      this.deps.log?.('warn', '[herdr] herdr-space-folders file is not JSON; Studio writes it again', { file: this.deps.file })
    }
    this.badReads = 0
    let applied: SyncOp[] = []
    // A copy older than what Studio last wrote (a stale save) is replaced, not merged.
    const fresh = file && (!synced || file.at > synced.at || (file.at === synced.at && !sameFile({ list: file.list, of: file.of }, { list: synced.list, of: synced.of })))
    if (file && fresh) {
      applied = fileChanges(file, studio)
      if (applied.length) {
        this.apply(meta, applied)
        studio = this.studio(meta)
        this.deps.log?.('info', '[herdr] Studio took folder changes from herdr-space-folders', { changes: applied.length })
      }
    }
    completeOrder(meta, studio.categories)
    studio = { ...studio, meta }
    const next = buildFile(studio)
    let wrote = false
    let at = file?.at ?? 0
    if (!file || !sameFile(file, next)) {
      at = Math.max(this.now(), (file?.at ?? 0) + 1)
      await this.writeFile({ ...next, at })
      wrote = true
    }
    meta.synced = { at, list: next.list as Array<Record<string, unknown>>, of: next.of }
    await this.deps.store.save(meta, { keepAt: true })
    if (applied.length) this.deps.changed()
    return { applied, wrote }
  }

  private async writeFile(doc: FileDoc): Promise<void> {
    const file = this.deps.file!
    await mkdir(dirname(file), { recursive: true })
    const temp = `${file}.studio-${process.pid}.tmp`
    const text = `${JSON.stringify(doc, null, 2)}\n`
    await writeFile(temp, text)
    await rename(temp, file)

  }

  /** Apply the file's changes to Studio (categories, chats' folders) and to `meta`. */
  private apply(meta: SpaceFolderState, ops: SyncOp[]): void {
    const made = new Map<string, string>()
    const resolve = (id: string | null): string | null => {
      if (id === null || id === '') return id
      if (id.startsWith('new:')) return made.get(id.slice(4)) ?? null
      return id
    }
    meta.alias = { ...(meta.alias || {}) }
    meta.extra = { ...(meta.extra || {}) }
    meta.out = [...(meta.out || [])]
    for (const op of ops) {
      try {
        if (op.kind === 'create') {
          const category = this.deps.createCategory(op.name, null)
          const id = `c${category.id}`
          made.set(op.fileId, id)
          if (op.fileId !== id) meta.alias[op.fileId] = id
          const entry = ensureEntry(meta, id)
          Object.assign(entry, { name: op.name, color: op.color, folded: op.folded, start: op.start, rules: op.rules })
          if (Object.keys(op.extra).length) meta.extra[id] = op.extra
        } else if (op.kind === 'update') {
          const categoryId = categoryIdOf(op.folderId)
          if (categoryId == null) continue
          if (op.patch.name) this.deps.renameCategory(categoryId, op.patch.name)
          const entry = ensureEntry(meta, op.folderId)
          if (op.patch.color !== undefined) entry.color = sanitizeColor(op.patch.color)
          if (op.patch.folded !== undefined) entry.folded = op.patch.folded
          if (op.patch.start !== undefined) entry.start = op.patch.start
          if (op.patch.rules !== undefined) entry.rules = op.patch.rules
        } else if (op.kind === 'extra') {
          if (Object.keys(op.extra).length) meta.extra[op.folderId] = op.extra
          else delete meta.extra[op.folderId]
        } else if (op.kind === 'delete') {
          const categoryId = categoryIdOf(op.folderId)
          if (categoryId != null) this.deps.deleteCategory(categoryId)
          meta.list = meta.list.filter(folder => folder.id !== op.folderId)
          delete meta.extra[op.folderId]
          for (const [from, to] of Object.entries(meta.alias)) if (to === op.folderId) delete meta.alias[from]
          for (const [space, folder] of Object.entries(meta.of)) if (folder === op.folderId) delete meta.of[space]
        } else if (op.kind === 'order') {
          const ids = op.ids.map(resolve).filter((id): id is string => !!id)
          for (const id of ids) ensureEntry(meta, id)
          const rank = new Map(ids.map((id, index) => [id, index]))
          meta.list = meta.list
            .map((folder, index) => ({ folder, index }))
            .sort((a, b) => (rank.get(a.folder.id) ?? ids.length + a.index) - (rank.get(b.folder.id) ?? ids.length + b.index))
            .map(item => item.folder)
        } else if (op.kind === 'placeChat') {
          const folder = resolve(op.folderId)
          const categoryId = folder ? categoryIdOf(folder) : null
          this.deps.setChatCategory(op.sessionId, categoryId)
          meta.out = meta.out.filter(id => id !== op.sessionId)
          if (folder === '') meta.out.push(op.sessionId)
        } else if (op.kind === 'placeSpace') {
          const folder = resolve(op.folderId)
          if (folder === null) delete meta.of[op.workspaceId]
          else meta.of[op.workspaceId] = folder
        } else if (op.kind === 'fileExtra') {
          meta.fileExtra = op.value
        }
      } catch (error) {
        this.deps.log?.('warn', '[herdr] could not apply a folder change from herdr-space-folders', { op: op.kind, error: String(error) })
      }
    }
  }

  // ---- Studio's herdr page ----

  /** Folders in the order they show, and every chat with its folder. */
  async view(): Promise<SpaceFolderView> {
    const meta = await this.deps.store.load()
    const categories = this.deps.categories()
    const extras = new Map(meta.list.map(folder => [folder.id, folder]))
    const folders = orderedCategories(categories, meta).map(({ category, depth }) => {
      const id = `c${category.id}`
      const extra = extras.get(id)
      return {
        id,
        name: category.name,
        color: extra?.color || '',
        folded: extra?.folded === true,
        start: extra?.start || '',
        rules: extra?.rules || '',
        categoryId: category.id,
        parentId: category.parent_id != null && categories.some(item => item.id === category.parent_id) ? `c${category.parent_id}` : '',
        depth,
      }
    })
    const known = new Set(folders.map(folder => folder.id))
    const out = new Set(meta.out || [])
    const chats = this.deps.chats().map(({ categoryId, ...chat }) => ({
      ...chat,
      folderId: categoryId != null && known.has(`c${categoryId}`) ? `c${categoryId}` : '',
      out: out.has(chat.id),
    }))
    const spaces = Object.fromEntries(Object.entries(meta.of).filter(([, folder]) => folder === '' || known.has(folder)))
    return { folders, chats, spaces, file: this.deps.file ? { path: this.deps.file, at: meta.synced?.at ?? 0 } : null }
  }

  /** A change from Studio: saved as Studio's newest, then written to the file. */
  private change(work: (meta: SpaceFolderState, categories: StudioCategory[]) => void | Promise<void>): Promise<void> {
    return this.serial(async () => {
      const meta = await this.deps.store.load()
      const categories = this.deps.categories()
      completeOrder(meta, categories)
      await work(meta, categories)
      completeOrder(meta, this.deps.categories())
      meta.at = this.now()
      await this.deps.store.save(meta, { keepAt: true })
    }).then(async () => {
      await this.sync().catch(error => this.deps.log?.('warn', '[herdr] could not write herdr-space-folders file', { error: String(error) }))
      this.deps.changed()
    })
  }

  createFolder(input: { name: string; parentId?: string; color?: string; start?: string; rules?: string }): Promise<string> {
    let id = ''
    return this.change((meta) => {
      const parent = input.parentId ? categoryIdOf(input.parentId) : null
      const category = this.deps.createCategory(input.name, parent)
      id = `c${category.id}`
      const entry = ensureEntry(meta, id)
      // A new folder goes at the end of its siblings.
      meta.list = [...meta.list.filter(folder => folder.id !== id), entry]
      if (input.color !== undefined) entry.color = sanitizeColor(input.color)
      if (input.start !== undefined) entry.start = input.start.trim()
      if (input.rules !== undefined) entry.rules = input.rules.trim()
    }).then(() => id)
  }

  updateFolder(id: string, patch: Partial<Pick<SpaceFolder, 'name' | 'color' | 'folded' | 'start' | 'rules'>>): Promise<void> {
    return this.change((meta, categories) => {
      const categoryId = categoryIdOf(id)
      if (categoryId == null || !categories.some(category => category.id === categoryId)) throw Object.assign(new Error('Folder not found'), { status: 404 })
      if (patch.name !== undefined && patch.name.trim()) this.deps.renameCategory(categoryId, patch.name)
      const entry = ensureEntry(meta, id)
      if (patch.color !== undefined) entry.color = sanitizeColor(patch.color)
      if (patch.folded !== undefined) entry.folded = patch.folded === true
      if (patch.start !== undefined) entry.start = String(patch.start).trim().slice(0, 1024)
      if (patch.rules !== undefined) entry.rules = String(patch.rules).trim().slice(0, 1024)
    })
  }

  deleteFolder(id: string): Promise<void> {
    return this.change((meta) => {
      const categoryId = categoryIdOf(id)
      if (categoryId == null) throw Object.assign(new Error('Folder not found'), { status: 404 })
      this.deps.deleteCategory(categoryId)
      meta.list = meta.list.filter(folder => folder.id !== id)
      if (meta.extra) delete meta.extra[id]
      for (const [space, folder] of Object.entries(meta.of)) if (folder === id) delete meta.of[space]
    })
  }

  /** Folders in a new order; `move` also puts one folder under another parent ('' = top). */
  orderFolders(ids: string[], move?: { id: string; parentId: string }): Promise<void> {
    return this.change((meta) => {
      if (move) {
        const categoryId = categoryIdOf(move.id)
        const parent = move.parentId ? categoryIdOf(move.parentId) : null
        if (categoryId != null) this.deps.moveCategory(categoryId, parent)
      }
      const rank = new Map(ids.map((id, index) => [id, index]))
      meta.list = meta.list
        .map((folder, index) => ({ folder, index }))
        .sort((a, b) => (rank.get(a.folder.id) ?? ids.length + a.index) - (rank.get(b.folder.id) ?? ids.length + b.index))
        .map(item => item.folder)
    })
  }

  /** A chat dragged into a folder ('c<id>'), out of every folder (''), or back to its rules (null). */
  placeChat(sessionId: string, folderId: string | null): Promise<void> {
    return this.change((meta) => {
      const categoryId = folderId ? categoryIdOf(folderId) : null
      if (folderId && categoryId == null) throw Object.assign(new Error('Folder not found'), { status: 404 })
      this.deps.setChatCategory(sessionId, categoryId)
      meta.out = (meta.out || []).filter(id => id !== sessionId)
      if (folderId === '') meta.out.push(sessionId)
    })
  }

  /** A space that is no Studio chat, placed like a chat. */
  placeSpace(workspaceId: string, folderId: string | null): Promise<void> {
    return this.change((meta) => {
      if (folderId === null) delete meta.of[workspaceId]
      else meta.of[workspaceId] = folderId
    })
  }
}
