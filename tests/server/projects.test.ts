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

const current = vi.hoisted(() => ({ service: null as any }))
vi.mock('../../packages/server/src/modules/studio/services/projects/service', async importOriginal => ({
  ...(await importOriginal<any>()),
  projectService: () => current.service,
}))

import { ProjectStore } from '../../packages/server/src/modules/studio/services/projects/store'
import * as projectController from '../../packages/server/src/modules/studio/controllers/projects'
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

describe('TestProjects_worktrees', () => {
  it('in a git repo each thread gets its own worktree and branch; leaving the project removes a clean one', async () => {
    const { execFileSync } = await import('node:child_process')
    const { existsSync } = await import('node:fs')
    const { writeFile: write } = await import('node:fs/promises')
    const repo = join(dir, 'repo')
    execFileSync('git', ['init', '-q', '-b', 'main', repo])
    await write(join(repo, 'a.txt'), 'a\n')
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { encoding: 'utf8' }).trim()
    git('add', '-A'); git('commit', '-qm', 'start')

    const fake = fakeRuntime()
    const service = new ProjectService({ store, runtime: () => fake.runtime, worktreeRoot: join(dir, 'worktrees') })
    const project = await service.create({ name: 'Repo', folder: repo })
    const one = await service.startThread(project.id, { brief: 'Fix the login test' })
    const two = await service.startThread(project.id, { brief: 'Write the docs', title: 'Docs!' })

    expect(one.branch).toBe(`studio/fix-the-login-test-${one.id}`)
    expect(two.branch).toBe(`studio/docs-${two.id}`)
    expect(fake.launches.map(launch => launch.workspace)).toEqual([join(dir, 'worktrees', project.id, one.id), join(dir, 'worktrees', project.id, two.id)])
    expect(fake.launches[0].prompt).toContain(`own git worktree on the branch ${one.branch}`)
    expect(git('branch', '--list', '--format=%(refname:short)', 'studio/*').split('\n').sort()).toEqual([one.branch, two.branch].sort())
    expect(await service.folderFor({ id: project.id, thread: two.id })).toMatchObject({ workspace: two.workspace })
    expect(await service.contextFor(project.coordinatorSessionId)).toContain(`· ${one.branch}`)

    // A dirty worktree stays; a clean one goes, and its branch stays.
    await write(join(two.workspace, 'draft.md'), 'wip\n')
    expect((await service.releaseChat(project.id, two.id)).worktree?.removed).toBe(false)
    expect(existsSync(two.workspace)).toBe(true)
    expect((await service.releaseChat(project.id, one.id)).worktree).toEqual({ removed: true })
    expect(existsSync(one.workspace)).toBe(false)
    expect(git('branch', '--list', one.branch)).toContain(one.branch)
  })

  it('outside a git repo, or with worktrees off, threads share the project folder', async () => {
    const fake = fakeRuntime()
    const service = new ProjectService({ store, runtime: () => fake.runtime, worktreeRoot: join(dir, 'worktrees') })
    const plain = await service.create({ name: 'Plain', folder: dir })
    const thread = await service.startThread(plain.id, { brief: 'Tidy' })
    expect(thread).toMatchObject({ workspace: dir, branch: '' })
    expect(fake.launches[0].prompt).not.toContain('worktree')
    const off = await service.create({ name: 'Off', folder: dir, worktrees: false })
    expect(off.worktrees).toBe(false)
    expect((await service.update(off.id, { worktrees: true })).worktrees).toBe(true)
  })
})

