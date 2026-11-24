import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SpaceFolderStore } from '../../packages/server/src/modules/coding-agents/services/herdr/folders'
import { buildFile, fileChanges, leafName, parseFile } from '../../packages/server/src/modules/coding-agents/services/herdr/space-folder-file'
import { SpaceFolderSync, spaceFoldersFile } from '../../packages/server/src/modules/coding-agents/services/herdr/space-folder-sync'

/** Studio's categories and chats in memory, the way the session-category store behaves. */
function fakeStudio() {
  const studio = {
    categories: [] as Array<{ id: number; name: string; parent_id: number | null }>,
    chats: [] as Array<{ id: string; title: string; agent: string; categoryId: number | null; workspace: string | null; workspaceId: string | null; lastActive: number }>,
    nextId: 1,
    changed: 0,
  }
  const add = (name: string, parent: number | null = null) => {
    const existing = studio.categories.find(c => c.name.toLowerCase() === name.toLowerCase() && c.parent_id === parent)
    if (existing) return existing
    const category = { id: studio.nextId++, name, parent_id: parent }
    studio.categories.push(category)
    return category
  }
  const chat = (id: string, categoryId: number | null, workspaceId: string | null) => {
    studio.chats.push({ id, title: id, agent: 'claude-code', categoryId, workspace: null, workspaceId, lastActive: 0 })
  }
  return { studio, add, chat }
}

