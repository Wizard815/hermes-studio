import type { HerdrPaneView, HerdrStatusValue } from '@/api/coding-agents/herdr'

/** How deep a rule reaches into a working folder, or -1 (the server's and herdr-space-folders' semantics). */
export function ruleDepth(rule: string, cwd: string, home: string): number {
  const value = rule.trim()
  if (!value || !cwd) return -1
  const normalize = (path: string) => (path.startsWith('~') ? `${home}${path.slice(1)}` : path).replace(/\\/g, '/').replace(/\/+$/, '')
  const segment = (part: string, name: string) => part === '*' || (part.includes('*')
    ? new RegExp(`^${part.split('*').map(piece => piece.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}$`).test(name)
    : part === name)
  const parts = normalize(cwd).split('/').filter(Boolean)
  if (value.startsWith('/') || value.startsWith('~')) {
    const ruleParts = normalize(value).split('/').filter(Boolean)
    if (ruleParts.length > parts.length) return -1
    return ruleParts.every((part, index) => segment(part, parts[index])) ? ruleParts.length : -1
  }
  const index = parts.findIndex(part => segment(value, part))
  return index >= 0 ? index + 1 : -1
}

/**
 * Studio's Spaces sidebar on the herdr page, after herdr-space-folders
 * (github.com/jankeesvw/herdr-space-folders) and Herdr Roundup's spaces list
 * (github.com/carstenlucke/herdr-roundup): Studio's chat folders as colored,
 * foldable folders holding every chat (awake or asleep) and other herdr
 * spaces. This file is the list's logic: which row goes where, what a drop
 * does, where the keys go. HerdrSpaceSidebar.vue draws it.
 */

/** Folder tile and avatar colors (herdr-space-folders' palette, by Studio's names). */
export const FOLDER_COLOR_NAMES = ['teal', 'orange', 'blue', 'violet', 'green', 'pink'] as const
export type FolderColorName = typeof FOLDER_COLOR_NAMES[number]

export interface SidebarFolder {
  id: string
  name: string
  /** A FolderColorName, a hex color another app chose, or '' (grey). */
  color: string
  folded: boolean
  start: string
  rules: string
  categoryId: number
  /** Parent folder id, '' at the top. */
  parentId: string
  depth: number
}

export interface SidebarChat {
  id: string
  title: string
  agent: string
  /** The chat's Studio folder ('' = none). */
  folderId: string
  /** Taken out of every folder by hand: rules leave it alone. */
  out: boolean
  workspace: string | null
  /** Its herdr space while awake. */
  workspaceId: string | null
  lastActive: number
}

export interface SpaceFolderViewData {
  folders: SidebarFolder[]
  chats: SidebarChat[]
  /** Placements of herdr spaces that are no Studio chat. */
  spaces: Record<string, string>
  home: string
  file: { path: string; at: number } | null
}

/** A herdr space with no Studio chat in it (a plain shell). */
export interface OtherSpace {
  workspaceId: string
  label: string
}

export type SpaceStatus = HerdrStatusValue

export type SidebarRow =
  | { kind: 'folder'; key: string; depth: number; folder: SidebarFolder; count: number; status: SpaceStatus | null; open: boolean }
  | { kind: 'chat'; key: string; depth: number; chat: SidebarChat; folderId: string; asleep: boolean; status: SpaceStatus; paneId: string; cwd: string }
  | { kind: 'space'; key: string; depth: number; space: OtherSpace; folderId: string; status: SpaceStatus; paneId: string; cwd: string }

/** Statuses a folded folder still shows (herdr-space-folders' URGENT, in its order). */
export const URGENT: SpaceStatus[] = ['blocked', 'done', 'working']
const RANK: Record<SpaceStatus, number> = { blocked: 4, done: 3, working: 2, idle: 1, unknown: 0 }

/** The status a space shows: its most pressing agent's. */
export function spaceStatus(panes: HerdrPaneView[]): { status: SpaceStatus; paneId: string; cwd: string } {
  let best: HerdrPaneView | null = null
  for (const pane of panes) {
    const status = pane.agent_status || 'unknown'
    if (!best || RANK[status] > RANK[best.agent_status || 'unknown'] || (pane.focused && RANK[status] === RANK[best.agent_status || 'unknown'])) best = pane
  }
  return { status: best?.agent_status || 'unknown', paneId: best?.pane_id || panes[0]?.pane_id || '', cwd: panes.find(pane => pane.foreground_cwd || pane.cwd)?.foreground_cwd || panes.find(pane => pane.cwd)?.cwd || '' }
}

