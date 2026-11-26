import { describe, expect, it } from 'vitest'
import { ref } from 'vue'
import {
  avatarColor,
  avatarLetter,
  buildRows,
  chatFolder,
  dropAction,
  repoTail,
  ruleFolder,
  stepRow,
  type SidebarFolder,
  type SpaceFolderViewData,
} from '@/components/coding-agents/herdr/space-folders'
import { readSidebarPrefs, useSpaceSidebar, writeSidebarPrefs } from '@/components/coding-agents/herdr/space-sidebar-layout'

const HOME = '/home/me'
const folder = (id: string, name: string, extra: Partial<SidebarFolder> = {}): SidebarFolder => ({
  id, name, color: '', folded: false, start: '', rules: '', categoryId: Number(id.slice(1)), parentId: '', depth: 0, ...extra,
})
const chat = (id: string, extra: Record<string, unknown> = {}) => ({
  id, title: id, agent: 'claude-code', folderId: '', out: false, workspace: null, workspaceId: null, lastActive: 0, ...extra,
})

function view(): SpaceFolderViewData {
  return {
    home: HOME,
    file: null,
    spaces: { wshell: 'c1' },
    folders: [
      folder('c1', 'Work', { color: 'blue', rules: '~/work' }),
      folder('c2', 'Clients', { rules: 'client-*' }),
      folder('c3', 'Acme', { parentId: 'c2', depth: 1, rules: '~/code/client-acme/web' }),
      folder('c4', 'Games', { folded: true, rules: 'omasweeper' }),
    ],
    chats: [
      chat('dragged', { folderId: 'c4', workspace: '/home/me/work/x', lastActive: 5 }),
      chat('ruled', { workspace: '/home/me/work/api', lastActive: 4 }),
      chat('deepest', { workspace: '/home/me/code/client-acme/web', lastActive: 3 }),
      chat('client', { workspace: '/home/me/code/client-zeta', lastActive: 2 }),
      chat('taken-out', { out: true, workspace: '/home/me/work/y', lastActive: 9 }),
      chat('asleep', { folderId: 'c4', lastActive: 1 }),
      chat('game', { folderId: 'c4', workspaceId: 'wg', lastActive: 8 }),
    ],
  }
}

const panes = [
  { pane_id: 'wg:p1', workspace_id: 'wg', agent: 'claude', agent_status: 'blocked' as const, studioAgent: 'claude-code', studioSessionId: 'game', nativeSessionId: null, cwd: '/home/me/games/omasweeper' },
  { pane_id: 'wshell:p1', workspace_id: 'wshell', agent_status: 'unknown' as const, studioAgent: null, studioSessionId: null, nativeSessionId: null, cwd: '/tmp' },
]

describe('Spaces sidebar: rules', () => {
  it('a folder collects by name anywhere or by path, the most specific rule wins', () => {
    const folders = view().folders
    expect(ruleFolder(folders, '/home/me/work/api', HOME)).toBe('c1')
    expect(ruleFolder(folders, '/home/me/code/client-zeta/src', HOME)).toBe('c2')
    // ~/code/client-acme/web reaches deeper than client-*.
    expect(ruleFolder(folders, '/home/me/code/client-acme/web', HOME)).toBe('c3')
    expect(ruleFolder(folders, '/srv/elsewhere', HOME)).toBe('')
    // A folder with no rules collects from its start folder.
    expect(ruleFolder([folder('c9', 'Site', { start: '~/site' })], '/home/me/site/a', HOME)).toBe('c9')
  })

  it('what you dragged wins over rules; taken out stays out', () => {
    const folders = view().folders
    expect(chatFolder({ folderId: 'c4', out: false }, '/home/me/work/x', folders, HOME)).toBe('c4')
    expect(chatFolder({ folderId: '', out: true }, '/home/me/work/x', folders, HOME)).toBe('')
    expect(chatFolder({ folderId: '', out: false }, '/home/me/work/x', folders, HOME)).toBe('c1')
    // A folder that no longer exists: rules decide.
    expect(chatFolder({ folderId: 'c99', out: false }, '/home/me/work/x', folders, HOME)).toBe('c1')
  })
})