describe('herdr-space-folders file ⇄ Studio folders', () => {
  let dir: string
  let clock: number
  let fake: ReturnType<typeof fakeStudio>
  let sync: SpaceFolderSync
  let file: string
  let store: SpaceFolderStore

  const readJson = async () => JSON.parse(await readFile(file, 'utf8'))
  /** Herdr App saves the file as the mod does: the whole state, a newer `at`. */
  const modSaves = async (change: (doc: any) => void) => {
    const doc = await readJson()
    change(doc)
    clock += 1000
    doc.at = clock
    await writeFile(file, `${JSON.stringify(doc)}\n`)
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'space-folders-'))
    file = join(dir, 'home', '.config', 'herdr-space-folders.json')
    store = new SpaceFolderStore(join(dir, 'studio', 'space-folders.json'))
    clock = 1_000_000
    fake = fakeStudio()
    const { studio } = fake
    sync = new SpaceFolderSync({
      file,
      store,
      now: () => clock,
      categories: () => studio.categories.map(c => ({ ...c })),
      chats: () => studio.chats.map(c => ({ ...c })),
      createCategory: (name, parent) => fake.add(name, parent),
      renameCategory: (id, name) => { studio.categories.find(c => c.id === id)!.name = name },
      moveCategory: (id, parent) => { studio.categories.find(c => c.id === id)!.parent_id = parent },
      deleteCategory: (id) => {
        const parent = studio.categories.find(c => c.id === id)?.parent_id ?? null
        for (const c of studio.categories) if (c.parent_id === id) c.parent_id = parent
        for (const c of studio.chats) if (c.categoryId === id) c.categoryId = parent
        studio.categories = studio.categories.filter(c => c.id !== id)
      },
      setChatCategory: (sessionId, categoryId) => { studio.chats.find(c => c.id === sessionId)!.categoryId = categoryId },
      changed: () => { studio.changed += 1 },
    })
  })
  afterEach(async () => {
    sync.stop()
    await rm(dir, { recursive: true, force: true })
  })

  it('writes Studio\'s folders as the mod reads them: flat, nested ones by path, colors and rules', async () => {
    const work = fake.add('Work')
    const clients = fake.add('Clients')
    const acme = fake.add('Acme', clients.id)
    fake.chat('chat-a', acme.id, 'w1')
    fake.chat('chat-b', work.id, 'w2')
    fake.chat('chat-c', null, 'w3')
    fake.chat('chat-asleep', work.id, null)
    await sync.updateFolder(`c${work.id}`, { color: 'blue', folded: true, start: '~/work', rules: '' })
    await sync.updateFolder(`c${acme.id}`, { color: 'pink', rules: 'acme-*, ~/code/acme' })
    await sync.placeChat('chat-c', '')
    const doc = await readJson()
    expect(doc.list).toEqual([
      { id: `c${clients.id}`, name: 'Clients', color: null, path: null, match: null, folded: false },
      { id: `c${acme.id}`, name: 'Clients / Acme', color: 'ansi1', path: null, match: 'acme-*, ~/code/acme', folded: false },
      { id: `c${work.id}`, name: 'Work', color: 'ansi4', path: '~/work', match: '~/work', folded: true },
    ])
    // Awake chats by their herdr space; a chat taken out of every folder is "".
    expect(doc.of).toEqual({ w1: `c${acme.id}`, w2: `c${work.id}`, w3: '' })
    expect(doc.at).toBeGreaterThan(0)
  })

  it('takes the mod\'s changes: rename, color, fold, rules, a drag, a new folder and a delete', async () => {
    const work = fake.add('Work')
    const clients = fake.add('Clients')
    const acme = fake.add('Acme', clients.id)
    const old = fake.add('Old')
    fake.chat('chat-a', null, 'w1')
    fake.chat('chat-b', work.id, 'w2')
    fake.chat('chat-c', old.id, 'w3')
    await sync.sync()
    await modSaves((doc) => {
      const byId = (id: number) => doc.list.find((f: any) => f.id === `c${id}`)
      Object.assign(byId(work.id), { name: 'Job', color: 'ansi2', folded: true, path: '~/job', match: '~/job' })
      byId(acme.id).name = 'Clients / Acme Corp'
      byId(clients.id).match = 'client-*'
      doc.list = doc.list.filter((f: any) => f.id !== `c${old.id}`)
      doc.list.unshift({ id: 'fmods', name: 'Herdr mods', color: 'ansi5', path: '~/mods', match: 'herdr-*', folded: false })
      doc.of.w1 = 'fmods'
      doc.of.w2 = ''
      delete doc.of.w3
    })
    const result = await sync.sync()
    expect(result.applied.length).toBeGreaterThan(0)
    const names = Object.fromEntries(fake.studio.categories.map(c => [c.id, c.name]))
    expect(names[work.id]).toBe('Job')
    expect(names[acme.id]).toBe('Acme Corp')
    expect(fake.studio.categories.some(c => c.id === old.id)).toBe(false)
    const mods = fake.studio.categories.find(c => c.name === 'Herdr mods')!
    expect(mods.parent_id).toBeNull()
    expect(fake.studio.chats.find(c => c.id === 'chat-a')!.categoryId).toBe(mods.id)
    expect(fake.studio.chats.find(c => c.id === 'chat-b')!.categoryId).toBeNull()
    // The deleted folder's chat moves up (its folder had no parent: no folder).
    expect(fake.studio.chats.find(c => c.id === 'chat-c')!.categoryId).toBeNull()
    const view = await sync.view()
    expect(view.folders.find(f => f.id === `c${work.id}`)).toMatchObject({ color: 'green', folded: true, start: '~/job', rules: '' })
    expect(view.folders.find(f => f.id === `c${clients.id}`)).toMatchObject({ rules: 'client-*' })
    expect(view.chats.find(c => c.id === 'chat-b')).toMatchObject({ folderId: '', out: true })
    // The new folder came first in the mod, and stays first.
    expect(view.folders[0].id).toBe(`c${mods.id}`)
    // The file is written back with Studio's id for the new folder.
    const doc = await readJson()
    expect(doc.list.map((f: any) => f.id)).toContain(`c${mods.id}`)
    expect(doc.list.map((f: any) => f.id)).not.toContain('fmods')
    expect(doc.of.w1).toBe(`c${mods.id}`)
    expect(doc.of.w2).toBe('')
    expect(fake.studio.changed).toBeGreaterThan(0)
    // A stale copy of the mod that still says "fmods" maps to the same folder.
    await modSaves((d) => { d.list = d.list.map((f: any) => (f.id === `c${mods.id}` ? { ...f, id: 'fmods', name: 'Mods' } : f)); d.of.w1 = 'fmods' })
    await sync.sync()
    expect(fake.studio.categories.filter(c => c.name === 'Mods' || c.name === 'Herdr mods')).toHaveLength(1)
    expect(fake.studio.categories.find(c => c.id === mods.id)!.name).toBe('Mods')
  })

  it('keeps what Studio does not use: unknown folder fields, unknown top-level fields, other spaces', async () => {
    const work = fake.add('Work')
    await sync.sync()
    await modSaves((doc) => {
      doc.list[0].icon = 'briefcase'
      doc.version = 3
      doc.of['w-shell'] = `c${work.id}`
    })
    await sync.sync()
    // Studio changes the folder; the unknown fields stay.
    await sync.updateFolder(`c${work.id}`, { color: 'teal' })
    const doc = await readJson()
    expect(doc.list[0]).toMatchObject({ id: `c${work.id}`, icon: 'briefcase', color: 'ansi6' })
    expect(doc.version).toBe(3)
    expect(doc.of['w-shell']).toBe(`c${work.id}`)
  })

  it('both sides changed the same thing: the newer one wins', async () => {
    const work = fake.add('Work')
    fake.chat('chat-a', null, 'w1')
    await sync.sync()
    // Studio renames first, then the mod renames later: the mod wins.
    const before = await readJson()
    fake.studio.categories[0].name = 'Studio name'
    clock += 10
    await sync.sync() // Studio's change is seen and written
    await writeFile(file, `${JSON.stringify({ ...before, list: [{ ...before.list[0], name: 'Mod name' }], at: clock + 500 })}\n`)
    await sync.sync()
    expect(fake.studio.categories.find(c => c.id === work.id)!.name).toBe('Mod name')
    // The mod saves an older copy (written before Studio's latest change): Studio wins.
    const stale = await readJson()
    clock += 5000
    await sync.updateFolder(`c${work.id}`, { name: 'Newest' })
    await writeFile(file, `${JSON.stringify({ ...stale, list: [{ ...stale.list[0], name: 'Older' }], at: clock - 1000 })}\n`)
    await sync.sync()
    expect(fake.studio.categories.find(c => c.id === work.id)!.name).toBe('Newest')
    expect((await readJson()).list[0].name).toBe('Newest')
  })

  it('the first sync adds the mod\'s folders and placements; Studio\'s own stay as they are', async () => {
    const work = fake.add('Work')
    fake.chat('chat-a', work.id, 'w1')
    fake.chat('chat-b', null, 'w2')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(dir, 'home', '.config'), { recursive: true })
    await writeFile(file, JSON.stringify({
      list: [{ id: 'f1', name: 'Games', color: 'ansi3', path: null, match: 'omasweeper', folded: true }, { id: 'f2', name: 'Work', folded: false }],
      of: { w1: 'f1', w2: 'f1' },
      at: 5,
    }))
    await sync.sync()
    const games = fake.studio.categories.find(c => c.name === 'Games')!
    expect(games).toBeTruthy()
    // "Work" in the mod is Studio's Work (same name): no second folder.
    expect(fake.studio.categories.filter(c => c.name === 'Work')).toHaveLength(1)
    expect(fake.studio.chats.find(c => c.id === 'chat-a')!.categoryId).toBe(work.id)
    expect(fake.studio.chats.find(c => c.id === 'chat-b')!.categoryId).toBe(games.id)
    const doc = await readJson()
    expect(doc.of).toEqual({ w1: `c${work.id}`, w2: `c${games.id}` })
  })

  it('changes from Studio\'s page go to the file at once: new folder, nesting, order, drag, delete', async () => {
    fake.chat('chat-a', null, 'w1')
    const a = await sync.createFolder({ name: 'Alpha', color: 'orange' })
    const b = await sync.createFolder({ name: 'Beta' })
    const child = await sync.createFolder({ name: 'Kid', parentId: a })
    expect((await readJson()).list.map((f: any) => f.name)).toEqual(['Alpha', 'Alpha / Kid', 'Beta'])
    await sync.orderFolders([b, a, child])
    expect((await readJson()).list.map((f: any) => f.name)).toEqual(['Beta', 'Alpha', 'Alpha / Kid'])
    await sync.orderFolders([b, child, a], { id: child, parentId: '' })
    expect((await readJson()).list.map((f: any) => f.name)).toEqual(['Beta', 'Kid', 'Alpha'])
    await sync.placeChat('chat-a', child)
    expect((await readJson()).of).toEqual({ w1: child })
    await sync.placeChat('chat-a', null)
    expect((await readJson()).of).toEqual({})
    await sync.deleteFolder(a)
    expect((await readJson()).list.map((f: any) => f.name)).toEqual(['Beta', 'Kid'])
  })

  it('leaves a broken file alone for a moment, then writes it again', async () => {
    fake.add('Work')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(dir, 'home', '.config'), { recursive: true })
    await writeFile(file, '{ "list": [')
    expect((await sync.sync()).wrote).toBe(false)
    expect((await sync.sync()).wrote).toBe(false)
    expect((await sync.sync()).wrote).toBe(true)
    expect((await readJson()).list[0].name).toBe('Work')
  })
})