/** A folder's rules: its own, or its start folder while it has none (as the server files new chats). */
export function folderRules(folder: Pick<SidebarFolder, 'rules' | 'start'>): string {
  return folder.rules.trim() || folder.start.trim()
}

/**
 * The folder whose rules reach deepest into `cwd`: `wbso-ai` (a folder name
 * anywhere), `~/code/client-*` (a path, `*` one name). The first on a tie; ''
 * for none.
 */
export function ruleFolder(folders: Array<Pick<SidebarFolder, 'id' | 'rules' | 'start'>>, cwd: string, home: string): string {
  let best = ''
  let depth = 0
  for (const folder of folders) {
    for (const rule of folderRules(folder).split(',')) {
      const reach = ruleDepth(rule, cwd, home)
      if (reach > depth) { best = folder.id; depth = reach }
    }
  }
  return best
}

/** Where a chat shows: its Studio folder (what you dragged wins), else nowhere when taken out, else its rules. */
export function chatFolder(chat: Pick<SidebarChat, 'folderId' | 'out'>, cwd: string, folders: SidebarFolder[], home: string): string {
  if (chat.folderId && folders.some(folder => folder.id === chat.folderId)) return chat.folderId
  if (chat.out) return ''
  return ruleFolder(folders, cwd, home)
}

/** Where another herdr space shows: where it was dropped, else its rules. */
export function spaceFolder(workspaceId: string, cwd: string, placements: Record<string, string>, folders: SidebarFolder[], home: string): string {
  if (Object.prototype.hasOwnProperty.call(placements, workspaceId)) {
    const placed = placements[workspaceId]
    if (!placed || folders.some(folder => folder.id === placed)) return placed
  }
  return ruleFolder(folders, cwd, home)
}

export interface RowsInput {
  view: SpaceFolderViewData
  panes: HerdrPaneView[]
  /** herdr spaces with their labels (from herdr's state). */
  workspaces: Array<{ workspace_id: string; label?: string }>
  /** Chats with a herdr space now; null when herdr's state is unknown (none is marked asleep). */
  awake: Set<string> | null
  query?: string
  /** Folders opened for this viewer while searching are not needed: a search opens every folder with a match. */
}

/**
 * The sidebar's rows in order: each top folder with its subfolders and then
 * its chats/spaces, folders before loose items. A folded folder hides what is
 * in it; `seen` lists every chat/space row in order with whether it shows, for
 * the keys that step through the list.
 */