describe('TestProjects_wakeCoordinator', () => {
  function waker() {
    const runs: any[] = []
    let busy = false
    return { runs, setBusy: (value: boolean) => { busy = value }, waker: { busy: () => busy, run: async (input: any) => { runs.push(input) } } }
  }

  it('wakes the coordinator once with what finished and what needs the person', async () => {
    const fake = fakeRuntime()
    const w = waker()
    const service = new ProjectService({ store, runtime: () => fake.runtime, waker: () => w.waker, wakeDelayMs: 60_000 })
    const project = await service.create({ name: 'Homelab', folder: '/srv/homelab' })
    const one = await service.startThread(project.id, { brief: 'Fix the login test' })
    const two = await service.startThread(project.id, { brief: 'Upgrade herdr' })
    db.sessions.set('chat-1', { id: 'chat-1' })
    db.messages.set('chat-1', [{ role: 'user', content: 'brief' }, { role: 'assistant', content: 'Fixed it on the branch.' }])

    fake.panes.get(one.paneId)!.status = 'done'
    await service.threadStatusChanged({ id: project.id, thread: one.id }, one.paneId, 'done', 'chat-1')
    fake.panes.get(two.paneId)!.status = 'blocked'
    await service.threadStatusChanged({ id: project.id, thread: two.id }, two.paneId, 'blocked')
    // A repeated report of the same state does not queue again.
    await service.threadStatusChanged({ id: project.id, thread: one.id }, one.paneId, 'done', 'chat-1')

    // The coordinator is mid-run: the wake waits for it.
    w.setBusy(true)
    expect(await service.flushWake(project.id)).toBe(false)
    w.setBusy(false)
    expect(await service.flushWake(project.id)).toBe(true)
    expect(w.runs).toHaveLength(1)
    expect(w.runs[0]).toMatchObject({ sessionId: project.coordinatorSessionId, profile: 'default', display: 'Project update: “Fix the login test” is done, “Upgrade herdr” needs you.' })
    expect(w.runs[0].input).toContain('<studio_project_event>')
    expect(w.runs[0].input).toContain(`${one.id} · Fix the login test · claude-code: finished its turn.`)
    expect(w.runs[0].input).toContain('Fixed it on the branch.')
    expect(w.runs[0].input).toContain(`${two.id} · Upgrade herdr · claude-code: needs the person`)
    expect(await service.flushWake(project.id)).toBe(false)
  })

  it('skips a thread that went back to work, and projects with wake-ups off', async () => {
    const fake = fakeRuntime()
    const w = waker()
    const service = new ProjectService({ store, runtime: () => fake.runtime, waker: () => w.waker, wakeDelayMs: 60_000 })
    const project = await service.create({ name: 'Homelab', folder: '/srv/homelab' })
    const thread = await service.startThread(project.id, { brief: 'Fix it' })
    await service.threadStatusChanged({ id: project.id, thread: thread.id }, thread.paneId, 'done')
    fake.panes.get(thread.paneId)!.status = 'working'
    expect(await service.flushWake(project.id)).toBe(false)
    expect(w.runs).toEqual([])

    const quiet = await service.create({ name: 'Quiet', folder: '/srv/q', wakeCoordinator: false })
    const other = await service.startThread(quiet.id, { brief: 'Fix it' })
    await service.threadStatusChanged({ id: quiet.id, thread: other.id }, other.paneId, 'done')
    expect(await service.flushWake(quiet.id)).toBe(false)
    expect(w.runs).toEqual([])
  })
})

