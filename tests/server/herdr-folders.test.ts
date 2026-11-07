import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { folderFor, ruleDepth, sanitizeFolders, SpaceFolderStore } from '../../packages/server/src/modules/coding-agents/services/herdr/folders'

describe('herdr space folders', () => {
  const home = '/home/me'

  it('sanitizes folders: drops bad ids and duplicates, unknown colors and placements', () => {
    const state = sanitizeFolders({
      list: [
        { id: 'a1', name: '  Client  ', color: 'teal', rules: '~/code/client' },
        { id: 'a1', name: 'dupe' },
        { id: 'bad id!', name: 'x' },
        { id: 'b2', name: '', color: '#ff0000', folded: 'yes' },
      ],
      of: { 'w1': 'a1', 'w2': 'missing', 'w3': '', 'bad space!': 'a1' },
      at: 5,
    })
    expect(state.list.map(f => f.id)).toEqual(['a1', 'b2'])
    expect(state.list[0]).toMatchObject({ name: 'Client', color: 'teal', rules: '~/code/client', folded: false })
    expect(state.list[1]).toMatchObject({ name: 'New folder', color: '', folded: false })
    expect(state.of).toEqual({ w1: 'a1', w3: '' })
    expect(state.at).toBe(5)
    expect(sanitizeFolders(null).list).toEqual([])
  })

  it('matches path rules as prefixes, names at any depth, and globs', () => {
    expect(ruleDepth('~/code', '/home/me/code/site', home)).toBe(3)
    expect(ruleDepth('~/code/client', '/home/me/code/site', home)).toBe(-1)
    expect(ruleDepth('client-*', '/home/me/code/client-acme/api', home)).toBe(4)
    expect(ruleDepth('/srv/*/app', '/srv/blue/app/src', home)).toBe(3)
    expect(ruleDepth('', '/home/me', home)).toBe(-1)
    expect(ruleDepth('~/code', '', home)).toBe(-1)
  })

  it('puts a space in the deepest matching folder unless placed by hand', () => {
    const state = sanitizeFolders({
      list: [
        { id: 'code', name: 'Code', rules: '~/code' },
        { id: 'client', name: 'Client', rules: 'nothing, ~/code/client' },
      ],
      of: { manual: 'code', loose: '' },
    })
    expect(folderFor(state, 'w1', '/home/me/code/client/api', home)).toBe('client')
    expect(folderFor(state, 'w2', '/home/me/code/site', home)).toBe('code')
    expect(folderFor(state, 'w3', '/tmp', home)).toBe('')
    expect(folderFor(state, 'manual', '/home/me/code/client', home)).toBe('code')
    expect(folderFor(state, 'loose', '/home/me/code/client', home)).toBe('')
  })

  describe('store', () => {
    let dir: string
    beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'herdr-folders-')) })
    afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

    it('persists sanitized state', async () => {
      const file = join(dir, 'nested', 'space-folders.json')
      const store = new SpaceFolderStore(file)
      const saved = await store.save({ list: [{ id: 'x', name: 'X', color: 'pink' }, { id: '' }], of: { w1: 'x' } })
      expect(saved.list).toHaveLength(1)
      const raw = JSON.parse(await readFile(file, 'utf8'))
      expect(raw.list[0]).toMatchObject({ id: 'x', color: 'pink' })
      expect((await new SpaceFolderStore(file).load()).of).toEqual({ w1: 'x' })
    })
  })
})
