import { describe, expect, it, vi } from 'vitest'
vi.mock('@/api/studio/sessions', () => ({}))
vi.mock('@/api/coding-agents/herdr', () => ({}))
vi.mock('@/api/coding-agents', () => ({}))
vi.mock('@/api/studio/orb', () => ({ fetchOrbStatus: async () => ({ settings: { url: '' } }) }))
import { buildFolderTree, folderForSpace } from '@/mission/useFolders'

const cat = (id: number, name: string, parent_id: number | null = null) => ({ id, name, parent_id, created_at: 0, updated_at: 0 })
const categories = [cat(1, 'Clients'), cat(2, 'acme', 1), cat(3, 'api', 2), cat(4, 'Home')]
const meta = { list: [{ id: 'c2', name: 'acme', color: 'teal', folded: false, start: '~/code/acme', rules: '' }], of: { w9: 'c4' }, at: 1 }

describe('Mission folders are Studio chat folders', () => {
  it('builds the same nesting as Studio, with Mission colors and start folders', () => {
    const tree = buildFolderTree(categories, meta)
    expect(tree.map(f => `${'  '.repeat(f.depth)}${f.name}`)).toEqual(['Clients', '  acme', '    api', 'Home'])
    expect(tree.find(f => f.id === 'c2')).toMatchObject({ color: 'teal', start: '~/code/acme', parentId: 'c1', categoryId: 2 })
    expect(tree.find(f => f.id === 'c3')).toMatchObject({ parentId: 'c2', depth: 2, color: '' })
  })

  it('places a space by its chat folder first, then where it was dropped, then by directory', () => {
    const folders = buildFolderTree(categories, meta)
    const panes: any[] = [
      { pane_id: 'w1:p1', workspace_id: 'w1', studioSessionId: 'chat-a' },
      { pane_id: 'w9:p1', workspace_id: 'w9', studioSessionId: null },
    ]
    const chatFolders = new Map<string, number | null>([['chat-a', 3]])
    const place = (spaceId: string, cwd: string) => folderForSpace({ spaceId, panes, cwd, home: '/home/me', folders, meta, chatFolders })
    expect(place('w1', '/tmp')).toBe('c3')
    expect(place('w9', '/home/me/code/acme/x')).toBe('c4')
    expect(place('w5', '/home/me/code/acme/web')).toBe('c2')
    expect(place('w6', '/tmp')).toBe('')
    // A chat moved out of every folder in Studio is no longer pinned by it.
    chatFolders.set('chat-a', null)
    expect(place('w1', '/home/me/code/acme')).toBe('c2')
  })
})
