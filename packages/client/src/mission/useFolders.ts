import { computed, ref } from 'vue'
import {
  createSessionCategory,
  deleteSessionCategory,
  fetchSessionCategories,
  fetchSessions,
  moveSessionCategory,
  renameSessionCategory,
  setSessionCategory,
  type SessionCategory,
} from '@/api/studio/sessions'
import { fetchSpaceFolders, saveSpaceFolders, type HerdrPaneView, type SpaceFolder, type SpaceFolderState } from '@/api/coding-agents/herdr'
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

const isLegacy = (folder: SpaceFolder) => categoryIdOf(folder.id) == null

export function useStudioFolders(onError: (message: string) => void) {
  const categories = ref<SessionCategory[]>([])
  const meta = ref<SpaceFolderState>({ list: [], of: {}, at: 0 })
  const chatFolders = ref(new Map<string, number | null>())
  const folders = computed(() => buildFolderTree(categories.value, meta.value))
  let saveTimer = 0

  function fail(error: unknown) {
    onError(error instanceof Error ? error.message : String(error))
  }

  function saveMeta(next: SpaceFolderState) {
    meta.value = { ...next, at: Date.now() }
    if (saveTimer) window.clearTimeout(saveTimer)
    saveTimer = window.setTimeout(async () => {
      saveTimer = 0
      try { meta.value = await saveSpaceFolders(meta.value) } catch (error) { fail(error) }
    }, 250)
  }

  async function loadChats() {
    try {
      const chats = await fetchSessions('coding_agent', 500)
      chatFolders.value = new Map((Array.isArray(chats) ? chats : []).map(chat => [chat.id, chat.category_id ?? null]))
    } catch { /* keep the last known */ }
  }

  /** Folders made in Mission before it shared Studio's become Studio folders (same name). */
  async function migrateLegacy(state: SpaceFolderState): Promise<SpaceFolderState> {
    const legacy = state.list.filter(isLegacy)
    if (!legacy.length) return state
    const list = state.list.filter(folder => !isLegacy(folder))
    const of = { ...state.of }
    for (const folder of legacy) {
      let category = categories.value.find(item => item.parent_id == null && item.name.toLowerCase() === folder.name.trim().toLowerCase())
      if (!category) {
        category = await createSessionCategory(folder.name.trim() || 'Folder', null)
        categories.value = [...categories.value, category]
      }
      const id = folderIdOf(category.id)
      if (!list.some(item => item.id === id)) list.push({ ...folder, id })
      for (const [space, placed] of Object.entries(of)) if (placed === folder.id) of[space] = id
    }
    const next = { list, of, at: Date.now() }
    await saveSpaceFolders(next)
    return next
  }

  async function load() {
    try {
      const [loadedCategories, loadedMeta] = await Promise.all([fetchSessionCategories(), fetchSpaceFolders()])
      categories.value = Array.isArray(loadedCategories) ? loadedCategories : []
      meta.value = await migrateLegacy({ list: Array.isArray(loadedMeta?.list) ? loadedMeta.list : [], of: loadedMeta?.of || {}, at: loadedMeta?.at || 0 })
    } catch (error) { fail(error) }
    await loadChats()
  }

  /** Changes made in Studio's sidebar show up here. */
  async function refresh() {
    try { const next = await fetchSessionCategories(); if (Array.isArray(next)) categories.value = next } catch { /* keep */ }
    await loadChats()
  }

  function upsertMeta(folder: SpaceFolder) {
    const extra: SpaceFolder = { id: folder.id, name: folder.name, color: folder.color, folded: folder.folded, start: folder.start, rules: folder.rules }
    const list = meta.value.list.some(item => item.id === folder.id)
      ? meta.value.list.map(item => (item.id === folder.id ? extra : item))
      : [...meta.value.list, extra]
    saveMeta({ ...meta.value, list })
  }

  async function createFolder(draft: SpaceFolder, parentId: string) {
    try {
      const category = await createSessionCategory(draft.name.trim() || 'Folder', categoryIdOf(parentId))
      categories.value = [...categories.value, category]
      upsertMeta({ ...draft, id: folderIdOf(category.id), name: category.name })
      return folderIdOf(category.id)
    } catch (error) { fail(error); return '' }
  }

  async function updateFolder(draft: SpaceFolder) {
    const categoryId = categoryIdOf(draft.id)
    const current = categories.value.find(category => category.id === categoryId)
    try {
      if (current && draft.name.trim() && draft.name.trim() !== current.name) {
        const renamed = await renameSessionCategory(current.id, draft.name.trim())
        categories.value = categories.value.map(category => (category.id === renamed.id ? renamed : category))
      }
      upsertMeta(draft)
    } catch (error) { fail(error) }
  }

  async function moveFolder(folderId: string, parentId: string) {
    const categoryId = categoryIdOf(folderId)
    if (categoryId == null || folderId === parentId) return
    try {
      const moved = await moveSessionCategory(categoryId, categoryIdOf(parentId))
      categories.value = categories.value.map(category => (category.id === moved.id ? moved : category))
    } catch (error) { fail(error) }
  }

  async function removeFolder(folderId: string) {
    const categoryId = categoryIdOf(folderId)
    if (categoryId == null) return
    try {
      await deleteSessionCategory(categoryId)
      await refresh()
      const of = Object.fromEntries(Object.entries(meta.value.of).filter(([, id]) => id !== folderId))
      saveMeta({ list: meta.value.list.filter(folder => folder.id !== folderId), of, at: Date.now() })
    } catch (error) { fail(error) }
  }

  function toggleFolded(folderId: string) {
    const folder = folders.value.find(item => item.id === folderId)
    if (folder) upsertMeta({ ...folder, folded: !folder.folded })
  }

  /** File a space in a folder ('' takes it out); its chats move to that Studio folder too. */
  async function placeSpace(spaceId: string, folderId: string, panes: HerdrPaneView[]) {
    saveMeta({ ...meta.value, of: { ...meta.value.of, [spaceId]: folderId } })
    const categoryId = categoryIdOf(folderId)
    const chats = panes.filter(pane => pane.workspace_id === spaceId && pane.studioSessionId).map(pane => pane.studioSessionId!)
    if (!chats.length) return
    const next = new Map(chatFolders.value)
    for (const chat of chats) next.set(chat, categoryId)
    chatFolders.value = next
    try { await Promise.all(chats.map(chat => setSessionCategory(chat, categoryId))) } catch (error) { fail(error); await loadChats() }
  }

  function folderOfSpace(spaceId: string, panes: HerdrPaneView[], cwd: string, home: string): string {
    return folderForSpace({ spaceId, panes, cwd, home, folders: folders.value, meta: meta.value, chatFolders: chatFolders.value })
  }

  return { folders, meta, load, refresh, createFolder, updateFolder, moveFolder, removeFolder, toggleFolded, placeSpace, folderOfSpace }
}