describe('Spaces sidebar: rows', () => {
  it('lists folders (subfolders first), every elevated chat in its folder, other spaces too', () => {
    const { rows } = buildRows({ view: view(), panes, workspaces: [{ workspace_id: 'wg' }, { workspace_id: 'wshell', label: 'shell' }], elevated: new Set(['dragged', 'ruled', 'deepest', 'client', 'taken-out', 'asleep', 'game']) })
    expect(rows.map(row => row.key)).toEqual([
      'folder:c1', 'space:wshell', 'chat:ruled',
      'folder:c2', 'folder:c3', 'chat:deepest', 'chat:client',
      'folder:c4',
      'chat:taken-out',
    ])
    const work = rows.find(row => row.key === 'folder:c1')!
    expect(work).toMatchObject({ count: 2, open: true })
    // A folded folder counts its chats and still shows a blocked agent inside.
    expect(rows.find(row => row.key === 'folder:c4')).toMatchObject({ count: 3, open: false, status: 'blocked' })
    const clients = rows.find(row => row.key === 'folder:c2')!
    expect(clients).toMatchObject({ count: 2 })
    expect(rows.find(row => row.key === 'chat:deepest')).toMatchObject({ depth: 2 })
  })

  it('lists only chats in herdr: elevated ones and ones with a pane; folders with nothing in herdr are hidden', () => {
    const { rows } = buildRows({ view: view(), panes, workspaces: [{ workspace_id: 'wg' }, { workspace_id: 'wshell', label: 'shell' }], elevated: new Set(['ruled']) })
    // game has a pane (its agent runs in herdr); ruled is elevated; the rest are Studio-only.
    expect(rows.map(row => row.key)).toEqual(['folder:c1', 'space:wshell', 'chat:ruled', 'folder:c4'])
    expect(rows.find(row => row.key === 'folder:c4')).toMatchObject({ count: 1 })
    // Nothing elevated and no herdr spaces: no folders at all.
    expect(buildRows({ view: view(), panes: [], workspaces: [], elevated: new Set() }).rows).toEqual([])
  })

  it('a search opens every folder with a match and hides the rest', () => {
    const { rows } = buildRows({ view: view(), panes, workspaces: [], elevated: new Set(['dragged', 'ruled', 'deepest', 'client', 'taken-out', 'asleep', 'game']), query: 'gam' })
    expect(rows.map(row => row.key)).toEqual(['folder:c4', 'chat:game'])
    expect(buildRows({ view: view(), panes, workspaces: [], elevated: new Set(['dragged', 'ruled', 'deepest', 'client', 'taken-out', 'asleep', 'game']), query: 'nothing at all' }).rows).toEqual([])
  })

  it('chats come newest first', () => {
    const data = view()
    data.folders = []
    const { rows } = buildRows({ view: data, panes, workspaces: [], elevated: new Set(['dragged', 'ruled', 'deepest', 'client', 'taken-out', 'asleep', 'game']) })
    expect(rows.map(row => row.key)).toEqual(['chat:taken-out', 'chat:game', 'chat:dragged', 'chat:ruled', 'chat:deepest', 'chat:client', 'chat:asleep'])
  })
})

describe('Spaces sidebar: keys follow the list', () => {
  it('alt+down / alt+up go to the next shown row, past folded folders, round the ends', () => {
    const { seen } = buildRows({ view: view(), panes, workspaces: [{ workspace_id: 'wshell' }], elevated: new Set(['dragged', 'ruled', 'deepest', 'client', 'taken-out', 'asleep', 'game']) })
    expect(seen.filter(item => !item.shown).map(item => item.key)).toEqual(['chat:game', 'chat:dragged', 'chat:asleep'])
    expect(stepRow(seen, 'chat:ruled', 1)).toBe('chat:deepest')
    expect(stepRow(seen, 'chat:client', 1)).toBe('chat:taken-out')
    expect(stepRow(seen, 'chat:taken-out', 1)).toBe('space:wshell')
    expect(stepRow(seen, 'space:wshell', -1)).toBe('chat:taken-out')
    // Nothing shown yet: down starts at the top, up at the bottom.
    expect(stepRow(seen, '', 1)).toBe('space:wshell')
    expect(stepRow(seen, '', -1)).toBe('chat:taken-out')
    expect(stepRow([], '', 1)).toBeNull()
  })
})