describe('space folder file helpers', () => {
  it('parses the mod\'s file and rejects garbage', () => {
    expect(parseFile('')).toBeNull()
    expect(parseFile('[1]')).toBeNull()
    expect(parseFile('{"list":[{"id":"a","name":"A"},{"id":"bad id"},{}],"of":{"w1":"a","w2":3},"at":7,"x":1}'))
      .toEqual({ list: [{ id: 'a', name: 'A' }], of: { w1: 'a' }, at: 7, x: 1 })
  })

  it('names a nested folder by its last part when the mod renames it', () => {
    expect(leafName('Clients / Acme Corp', ['Clients'])).toBe('Acme Corp')
    expect(leafName('Something else', ['Clients'])).toBe('Something else')
    expect(leafName('Top', [])).toBe('Top')
  })

  it('a folder made in the mod with the start folder mirrored into its rules has no rules of its own', () => {
    const studio = { categories: [], chats: [], meta: { list: [], of: {}, at: 0, synced: { at: 1, list: [], of: {} } } }
    const ops = fileChanges({ list: [{ id: 'f1', name: 'X', path: '~/x', match: '~/x' }], of: {}, at: 2 }, studio as any)
    expect(ops[0]).toMatchObject({ kind: 'create', name: 'X', start: '~/x', rules: '' })
    expect(buildFile(studio as any)).toEqual({ list: [], of: {} })
  })

  it('finds the file in the home of the machine herdr runs on, or where the environment says', () => {
    expect(spaceFoldersFile({ HOME: '/home/me' })).toBe('/home/me/.config/herdr-space-folders.json')
    expect(spaceFoldersFile({ HOME: '/home/me', HERMES_HERDR_SPACE_FOLDERS_FILE: 'off' })).toBeNull()
    expect(spaceFoldersFile({ HERMES_HERDR_SPACE_FOLDERS_FILE: '/tmp/x.json' })).toBe('/tmp/x.json')
  })
})