export function buildRows(input: RowsInput): { rows: SidebarRow[]; seen: Array<{ key: string; shown: boolean }> } {
  const { view } = input
  const query = (input.query || '').trim().toLowerCase()
  const folders = view.folders
  const panesBySession = new Map<string, HerdrPaneView[]>()
  const panesBySpace = new Map<string, HerdrPaneView[]>()
  for (const pane of input.panes) {
    if (pane.studioSessionId) panesBySession.set(pane.studioSessionId, [...(panesBySession.get(pane.studioSessionId) || []), pane])
    panesBySpace.set(pane.workspace_id, [...(panesBySpace.get(pane.workspace_id) || []), pane])
  }
  const chatSpaces = new Set<string>()
  for (const chat of view.chats) if (chat.workspaceId) chatSpaces.add(chat.workspaceId)
  for (const pane of input.panes) if (pane.studioSessionId) chatSpaces.add(pane.workspace_id)

  type Item = Extract<SidebarRow, { kind: 'chat' | 'space' }>
  const items: Item[] = []
  for (const chat of view.chats) {
    const panes = panesBySession.get(chat.id) || []
    const live = spaceStatus(panes)
    const cwd = live.cwd || chat.workspace || ''
    const folderId = chatFolder(chat, cwd, folders, view.home)
    const asleep = !!input.awake && !input.awake.has(chat.id) && !panes.length
    items.push({ kind: 'chat', key: `chat:${chat.id}`, depth: 0, chat, folderId, asleep, status: panes.length ? live.status : 'unknown', paneId: live.paneId, cwd })
  }
  for (const workspace of input.workspaces) {
    if (chatSpaces.has(workspace.workspace_id)) continue
    const panes = panesBySpace.get(workspace.workspace_id) || []
    const live = spaceStatus(panes)
    const folderId = spaceFolder(workspace.workspace_id, live.cwd, view.spaces, folders, view.home)
    items.push({ kind: 'space', key: `space:${workspace.workspace_id}`, depth: 0, space: { workspaceId: workspace.workspace_id, label: workspace.label || workspace.workspace_id }, folderId, status: live.status, paneId: live.paneId, cwd: live.cwd })
  }
  // Awake ones first (as herdr lists them), then newest first.
  const itemTime = (item: Item) => (item.kind === 'chat' ? item.chat.lastActive : Number.MAX_SAFE_INTEGER)
  items.sort((a, b) => Number(a.kind === 'chat' && a.asleep) - Number(b.kind === 'chat' && b.asleep) || itemTime(b) - itemTime(a))
  const matches = (item: Item) => !query || (item.kind === 'chat'
    ? `${item.chat.title} ${item.chat.agent}`.toLowerCase().includes(query)
    : item.space.label.toLowerCase().includes(query))

  const children = new Map<string, SidebarFolder[]>()
  for (const folder of folders) children.set(folder.parentId, [...(children.get(folder.parentId) || []), folder])
  const inFolder = new Map<string, Item[]>()
  for (const item of items) inFolder.set(item.folderId, [...(inFolder.get(item.folderId) || []), item])
  const subtree = (folder: SidebarFolder): Item[] => [...(inFolder.get(folder.id) || []), ...(children.get(folder.id) || []).flatMap(subtree)]

  const rows: SidebarRow[] = []
  const seen: Array<{ key: string; shown: boolean }> = []
  const walk = (parentId: string, depth: number, hidden: boolean) => {
    for (const folder of children.get(parentId) || []) {
      const inside = subtree(folder)
      const shownInside = inside.filter(matches)
      if (query && !shownInside.length && !folder.name.toLowerCase().includes(query)) continue
      // A search opens every folder with a match.
      const open = query ? true : !folder.folded
      const status = URGENT.find(urgent => inside.some(item => item.status === urgent)) ?? null
      if (!hidden) rows.push({ kind: 'folder', key: `folder:${folder.id}`, depth, folder, count: inside.length, status, open })
      walk(folder.id, depth + 1, hidden || !open)
      for (const item of inFolder.get(folder.id) || []) {
        if (!matches(item)) continue
        const shown = !hidden && open
        seen.push({ key: item.key, shown })
        if (shown) rows.push({ ...item, depth: depth + 1 })
      }
    }
  }
  walk('', 0, false)
  for (const item of inFolder.get('') || []) {
    if (!matches(item)) continue
    seen.push({ key: item.key, shown: true })
    rows.push({ ...item, depth: 0 })
  }
  return { rows, seen }
}

/**
 * The next (1) or previous (-1) row from `current` in the list as it shows,
 * past folded folders, round from the end to the top (alt+down / alt+up).
 */
export function stepRow(seen: Array<{ key: string; shown: boolean }>, current: string, dir: 1 | -1): string | null {
  const len = seen.length
  if (!len) return null
  const at = seen.findIndex(item => item.key === current)
  const from = at >= 0 ? at : dir > 0 ? -1 : len
  for (let n = 1; n <= len; n += 1) {
    const item = seen[(((from + dir * n) % len) + len) % len]
    if (item.shown) return item.key
  }
  return null
}

export type DragItem = { kind: 'chat'; id: string } | { kind: 'space'; id: string } | { kind: 'folder'; id: string }
export type DropTarget = { kind: 'folder'; id: string } | { kind: 'item'; folderId: string } | { kind: 'end' }

export type DropAction =
  | { kind: 'placeChat'; sessionId: string; folderId: string | null }
  | { kind: 'placeSpace'; workspaceId: string; folderId: string | null }
  | { kind: 'order'; ids: string[]; move?: { id: string; parentId: string } }
  | null