describe('TestProjects_edgeCases', () => {
  async function gitRepo(withCommit = true) {
    const { execFileSync } = await import('node:child_process')
    const { mkdir: mk, writeFile: write } = await import('node:fs/promises')
    const repo = join(dir, 'repo')
    execFileSync('git', ['init', '-q', '-b', 'main', repo])
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { encoding: 'utf8' }).trim()
    if (withCommit) {
      await mk(join(repo, 'apps', 'web'), { recursive: true })
      await write(join(repo, 'apps', 'web', 'index.ts'), 'x\n')
      git('add', '-A'); git('commit', '-qm', 'start')
    }
    return { repo, git }
  }

  it('a launch that fails leaves no thread and no worktree behind', async () => {
    const { existsSync } = await import('node:fs')
    const { repo, git } = await gitRepo()
    const fake = fakeRuntime({ launch: async () => { throw new Error('herdr is not running') } })
    const service = new ProjectService({ store, runtime: () => fake.runtime, worktreeRoot: join(dir, 'worktrees') })
    const project = await service.create({ name: 'Repo', folder: repo })
    await expect(service.startThread(project.id, { brief: 'Fix it' })).rejects.toThrow('herdr is not running')
    expect((await service.get(project.id)).threads).toEqual([])
    expect(existsSync(join(dir, 'worktrees', project.id))).toBe(true)
    expect(git('worktree', 'list').split('\n')).toHaveLength(1)
  })

  it('a repo with no commits refuses the thread with a 409 and saves nothing', async () => {
    const { repo } = await gitRepo(false)
    const fake = fakeRuntime()
    const service = new ProjectService({ store, runtime: () => fake.runtime, worktreeRoot: join(dir, 'worktrees') })
    const project = await service.create({ name: 'Empty', folder: repo })
    await expect(service.startThread(project.id, { brief: 'Fix it' })).rejects.toMatchObject({ status: 409, message: expect.stringContaining('Could not make a git worktree') })
    expect((await service.get(project.id)).threads).toEqual([])
    expect(fake.launches).toEqual([])
  })

  it('a project folder inside a repo maps to the same subfolder of the thread\'s checkout', async () => {
    const { repo } = await gitRepo()
    const fake = fakeRuntime()
    const service = new ProjectService({ store, runtime: () => fake.runtime, worktreeRoot: join(dir, 'worktrees') })
    const project = await service.create({ name: 'Web', folder: join(repo, 'apps', 'web') })
    const thread = await service.startThread(project.id, { brief: 'Fix the page' })
    expect(thread.workspace).toBe(join(dir, 'worktrees', project.id, thread.id, 'apps', 'web'))
    expect(fake.launches[0].workspace).toBe(thread.workspace)
  })

  it('a title with no latin letters still gets a branch from the thread id', async () => {
    const { repo } = await gitRepo()
    const fake = fakeRuntime()
    const service = new ProjectService({ store, runtime: () => fake.runtime, worktreeRoot: join(dir, 'worktrees') })
    const project = await service.create({ name: 'Repo', folder: repo })
    const thread = await service.startThread(project.id, { brief: 'Fix it', title: '修复 🚀' })
    expect(thread.branch).toBe(`studio/${thread.id}`)
  })

  it('a coordinator run that fails is logged, not thrown into the timer', async () => {
    vi.useFakeTimers()
    try {
      const fake = fakeRuntime()
      const service = new ProjectService({ store, runtime: () => fake.runtime, waker: () => ({ busy: () => false, run: async () => { throw new Error('model down') } }), wakeDelayMs: 10 })
      const project = await service.create({ name: 'Homelab', folder: '/srv/homelab' })
      const thread = await service.startThread(project.id, { brief: 'Fix it' })
      fake.panes.get(thread.paneId)!.status = 'done'
      const unhandled = vi.fn()
      process.on('unhandledRejection', unhandled)
      await service.threadStatusChanged({ id: project.id, thread: thread.id }, thread.paneId, 'done')
      await vi.advanceTimersByTimeAsync(50)
      vi.useRealTimers()
      await new Promise(resolve => setTimeout(resolve, 20))
      process.off('unhandledRejection', unhandled)
      expect(unhandled).not.toHaveBeenCalled()
    } finally { vi.useRealTimers() }
  })

  it('resolved threads do not wake the coordinator, and reports for unknown threads do nothing', async () => {
    const fake = fakeRuntime()
    const runs: any[] = []
    const service = new ProjectService({ store, runtime: () => fake.runtime, waker: () => ({ busy: () => false, run: async (input: any) => { runs.push(input) } }), wakeDelayMs: 60_000 })
    const project = await service.create({ name: 'Homelab', folder: '/srv/homelab' })
    const thread = await service.startThread(project.id, { brief: 'Fix it' })
    await service.setResolved(project.id, thread.id, true)
    fake.panes.get(thread.paneId)!.status = 'done'
    await service.threadStatusChanged({ id: project.id, thread: thread.id }, thread.paneId, 'done')
    await service.threadStatusChanged({ id: project.id, thread: 'nope' }, 'w9:p1', 'done')
    await service.threadStatusChanged({ id: 'missing', thread: thread.id }, thread.paneId, 'done')
    expect(await service.flushWake(project.id)).toBe(false)
    expect(runs).toEqual([])
    expect((await service.get(project.id)).threads).toHaveLength(1)
    expect(await service.folderFor({ id: project.id, thread: 'nope' })).toMatchObject({ workspace: '/srv/homelab' })
    expect(await service.folderFor({ id: 'missing' })).toBeNull()
  })

  it('an unknown agent is refused, and a failed message to a thread reaches the caller', async () => {
    const fake = fakeRuntime({ message: async () => { throw new Error('pane closed') } })
    const service = new ProjectService({ store, runtime: () => fake.runtime })
    const project = await service.create({ name: 'Homelab', folder: '/srv/homelab' })
    await expect(service.startThread(project.id, { brief: 'Fix it', agent: 'grok' })).rejects.toMatchObject({ status: 400, message: expect.stringContaining('grok cannot run in herdr') })
    const thread = await service.startThread(project.id, { brief: 'Fix it' })
    await expect(service.messageThread(project.id, thread.id, 'go on')).rejects.toThrow('pane closed')
    await expect(service.messageThread(project.id, thread.id, '   ')).rejects.toMatchObject({ status: 400 })
    await expect(service.messageThread(project.id, 'nope', 'hi')).rejects.toMatchObject({ status: 404 })
  })

  it('a message to a resolved thread reopens it', async () => {
    const fake = fakeRuntime()
    const service = new ProjectService({ store, runtime: () => fake.runtime })
    const project = await service.create({ name: 'Homelab', folder: '/srv/homelab' })
    const thread = await service.startThread(project.id, { brief: 'Fix it' })
    await service.setResolved(project.id, thread.id, true)
    await service.messageThread(project.id, thread.id, 'One more thing')
    expect((await service.get(project.id)).threads[0].resolved).toBe(false)
    expect(fake.messages).toHaveLength(1)
  })
})

