import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// In-memory stand-ins for Studio's chat and folder tables.
const db = vi.hoisted(() => ({
  sessions: new Map<string, any>(),
  categories: [] as Array<{ id: number; name: string; parent_id: number | null }>,
  messages: new Map<string, Array<{ role: string; content: string }>>(),
}))

vi.mock('../../packages/server/src/modules/studio/public/sessions', () => ({
  createSession: (row: any) => { db.sessions.set(row.id, { ...row }); return row },
  getSession: (id: string) => db.sessions.get(id) || null,
  updateSession: (id: string, change: any) => { const row = db.sessions.get(id); if (row) Object.assign(row, change) },
  setSessionCategory: (id: string, categoryId: number | null) => { const row = db.sessions.get(id); if (!row) return false; row.category_id = categoryId; return true },
  findSessionCategoryByName: (name: string) => db.categories.find(item => item.name.toLowerCase() === name.toLowerCase()) || null,
  createSessionCategory: (name: string) => { const row = { id: db.categories.length + 1, name, parent_id: null }; db.categories.push(row); return row },
  getSessionCategory: (id: number) => db.categories.find(item => item.id === id) || null,
  renameSessionCategory: (id: number, name: string) => { const row = db.categories.find(item => item.id === id); if (row) row.name = name; return row || null },
  getRecentSessionMessages: (id: string, limit: number) => (db.messages.get(id) || []).slice(-limit).map((row, index) => ({ id: index, session_id: id, ...row })),
}))

import { ProjectStore } from '../../packages/server/src/modules/studio/services/projects/store'
import { ProjectService, projectContextBlock, threadPrompt, type ProjectRuntime } from '../../packages/server/src/modules/studio/services/projects/service'

function fakeRuntime(overrides: Partial<ProjectRuntime> = {}) {
  const launches: any[] = []
  const messages: any[] = []
  const panes = new Map<string, { session: string | null; status: any }>()
  const runtime: ProjectRuntime = {
    canRun: agent => ['claude-code', 'codex', 'hermes'].includes(agent),
    launch: async input => {
      launches.push(input)
      const paneId = `w${launches.length}:p1`
      panes.set(paneId, { session: null, status: 'working' })
      return { paneId }
    },
    sessionForPane: paneId => panes.get(paneId)?.session ?? null,
    statusForPane: paneId => panes.get(paneId)?.status ?? null,
    message: async input => { messages.push(input) },
    ...overrides,
  }
  return { runtime, launches, messages, panes }
}

let dir = ''
let store: ProjectStore
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'studio-projects-'))
  store = new ProjectStore(join(dir, 'projects.json'))
  db.sessions.clear(); db.categories.length = 0; db.messages.clear()
})
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

describe('TestProjects_store', () => {
  it('keeps projects on disk, refuses a second project with the same name and finds a chat\'s role', async () => {
    const created = await store.create({ name: '  Homelab  ', folder: '/srv/homelab', instructions: 'Target dev.', profile: 'default', categoryId: 3, coordinatorSessionId: 'coord-1', defaultAgent: 'codex' })
    expect(created.name).toBe('Homelab')
    await expect(store.create({ name: 'homelab', folder: '', instructions: '', profile: 'default', categoryId: null, coordinatorSessionId: 'c2', defaultAgent: '' }))
      .rejects.toMatchObject({ status: 409 })
    await store.update(created.id, project => ({ ...project, threads: [{ id: 't1', title: 'Fix', agent: 'codex', brief: 'b', paneId: 'w1:p1', sessionId: 'chat-1', status: 'working', resolved: false, createdAt: 1, updatedAt: 1 }] }))

    const reloaded = new ProjectStore(join(dir, 'projects.json'))
    expect((await reloaded.find('HOMELAB'))?.id).toBe(created.id)
    expect((await reloaded.forSession('coord-1'))?.role).toBe('coordinator')
    expect((await reloaded.forSession('chat-1'))?.role).toBe('thread')
    expect(await reloaded.forSession('other')).toBeNull()
    expect(JSON.parse(await readFile(join(dir, 'projects.json'), 'utf8')).version).toBe(1)
  })
})

