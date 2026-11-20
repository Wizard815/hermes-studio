import type { SessionCategory } from '@/api/studio/sessions'
import type { HerdrPaneView, SpaceFolder, SpaceFolderState } from '@/api/coding-agents/herdr'
import { ruleDepth } from './useMission'

/**
 * Mission's folders are Studio's chat folders (session categories), 1:1: the
 * same names and nesting, so a chat filed in Studio files its herdr space here
 * and the other way round. Mission keeps only its extras per folder (color,
 * start directory, collect rules, folded) in herdr's space-folders file, keyed
 * `c<category id>`.
 */
export interface MissionFolder extends SpaceFolder {
  categoryId: number
  /** Parent folder id (`c<id>`), or '' at the top. */
  parentId: string
  depth: number
}

/** A Studio chat as the Spaces tree lists it, in its Studio folder. */
export interface TreeChat {
  id: string
  title: string
  /** Folder id (`c<category id>`) or '' when not in a folder. */
  folderId: string
  agent: string
  /** herdr can run it (a coding agent herdr hosts); other chats open in Studio's Chat view. */
  hostable: boolean
  lastActive: number
}

/** Stored chat agents herdr can host (see services/herdr/protocol.ts); hermes
 * chats resume as `hermes chat` panes. A chat with no stored agent is a Hermes
 * chat (older Studio chats were saved that way). The rest (Ekko, DSH) are in
 * herdr too, through Studio's chat client in their waiting pane. */
const HERDR_HOSTABLE_AGENTS = new Set(['claude', 'claude-code', 'codex', 'pi', 'grok', 'opencode', 'cursor', 'antigravity', 'qwen', 'kimi', 'qoder', 'copilot', 'codebuddy', 'zcode', 'hermes'])
export const herdrCanHost = (agent: string | undefined | null) => HERDR_HOSTABLE_AGENTS.has(String(agent || '').trim() || 'hermes')

/** What `herdrCanOpenChat` reads of a Studio chat. */
export interface HerdrChatCandidate {
  id?: string
  source?: string
  isArchived?: boolean
  isLocalOnly?: boolean
  parentSessionId?: string | null
}

/**
 * Whether a chat has a herdr space (so "Open in herdr" can open it, waking it
 * if it is asleep). Every saved top-level chat does, whatever its agent: agents
 * herdr hosts run in its pane, the others (Ekko, Hermes without its CLI) talk
 * through Studio's chat client there. Sub-chats, archived chats, group chats
 * and workflows have none (the server's `chatSpaceRows` leaves them out).
 */
export function herdrCanOpenChat(chat: HerdrChatCandidate | null | undefined): boolean {
  if (!chat || !chat.id || chat.isLocalOnly || chat.isArchived || chat.parentSessionId) return false
  return chat.source !== 'group_chat' && chat.source !== 'workflow'
}

export const folderIdOf = (categoryId: number) => `c${categoryId}`
export const categoryIdOf = (folderId: string): number | null => (/^c\d+$/.test(folderId) ? Number(folderId.slice(1)) : null)

/** Folders in tree order (parents before children, siblings by name). */
export function buildFolderTree(categories: SessionCategory[], meta: SpaceFolderState): MissionFolder[] {
  const byParent = new Map<number | null, SessionCategory[]>()
  const ids = new Set(categories.map(category => category.id))
  for (const category of categories) {
    const parent = category.parent_id != null && ids.has(category.parent_id) ? category.parent_id : null
    byParent.set(parent, [...(byParent.get(parent) || []), category])
  }
  const out: MissionFolder[] = []
  const walk = (parent: number | null, depth: number) => {
    const children = (byParent.get(parent) || []).slice().sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.id - b.id)
    for (const category of children) {
      const id = folderIdOf(category.id)
      const extra = meta.list.find(folder => folder.id === id)
      out.push({
        id,
        name: category.name,
        color: extra?.color ?? '',
        folded: extra?.folded ?? false,
        start: extra?.start ?? '',
        rules: extra?.rules ?? '',
        categoryId: category.id,
        parentId: parent == null ? '' : folderIdOf(parent),
        depth,
      })
      if (depth < 10) walk(category.id, depth + 1)
    }
  }
  walk(null, 0)
  return out
}

/**
 * The folder a herdr space is in: the Studio folder of a chat running in it
 * (so it matches Studio exactly), else where it was dropped, else the folder
 * whose start directory or rules match its directory most deeply.
 */
export function folderForSpace(input: {
  spaceId: string
  panes: HerdrPaneView[]
  cwd: string
  home: string
  folders: MissionFolder[]
  meta: SpaceFolderState
  chatFolders: Map<string, number | null>
}): string {
  const known = new Set(input.folders.map(folder => folder.id))
  for (const pane of input.panes) {
    if (pane.workspace_id !== input.spaceId || !pane.studioSessionId) continue
    const category = input.chatFolders.get(pane.studioSessionId)
    if (category != null && known.has(folderIdOf(category))) return folderIdOf(category)
  }
  if (Object.prototype.hasOwnProperty.call(input.meta.of, input.spaceId)) {
    const placed = input.meta.of[input.spaceId]
    if (!placed || known.has(placed)) return placed
  }
  let best = ''
  let bestDepth = 0
  for (const folder of input.folders) {
    for (const rule of [folder.start, ...folder.rules.split(',')]) {
      const depth = ruleDepth(rule || '', input.cwd, input.home)
      if (depth > bestDepth) { best = folder.id; bestDepth = depth }
    }
  }
  return best
}