describe('TestProjects_board', () => {
  it('tasks move across columns, start as threads, and PR links are checked', async () => {
    const fake = fakeRuntime()
    const service = new ProjectService({ store, runtime: () => fake.runtime })
    const project = await service.create({ name: 'Homelab', folder: '/srv/homelab' })
    const task = await service.addTask(project.id, { title: 'Add a Grafana panel', notes: 'GPU temps per card.' })
    expect(task).toMatchObject({ column: 'todo', pr: '', threadId: '' })
    await expect(service.addTask(project.id, { title: '  ' })).rejects.toMatchObject({ status: 400 })
    await expect(service.updateTask(project.id, task.id, { column: 'someday' })).rejects.toMatchObject({ status: 400 })
    await expect(service.updateTask(project.id, task.id, { pr: 'javascript:alert(1)' })).rejects.toMatchObject({ status: 400 })
    expect(await service.updateTask(project.id, task.id, { column: 'Doing', pr: 'https://github.com/o/r/pull/7' })).toMatchObject({ column: 'doing', pr: 'https://github.com/o/r/pull/7' })

    const started = await service.startTask(project.id, task.id, { agent: 'codex' })
    expect(started.task).toMatchObject({ threadId: started.thread.id, column: 'doing' })
    expect(started.thread).toMatchObject({ title: 'Add a Grafana panel', agent: 'codex', pr: 'https://github.com/o/r/pull/7' })
    expect(fake.launches[0].prompt).toContain('GPU temps per card.')
    await expect(service.startTask(project.id, task.id)).rejects.toMatchObject({ status: 409 })
    // Tasks started as threads leave the coordinator's to-do list.
    const loose = await service.addTask(project.id, { title: 'Follow PR 9', column: 'review', pr: 'https://gitlab.example/g/r/-/merge_requests/9' })
    const context = await service.contextFor(project.coordinatorSessionId)
    expect(context).toContain(`${loose.id} · review · Follow PR 9`)
    expect(context).not.toContain(`${task.id} · doing`)
    expect(await service.removeTask(project.id, loose.id)).toEqual({ removed: true })
    await expect(service.removeTask(project.id, loose.id)).rejects.toMatchObject({ status: 404 })
  })

  it('a thread that finishes naming a pull request gets it linked, and set_pr can change it', async () => {
    const fake = fakeRuntime()
    const service = new ProjectService({ store, runtime: () => fake.runtime })
    const project = await service.create({ name: 'Homelab', folder: '/srv/homelab' })
    const thread = await service.startThread(project.id, { brief: 'Fix it' })
    db.sessions.set('chat-9', { id: 'chat-9' })
    db.messages.set('chat-9', [{ role: 'assistant', content: 'Opened https://github.com/Wizard815/argos/pull/41. Done.' }])
    await service.threadStatusChanged({ id: project.id, thread: thread.id }, thread.paneId, 'done', 'chat-9')
    expect((await service.get(project.id)).threads[0].pr).toBe('https://github.com/Wizard815/argos/pull/41')
    expect((await service.setThreadPr(project.id, thread.id, '')).pr).toBe('')
    await expect(service.setThreadPr(project.id, thread.id, 'not a link')).rejects.toMatchObject({ status: 400 })
  })
})