describe('TestProjects_service', () => {
  it('a new project is a chat folder with a Hermes coordinator chat in it', async () => {
    const service = new ProjectService({ store, runtime: () => null })
    const project = await service.create({ name: 'Homelab', folder: '/srv/homelab', instructions: 'Target dev.' })
    expect(db.categories).toEqual([{ id: 1, name: 'Homelab', parent_id: null }])
    expect(db.sessions.get(project.coordinatorSessionId)).toMatchObject({ agent: 'hermes', source: 'cli', category_id: 1, workspace: '/srv/homelab' })
    // An existing folder of the same name becomes the project's folder.
    db.categories.push({ id: 2, name: 'Garage', parent_id: null })
    expect((await service.create({ name: 'Garage' })).categoryId).toBe(2)
  })

  it('a thread launches its agent in herdr with the rules and the brief, in the project folder', async () => {
    const { runtime, launches, panes } = fakeRuntime()
    const service = new ProjectService({ store, runtime: () => runtime })
    const project = await service.create({ name: 'Homelab', folder: '/srv/homelab', instructions: 'Target the dev branch.', defaultAgent: 'codex' })
    const thread = await service.startThread('homelab', { brief: 'Fix the flaky login test\nIt fails one run in five.', title: '' })
    expect(launches[0]).toMatchObject({ agentId: 'codex', workspace: '/srv/homelab', project: { id: project.id, thread: thread.id }, title: 'Fix the flaky login test' })
    expect(launches[0].prompt).toContain('Target the dev branch.')
    expect(launches[0].prompt).toContain('It fails one run in five.')
    expect(thread).toMatchObject({ paneId: 'w1:p1', sessionId: '', status: 'starting', liveStatus: 'working' })

    // herdr links the agent's chat later; the list picks it up and the chat counts as a thread.
    panes.set('w1:p1', { session: 'herdr-abc', status: 'blocked' })
    const view = await service.get(project.id)
    expect(view.threads[0]).toMatchObject({ sessionId: 'herdr-abc', liveStatus: 'blocked' })
    expect(view.counts).toMatchObject({ needsYou: 1, working: 0 })
    expect((await service.forSession('herdr-abc'))?.role).toBe('thread')
  })

  it('refuses a thread without a brief, an agent herdr cannot run, and any thread while herdr is off', async () => {
    const { runtime } = fakeRuntime()
    let rt: ProjectRuntime | null = runtime
    const service = new ProjectService({ store, runtime: () => rt })
    const project = await service.create({ name: 'Homelab' })
    await expect(service.startThread(project.id, { brief: ' ' })).rejects.toMatchObject({ status: 400 })
    await expect(service.startThread(project.id, { brief: 'x', agent: 'ekko-agent' })).rejects.toMatchObject({ status: 400 })
    rt = null
    await expect(service.startThread(project.id, { brief: 'x' })).rejects.toMatchObject({ status: 409 })
  })

  it('messages go to the thread\'s agent, but never into an approval on its screen', async () => {
    const { runtime, messages, panes } = fakeRuntime()
    const service = new ProjectService({ store, runtime: () => runtime })
    const project = await service.create({ name: 'Homelab' })
    const thread = await service.startThread(project.id, { brief: 'Do it', agent: 'claude-code' })
    await service.messageThread(project.id, thread.id, 'Also update the docs')
    expect(messages).toEqual([{ sessionId: '', paneId: 'w1:p1', text: 'Also update the docs' }])
    panes.set('w1:p1', { session: null, status: 'blocked' })
    await expect(service.messageThread(project.id, thread.id, 'go on')).rejects.toMatchObject({ status: 409 })
  })

  it('herdr status reports, resolving and reading a thread', async () => {
    const { runtime } = fakeRuntime({ statusForPane: () => null })
    const service = new ProjectService({ store, runtime: () => runtime })
    const project = await service.create({ name: 'Homelab' })
    const thread = await service.startThread(project.id, { brief: 'Do it', agent: 'codex' })
    await service.threadStatusChanged({ id: project.id, thread: thread.id }, 'w1:p1', 'done', 'chat-9')
    db.sessions.set('chat-9', { id: 'chat-9' })
    db.messages.set('chat-9', [{ role: 'user', content: 'Do it' }, { role: 'assistant', content: '[{"type":"text","text":"Fixed in abc123"}]' }])
    const read = await service.readThread(project.id, 'chat-9')
    expect(read.thread).toMatchObject({ status: 'done', sessionId: 'chat-9' })
    expect(read.messages.at(-1)).toEqual({ role: 'assistant', text: 'Fixed in abc123' })
    const resolved = await service.setResolved(project.id, thread.id, true)
    expect(resolved.resolved).toBe(true)
    expect((await service.get(project.id)).counts).toMatchObject({ resolved: 1, done: 0 })
    expect(await service.folderFor({ id: project.id })).toEqual({ categoryId: 1, workspace: '' })
  })

  it('an existing chat can join one project, not two', async () => {
    const service = new ProjectService({ store, runtime: () => null })
    const a = await service.create({ name: 'A' })
    const b = await service.create({ name: 'B' })
    db.sessions.set('old-chat', { id: 'old-chat', title: 'Old chat', agent: 'claude-code' })
    const thread = await service.adoptChat(a.id, 'old-chat')
    expect(thread).toMatchObject({ sessionId: 'old-chat', title: 'Old chat', agent: 'claude-code' })
    expect(db.sessions.get('old-chat').category_id).toBe(a.categoryId)
    await expect(service.adoptChat(b.id, 'old-chat')).rejects.toMatchObject({ status: 409 })
    await expect(service.adoptChat(b.id, b.coordinatorSessionId)).rejects.toMatchObject({ status: 409 })
    await service.releaseChat(a.id, thread.id)
    expect((await service.get(a.id)).threads).toEqual([])
  })

  it('the coordinator\'s turn context lists open threads and names its tool; a thread gets the rules', async () => {
    const { runtime } = fakeRuntime()
    const service = new ProjectService({ store, runtime: () => runtime })
    const project = await service.create({ name: 'Homelab', instructions: 'Never push to main.' })
    await service.startThread(project.id, { brief: 'Fix it', title: 'Fix login', agent: 'codex' })
    const coordinator = await service.contextFor(project.coordinatorSessionId)
    expect(coordinator).toContain('<studio_project_context>')
    expect(coordinator).toContain('ekko_studio_use_project')
    expect(coordinator).toContain('Fix login · codex · working')
    expect(coordinator).toContain('Never push to main.')
    expect(await service.contextFor('unrelated')).toBe('')
    expect(projectContextBlock({ ...project, threads: [] } as any, 'thread')).toContain('a thread of the Studio project "Homelab"')
    expect(threadPrompt({ name: 'Homelab', instructions: '' }, { title: 'T', brief: 'B' })).not.toContain('Project instructions')
  })
})