/** A folder is `id` itself or one of its subfolders. */
export function isWithin(folders: SidebarFolder[], folderId: string, ancestorId: string): boolean {
  let current: string | undefined = folderId
  for (let i = 0; current && i < 20; i += 1) {
    if (current === ancestorId) return true
    current = folders.find(folder => folder.id === current)?.parentId
  }
  return false
}

/**
 * What a drop does (herdr-space-folders' drag and drop): a chat or space
 * dropped on a folder goes in it; on another chat or space, into that one's
 * folder; below the list, out of every folder (kept out even where rules
 * would collect it, else simply in none). A folder dropped on a folder goes
 * right before it (after it, when dragged down), beside it under the same
 * parent; below the list, last at the top level.
 */
export function dropAction(drag: DragItem, target: DropTarget, context: { folders: SidebarFolder[]; ruleFolderOf: (item: DragItem) => string }): DropAction {
  const { folders } = context
  if (drag.kind === 'chat' || drag.kind === 'space') {
    let folderId: string | null
    if (target.kind === 'folder') folderId = target.id
    else {
      const into = target.kind === 'item' ? target.folderId : ''
      folderId = into || (context.ruleFolderOf(drag) ? '' : null)
    }
    return drag.kind === 'chat' ? { kind: 'placeChat', sessionId: drag.id, folderId } : { kind: 'placeSpace', workspaceId: drag.id, folderId }
  }
  const dragged = folders.find(folder => folder.id === drag.id)
  if (!dragged) return null
  const ids = folders.map(folder => folder.id)
  if (target.kind === 'end') {
    const rest = ids.filter(id => id !== dragged.id)
    return { kind: 'order', ids: [...rest, dragged.id], ...(dragged.parentId ? { move: { id: dragged.id, parentId: '' } } : {}) }
  }
  if (target.kind !== 'folder' || target.id === dragged.id) return null
  const over = folders.find(folder => folder.id === target.id)
  if (!over || isWithin(folders, over.id, dragged.id)) return null
  const from = ids.indexOf(dragged.id)
  const to = ids.indexOf(over.id)
  const rest = ids.filter(id => id !== dragged.id)
  const at = rest.indexOf(over.id) + (from < to && over.parentId === dragged.parentId ? 1 : 0)
  rest.splice(at, 0, dragged.id)
  return { kind: 'order', ids: rest, ...(over.parentId !== dragged.parentId ? { move: { id: dragged.id, parentId: over.parentId } } : {}) }
}

/** A stable avatar color for a space (the same chat always gets the same one). */
export function avatarColor(id: string): FolderColorName {
  let hash = 0
  for (let i = 0; i < id.length; i += 1) hash = (hash * 31 + id.charCodeAt(i)) >>> 0
  return FOLDER_COLOR_NAMES[hash % FOLDER_COLOR_NAMES.length]
}

/** The avatar's letter: the name's first letter or digit. */
export function avatarLetter(name: string): string {
  const match = /[\p{L}\p{N}]/u.exec(name || '')
  return match ? match[0].toUpperCase() : '·'
}

export interface SpaceRepo { repo: string; branch: string | null; ahead: number; behind: number; linked: boolean }

/**
 * Only what is unusual, after a space's name: "herdr · spike ↑2 ↓1". The repo
 * goes when the name already says it, the branch when it is main/master or
 * already in the name; ahead/behind only when not zero.
 */
export function repoTail(repo: SpaceRepo | null | undefined, name: string): string {
  if (!repo) return ''
  const lower = (name || '').toLowerCase()
  const parts: string[] = []
  if (repo.repo && !lower.includes(repo.repo.toLowerCase())) parts.push(repo.repo)
  const branch = repo.branch ?? 'detached'
  if (!['main', 'master'].includes(branch) && !lower.includes(branch.toLowerCase())) parts.push(branch)
  let text = parts.join(' · ')
  const counts = [repo.ahead ? `↑${repo.ahead}` : '', repo.behind ? `↓${repo.behind}` : ''].filter(Boolean).join(' ')
  if (counts) text = text ? `${text} ${counts}` : counts
  return text
}

/** A folder tile's or avatar's color class ('' = grey; another app's hex color is drawn inline). */
export function colorClass(color: string): string {
  return (FOLDER_COLOR_NAMES as readonly string[]).includes(color) ? `sf-color-${color}` : color ? '' : 'sf-color-none'
}