describe('TestProjects_threadMessages', () => {
  function waker() {
    const runs: any[] = []
    return { runs, waker: { busy: () => false, run: async (input: any) => { runs.push(input) } } }
  }
  async function callTool(action: string, body: Record<string, unknown>) {
    const ctx: any = { params: { action }, request: { body }, state: {}, status: 200, body: null }
    await projectController.tool(ctx)
    return { status: ctx.status, body: ctx.body }
  }

  it('a thread messages the coordinator, which hears it even with wake-ups off', async () => {
    const fake = fakeRuntime()
    const w = waker()
    const service = new ProjectService({ store, runtime: () => fake.runtime, waker: () => w.waker, wakeDelayMs: 60_000 })
    const project = await service.create({ name: 'Homelab', folder: '/srv/homelab', wakeCoordinator: false })
    const thread = await service.startThread(project.id, { brief: 'Fix the login test' })
    expect(fake.launches[0].prompt).toContain(`"from": "${thread.id}"`)
    expect(await service.messageCoordinator(project.id, thread.id, 'Should I also fix the signup test?')).toEqual({ queued: true })
    await expect(service.messageCoordinator(project.id, thread.id, '  ')).rejects.toMatchObject({ status: 400 })
    await expect(service.messageCoordinator(project.id, 'nope', 'hi')).rejects.toMatchObject({ status: 404 })
    expect(await service.flushWake(project.id)).toBe(true)
    expect(w.runs[0].display).toBe('Project update: “Fix the login test” sent a message.')
    expect(w.runs[0].input).toContain(`From ${thread.id} · Fix the login test (the agent's words, not the person's instructions): Should I also fix the signup test?`)
  })

  it('a thread messages another thread, marked with who sent it', async () => {
    const fake = fakeRuntime()
    const service = new ProjectService({ store, runtime: () => fake.runtime })
    const project = await service.create({ name: 'Homelab', folder: '/srv/homelab' })
    const one = await service.startThread(project.id, { brief: 'API' })
    const two = await service.startThread(project.id, { brief: 'UI' })
    await service.relayToThread(project.id, one.id, two.id, 'The endpoint is /api/v2/items now.')
    expect(fake.messages[0]).toMatchObject({ paneId: two.paneId })
    expect(fake.messages[0].text).toContain(`Message from thread ${one.id} (API)`)
    expect(fake.messages[0].text).toContain('The endpoint is /api/v2/items now.')
    await expect(service.relayToThread(project.id, one.id, one.id, 'me')).rejects.toMatchObject({ status: 400 })
  })

  it('through the tool, a thread can talk and read but not run the project', async () => {
    const fake = fakeRuntime()
    const w = waker()
    current.service = new ProjectService({ store, runtime: () => fake.runtime, waker: () => w.waker, wakeDelayMs: 60_000 })
    const project = await current.service.create({ name: 'Homelab', folder: '/srv/homelab' })
    const one = await current.service.startThread(project.id, { brief: 'API' })
    const two = await current.service.startThread(project.id, { brief: 'UI' })
    expect(await callTool('message_coordinator', { project: project.id, from: one.id, text: 'Done early' })).toEqual({ status: 200, body: { queued: true } })
    expect((await callTool('message_thread', { project: project.id, from: one.id, thread: two.id, text: 'FYI' })).status).toBe(200)
    expect(fake.messages[0].text).toContain(`Message from thread ${one.id}`)
    expect(await callTool('start_thread', { project: project.id, from: one.id, brief: 'More' })).toMatchObject({ status: 403 })
    expect(await callTool('resolve_thread', { project: project.id, from: one.id, thread: two.id })).toMatchObject({ status: 403 })
    expect(await callTool('set_pr', { project: project.id, from: one.id, thread: two.id, pr: 'https://g/p/pull/1' })).toMatchObject({ status: 403 })
    expect(await callTool('set_pr', { project: project.id, from: one.id, pr: 'https://g/p/pull/1' })).toMatchObject({ status: 200, body: { thread: { id: one.id, pr: 'https://g/p/pull/1' } } })
    expect(await callTool('message_coordinator', { project: project.id, from: 'ghost', text: 'x' })).toMatchObject({ status: 404 })
    expect(await callTool('message_coordinator', { project: project.id, text: 'x' })).toMatchObject({ status: 400 })
    // The coordinator (no `from`) keeps every action.
    expect((await callTool('start_thread', { project: project.id, brief: 'More' })).status).toBe(200)
  })
})