describe('Spaces sidebar: drag and drop', () => {
  const folders = view().folders
  const context = (rule = '') => ({ folders, ruleFolderOf: () => rule })

  it('a chat dropped on a folder goes in it; on a chat, into that chat\'s folder', () => {
    expect(dropAction({ kind: 'chat', id: 'a' }, { kind: 'folder', id: 'c2' }, context())).toEqual({ kind: 'placeChat', sessionId: 'a', folderId: 'c2' })
    expect(dropAction({ kind: 'chat', id: 'a' }, { kind: 'item', folderId: 'c3' }, context())).toEqual({ kind: 'placeChat', sessionId: 'a', folderId: 'c3' })
    expect(dropAction({ kind: 'space', id: 'w1' }, { kind: 'folder', id: 'c1' }, context())).toEqual({ kind: 'placeSpace', workspaceId: 'w1', folderId: 'c1' })
  })

  it('dropped below the list (or on a loose chat): out of its folder, kept out where rules would collect it', () => {
    expect(dropAction({ kind: 'chat', id: 'a' }, { kind: 'end' }, context('c1'))).toEqual({ kind: 'placeChat', sessionId: 'a', folderId: '' })
    expect(dropAction({ kind: 'chat', id: 'a' }, { kind: 'end' }, context(''))).toEqual({ kind: 'placeChat', sessionId: 'a', folderId: null })
    expect(dropAction({ kind: 'chat', id: 'a' }, { kind: 'item', folderId: '' }, context('c1'))).toEqual({ kind: 'placeChat', sessionId: 'a', folderId: '' })
  })

  it('folders reorder by dragging: before the target going up, after it going down; across parents they move', () => {
    expect(dropAction({ kind: 'folder', id: 'c4' }, { kind: 'folder', id: 'c1' }, context())).toEqual({ kind: 'order', ids: ['c4', 'c1', 'c2', 'c3'] })
    expect(dropAction({ kind: 'folder', id: 'c1' }, { kind: 'folder', id: 'c4' }, context())).toEqual({ kind: 'order', ids: ['c2', 'c3', 'c4', 'c1'] })
    expect(dropAction({ kind: 'folder', id: 'c1' }, { kind: 'folder', id: 'c3' }, context())).toEqual({ kind: 'order', ids: ['c2', 'c1', 'c3', 'c4'], move: { id: 'c1', parentId: 'c2' } })
    expect(dropAction({ kind: 'folder', id: 'c3' }, { kind: 'end' }, context())).toEqual({ kind: 'order', ids: ['c1', 'c2', 'c4', 'c3'], move: { id: 'c3', parentId: '' } })
    // Not into itself or its own subfolder.
    expect(dropAction({ kind: 'folder', id: 'c2' }, { kind: 'folder', id: 'c3' }, context())).toBeNull()
    expect(dropAction({ kind: 'folder', id: 'c2' }, { kind: 'folder', id: 'c2' }, context())).toBeNull()
  })
})

describe('Spaces sidebar: rows look like Space Folders and Roundup', () => {
  it('stable avatars, and only what is unusual after the name', () => {
    expect(avatarColor('chat-1')).toBe(avatarColor('chat-1'))
    expect(avatarLetter('  herdr issues')).toBe('H')
    expect(avatarLetter('')).toBe('·')
    expect(repoTail({ repo: 'herdr', branch: 'main', ahead: 0, behind: 0, linked: false }, 'fix login')).toBe('herdr')
    expect(repoTail({ repo: 'herdr', branch: 'spike', ahead: 2, behind: 1, linked: false }, 'fix login')).toBe('herdr · spike ↑2 ↓1')
    expect(repoTail({ repo: 'herdr', branch: 'main', ahead: 0, behind: 0, linked: false }, 'herdr cleanup')).toBe('')
    expect(repoTail({ repo: 'herdr', branch: 'main', ahead: 0, behind: 3, linked: false }, 'herdr cleanup')).toBe('↓3')
    expect(repoTail(null, 'x')).toBe('')
  })
})

describe('Spaces sidebar: which sidebar shows', () => {
  const memory = () => {
    const data = new Map<string, string>()
    return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value) } }
  }

  it('Studio\'s Spaces by default; herdr\'s own when picked; remembered per viewer', async () => {
    const store = memory()
    expect(readSidebarPrefs(store)).toEqual({ mode: 'studio', open: true })
    writeSidebarPrefs({ mode: 'herdr', open: false }, store)
    expect(readSidebarPrefs(store)).toEqual({ mode: 'herdr', open: false })
    expect(readSidebarPrefs({ getItem: () => '{bad', setItem: () => {} })).toEqual({ mode: 'studio', open: true })
  })

  it('a drawer on phones, closed until opened; picking a chat closes it', () => {
    const phone = ref(true)
    const sidebar = useSpaceSidebar(phone, memory())
    expect(sidebar.open.value).toBe(false)
    sidebar.toggle()
    expect(sidebar.open.value).toBe(true)
    sidebar.picked()
    expect(sidebar.open.value).toBe(false)
    phone.value = false
    expect(sidebar.open.value).toBe(true)
    sidebar.setMode('herdr')
    expect(sidebar.open.value).toBe(false)
    sidebar.toggle()
    expect(sidebar.mode.value).toBe('studio')
    expect(sidebar.open.value).toBe(true)
  })
})