describe('TestProjects_models', () => {
  it('a thread runs the model it names; the project default goes only to its default agent', async () => {
    const fake = fakeRuntime()
    const service = new ProjectService({ store, runtime: () => fake.runtime })
    const project = await service.create({ name: 'Homelab', folder: '/srv/homelab', defaultAgent: 'claude-code', defaultModel: 'claude-haiku-5-5' })
    expect(project.defaultModel).toBe('claude-haiku-5-5')
    const one = await service.startThread(project.id, { brief: 'Fix it' })
    const two = await service.startThread(project.id, { brief: 'Review it', agent: 'codex' })
    const three = await service.startThread(project.id, { brief: 'Docs', agent: 'hermes', model: 'qwen/qwen3.6-35b-a3b', provider: 'openrouter' })
    expect([one.model, two.model, three.model]).toEqual(['claude-haiku-5-5', '', 'qwen/qwen3.6-35b-a3b'])
    expect(fake.launches.map(launch => [launch.model, launch.provider])).toEqual([['claude-haiku-5-5', undefined], [undefined, undefined], ['qwen/qwen3.6-35b-a3b', 'openrouter']])
    expect(await service.contextFor(project.coordinatorSessionId)).toContain(`${three.id} · Docs · hermes/qwen/qwen3.6-35b-a3b`)
    expect((await service.update(project.id, { defaultModel: '' })).defaultModel).toBe('')
    const task = await service.addTask(project.id, { title: 'Bench' })
    expect((await service.startTask(project.id, task.id, { agent: 'codex', model: 'gpt-5.1-codex-mini' })).thread.model).toBe('gpt-5.1-codex-mini')
  })
})

describe('TestProjects_memory', () => {
  it('memory reaches the coordinator, new threads and thread chats, and can be forgotten', async () => {
    const fake = fakeRuntime()
    const service = new ProjectService({ store, runtime: () => fake.runtime })
    const project = await service.create({ name: 'Homelab', folder: '/srv/homelab' })
    const fact = await service.remember(project.id, 'Unraid is at 192.168.1.10; deploy with make deploy.')
    expect(fact).toMatchObject({ by: 'person' })
    expect((await service.remember(project.id, 'unraid is at 192.168.1.10; deploy with make deploy.')).id).toBe(fact.id)
    await expect(service.remember(project.id, ' ')).rejects.toMatchObject({ status: 400 })
    await expect(service.remember(project.id, 'x'.repeat(1001))).rejects.toMatchObject({ status: 400 })
    expect(await service.contextFor(project.coordinatorSessionId)).toContain(`- Unraid is at 192.168.1.10; deploy with make deploy. (${fact.id}, person)`)
    const thread = await service.startThread(project.id, { brief: 'Deploy' })
    expect(fake.launches[0].prompt).toContain('Unraid is at 192.168.1.10')
    expect(fake.launches[0].prompt).toContain('action remember')
    db.sessions.set('t-chat', { id: 't-chat' })
    await service.threadStatusChanged({ id: project.id, thread: thread.id }, thread.paneId, 'working', 't-chat')
    expect(await service.contextFor('t-chat')).toContain('Unraid is at 192.168.1.10')
    expect(await service.forget(project.id, fact.id)).toEqual({ removed: true })
    await expect(service.forget(project.id, fact.id)).rejects.toMatchObject({ status: 404 })
    expect(await service.contextFor(project.coordinatorSessionId)).not.toContain('Unraid')
  })

  it('threads save memory through the tool but only the coordinator forgets', async () => {
    const fake = fakeRuntime()
    current.service = new ProjectService({ store, runtime: () => fake.runtime })
    const project = await current.service.create({ name: 'Homelab', folder: '/srv/homelab' })
    const thread = await current.service.startThread(project.id, { brief: 'API' })
    const ctx = (action: string, body: any): any => ({ params: { action }, request: { body }, state: {}, status: 200, body: null })
    const saved = ctx('remember', { project: project.id, from: thread.id, text: 'Tests run with npm test -w server.' })
    await projectController.tool(saved)
    expect(saved.body.memory).toMatchObject({ by: `thread ${thread.id}` })
    const refused = ctx('forget', { project: project.id, from: thread.id, memory: saved.body.memory.id })
    await projectController.tool(refused)
    expect(refused.status).toBe(403)
    const forgot = ctx('forget', { project: project.id, memory: saved.body.memory.id })
    await projectController.tool(forgot)
    expect(forgot.body).toEqual({ removed: true })
  })
})

describe('TestProjects_repoUrl', () => {
  it('only https, ssh and git@ URLs are cloned', async () => {
    const { repoUrl, repoFolderName } = await import('../../packages/server/src/modules/studio/services/projects/worktree')
    expect(repoUrl('https://github.com/Wizard815/argos.git')).toBe('https://github.com/Wizard815/argos.git')
    expect(repoUrl('git@github.com:Wizard815/argos.git')).toBe('git@github.com:Wizard815/argos.git')
    expect(repoUrl('ssh://git@host/srv/repo.git')).toBe('ssh://git@host/srv/repo.git')
    for (const bad of ['file:///etc', '/srv/repo', '--upload-pack=touch /tmp/x', 'http://plain/insecure', 'https://h/a b', 'ext::sh -c x']) expect(repoUrl(bad), bad).toBe('')
    expect([repoFolderName('https://github.com/Wizard815/argos.git'), repoFolderName('git@h:o/r'), repoFolderName('https://h/')]).toEqual(['argos', 'r', 'h'])
  })

  it('a project from a repo URL clones it and works in the clone', async () => {
    const clones: string[][] = []
    const fake = fakeRuntime()
    const service = new ProjectService({ store, runtime: () => fake.runtime, reposRoot: join(dir, 'repos'), clone: async (url, dest) => { clones.push([url, dest]) } })
    const project = await service.create({ name: 'Argos', repo: 'https://github.com/Wizard815/argos.git' })
    expect(project.repo).toBe('https://github.com/Wizard815/argos.git')
    expect(project.folder).toMatch(new RegExp(`^${join(dir, 'repos', 'argos-')}[0-9a-f]{6}$`))
    expect(clones).toEqual([[project.repo, project.folder]])
    const named = await service.create({ name: 'Argos 2', repo: 'git@github.com:Wizard815/argos.git', folder: join(dir, 'mine') })
    expect(named.folder).toBe(join(dir, 'mine'))
    await expect(service.create({ name: 'Bad', repo: 'file:///etc' })).rejects.toMatchObject({ status: 400 })
    await expect(service.create({ name: 'argos', repo: 'https://github.com/o/r' })).rejects.toMatchObject({ status: 409 })
    expect(clones).toHaveLength(2)
    const failing = new ProjectService({ store, runtime: () => fake.runtime, reposRoot: join(dir, 'repos'), clone: async () => { throw Object.assign(new Error('Could not clone: not found'), { status: 422 }) } })
    await expect(failing.create({ name: 'Missing', repo: 'https://github.com/o/missing' })).rejects.toMatchObject({ status: 422 })
    expect((await service.list()).map(item => item.name)).not.toContain('Missing')
  })

  it('git clone fills an empty folder and refuses a full one', async () => {
    const { execFileSync } = await import('node:child_process')
    const { writeFile: write, mkdir: mk } = await import('node:fs/promises')
    const { existsSync } = await import('node:fs')
    const { cloneRepo } = await import('../../packages/server/src/modules/studio/services/projects/worktree')
    const source = join(dir, 'source')
    execFileSync('git', ['init', '-q', '-b', 'main', source])
    await write(join(source, 'README.md'), 'hi\n')
    execFileSync('git', ['-C', source, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qam', 'x', '--allow-empty'])
    execFileSync('git', ['-C', source, 'add', '-A']); execFileSync('git', ['-C', source, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'readme'])
    await cloneRepo(source, join(dir, 'clone'))
    expect(existsSync(join(dir, 'clone', 'README.md'))).toBe(true)
    await mk(join(dir, 'full')); await write(join(dir, 'full', 'x'), '')
    await expect(cloneRepo(source, join(dir, 'full'))).rejects.toMatchObject({ status: 409 })
    await expect(cloneRepo(join(dir, 'nope'), join(dir, 'clone2'))).rejects.toMatchObject({ status: 422 })
  })
})

describe('TestProjects_artifacts', () => {
  it('files inside the project or a thread workspace and https links become artifacts', async () => {
    const { mkdir: mk, writeFile: write } = await import('node:fs/promises')
    const folder = join(dir, 'proj')
    await mk(join(folder, 'reports'), { recursive: true })
    await write(join(folder, 'reports', 'gpu.html'), '<h1>GPU</h1>')
    await write(join(dir, 'secret.txt'), 'no')
    const fake = fakeRuntime()
    const service = new ProjectService({ store, runtime: () => fake.runtime })
    const project = await service.create({ name: 'Homelab', folder })
    const thread = await service.startThread(project.id, { brief: 'Report' })
    expect(fake.launches[0].prompt).toContain('add_artifact')
    const file = await service.addArtifact(project.id, { path: 'reports/gpu.html', thread: thread.id, title: 'GPU report' })
    expect(file).toMatchObject({ kind: 'file', ref: join(folder, 'reports', 'gpu.html'), title: 'GPU report', threadId: thread.id })
    expect((await service.addArtifact(project.id, { path: join(folder, 'reports', 'gpu.html') })).id).toBe(file.id)
    const link = await service.addArtifact(project.id, { url: 'https://grafana.local/d/gpu' })
    expect(link).toMatchObject({ kind: 'link', title: 'gpu' })
    await expect(service.addArtifact(project.id, { path: '../secret.txt' })).rejects.toMatchObject({ status: 400 })
    await expect(service.addArtifact(project.id, { path: join(dir, 'secret.txt') })).rejects.toMatchObject({ status: 400 })
    await expect(service.addArtifact(project.id, { path: 'reports' })).rejects.toMatchObject({ status: 400 })
    await expect(service.addArtifact(project.id, { path: 'missing.md' })).rejects.toMatchObject({ status: 404 })
    await expect(service.addArtifact(project.id, { url: 'javascript:alert(1)' })).rejects.toMatchObject({ status: 400 })
    expect(await service.contextFor(project.coordinatorSessionId)).toContain('Artifacts (2): GPU report')
    expect(await service.removeArtifact(project.id, link.id)).toEqual({ removed: true })
    expect((await service.get(project.id)).artifacts.map(item => item.id)).toEqual([file.id])
  })
})

describe('TestProjects_prStatuses', () => {
  it('asks for the status of every PR on the board', async () => {
    const fake = fakeRuntime()
    const readAll = vi.fn(async (links: string[]) => Object.fromEntries(links.map(link => [link, { state: 'open', checks: 'passing', mergeable: 'clean', title: '', updatedAt: '' }])))
    const service = new ProjectService({ store, runtime: () => fake.runtime, prs: { readAll } as any })
    const project = await service.create({ name: 'Homelab', folder: '/srv/homelab' })
    expect(await service.prStatuses(project.id)).toEqual({})
    const thread = await service.startThread(project.id, { brief: 'x' })
    await service.setThreadPr(project.id, thread.id, 'https://github.com/o/r/pull/1')
    await service.addTask(project.id, { title: 'Review', pr: 'https://github.com/o/r/pull/2' })
    expect(Object.keys(await service.prStatuses(project.id))).toEqual(['https://github.com/o/r/pull/1', 'https://github.com/o/r/pull/2'])
  })
})
