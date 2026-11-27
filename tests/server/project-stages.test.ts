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
import { ProjectStore, normalizeProject, autoResolveDays } from '../../packages/server/src/modules/studio/services/projects/store'
import * as projectController from '../../packages/server/src/modules/studio/controllers/projects'
import { ProjectService, projectContextBlock, threadStage, type ProjectRuntime } from '../../packages/server/src/modules/studio/services/projects/service'

const DAY = 86_400_000

/** herdr as the projects see it: panes with a status the test sets. */
function fakeRuntime() {
  const panes = new Map<string, { session: string | null; status: any }>()
  const messages: any[] = []
  let n = 0
  const runtime: ProjectRuntime = {
    canRun: () => true,
    launch: async () => { const paneId = `w${++n}:p1`; panes.set(paneId, { session: `chat-${n}`, status: 'working' }); return { paneId, sessionId: `chat-${n}` } },
    sessionForPane: paneId => panes.get(paneId)?.session ?? null,
    statusForPane: paneId => panes.get(paneId)?.status ?? null,
    message: async input => { messages.push(input) },
  }
  return { runtime, panes, messages }
}

let dir = ''
let store: ProjectStore
let clock = 1_000_000
let fake: ReturnType<typeof fakeRuntime>
let service: ProjectService
let busy = new Set<string>()

/** herdr reports a status: the pane shows it and the bridge forwards it. */
async function report(projectId: string, thread: { id: string; paneId: string }, status: string) {
  const pane = fake.panes.get(thread.paneId)
  if (pane) pane.status = status === 'gone' ? null : status
  await service.threadStatusChanged({ id: projectId, thread: thread.id }, thread.paneId, status)
}

async function stageOf(projectId: string, threadId: string) {
  return (await service.get(projectId)).threads.find(item => item.id === threadId)!.stage
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'studio-stages-'))
  store = new ProjectStore(join(dir, 'projects.json'))
  db.sessions.clear(); db.categories.length = 0; db.messages.clear()
  clock = 1_000_000
  busy = new Set()
  fake = fakeRuntime()
  service = new ProjectService({ store, runtime: () => fake.runtime, now: () => clock, waker: () => null, chatBusy: id => busy.has(id), worktreeRoot: join(dir, 'wt') })
  current.service = service
})
afterEach(async () => { service.stopSweeps(); await rm(dir, { recursive: true, force: true }) })

describe('TestProjects_threadStage', () => {
  const base = { resolved: false, failed: false, status: 'working' as const, finishedAt: 0, seenAt: 0 }
  it('maps every herdr status to one stage', () => {
    expect(threadStage({ ...base, liveStatus: 'starting' })).toBe('working')
    expect(threadStage({ ...base, liveStatus: 'working' })).toBe('working')
    expect(threadStage({ ...base, liveStatus: 'unknown' })).toBe('working')
    expect(threadStage({ ...base, liveStatus: 'blocked' })).toBe('needs_you')
    expect(threadStage({ ...base, status: 'done', finishedAt: 5, liveStatus: 'done' })).toBe('review')
    expect(threadStage({ ...base, status: 'idle', finishedAt: 5, liveStatus: 'idle' })).toBe('review')
    expect(threadStage({ ...base, status: 'done', finishedAt: 5, seenAt: 5, liveStatus: 'done' })).toBe('done')
    // Seen before it finished again: back in review.
    expect(threadStage({ ...base, status: 'done', finishedAt: 9, seenAt: 5, liveStatus: 'done' })).toBe('review')
    expect(threadStage({ ...base, resolved: true, liveStatus: 'blocked' })).toBe('resolved')
  })

  it('calls a pane that vanished mid-task failed, even before herdr\'s gone report is saved', () => {
    // Stored status still says working; herdr already lost the pane.
    expect(threadStage({ ...base, status: 'working', liveStatus: 'gone' })).toBe('needs_you')
    expect(threadStage({ ...base, status: 'blocked', liveStatus: 'gone' })).toBe('needs_you')
    // It had finished first: a closed pane is just stopped.
    expect(threadStage({ ...base, status: 'done', finishedAt: 5, liveStatus: 'gone' })).toBe('review')
    // A failed thread resumed is working again, not needs_you.
    expect(threadStage({ ...base, failed: true, liveStatus: 'working' })).toBe('working')
  })

  it('a legacy thread without the new fields is review, never auto-resolved', () => {
    const project = normalizeProject({ id: 'p', name: 'Old', threads: [{ id: 't', status: 'done', resolved: false }] })!
    expect(project.autoResolveDays).toBe(3)
    expect(project.threads[0]).toMatchObject({ failed: false, finishedAt: 0, seenAt: 0, resolvedAt: 0 })
    expect(threadStage({ ...project.threads[0], liveStatus: 'done' })).toBe('review')
  })

  it('takes only whole days from 0 to 90 for auto-resolve', () => {
    expect([0, 1, 90].map(autoResolveDays)).toEqual([0, 1, 90])
    expect([-1, 91, 2.5, 'x', null, undefined, '', NaN, Infinity].map(autoResolveDays)).toEqual(Array(9).fill(3))
  })
})

describe('TestProjects_lifecycle', () => {
  it('goes working → review → done → resolved, and new work brings it back', async () => {
    const project = await service.create({ name: 'Life', folder: '' })
    const thread = await service.startThread(project.id, { brief: 'Do it' })
    expect(thread.stage).toBe('working')
    clock += 1000
    await report(project.id, thread, 'done')
    expect(await stageOf(project.id, thread.id)).toBe('review')
    expect((await service.get(project.id)).counts).toMatchObject({ review: 1, done: 1, working: 0 })
    clock += 1000
    const seen = await service.markSeen(project.id, thread.id)
    expect(seen.stage).toBe('done')
    expect(seen.updatedAt).toBe(thread.updatedAt + 1000)  // opening it does not reorder the list
    await service.setResolved(project.id, thread.id, true)
    expect(await stageOf(project.id, thread.id)).toBe('resolved')
    // The coordinator sends it more work: it reopens and runs.
    await service.messageThread(project.id, thread.id, 'One more thing')
    await report(project.id, thread, 'working')
    expect(await stageOf(project.id, thread.id)).toBe('working')
    clock += 1000
    await report(project.id, thread, 'done')
    // Finished again after the person last looked: review again.
    expect(await stageOf(project.id, thread.id)).toBe('review')
  })

  it('marks a thread failed when its pane closes mid-task, and clears it when it runs again', async () => {
    const project = await service.create({ name: 'Crash', folder: '' })
    const thread = await service.startThread(project.id, { brief: 'Long job' })
    await report(project.id, thread, 'working')
    await report(project.id, thread, 'gone')
    let saved = (await store.get(project.id))!.threads[0]
    expect(saved).toMatchObject({ failed: true, status: 'gone' })
    expect(await stageOf(project.id, thread.id)).toBe('needs_you')
    expect((await service.get(project.id)).counts.needsYou).toBe(1)
    // A second gone report keeps it failed.
    await service.threadStatusChanged({ id: project.id, thread: thread.id }, thread.paneId, 'gone')
    expect((await store.get(project.id))!.threads[0].failed).toBe(true)
    // An unknown report says nothing.
    await service.threadStatusChanged({ id: project.id, thread: thread.id }, thread.paneId, 'unknown')
    expect((await store.get(project.id))!.threads[0].failed).toBe(true)
    await report(project.id, thread, 'working')
    saved = (await store.get(project.id))!.threads[0]
    expect(saved.failed).toBe(false)
    expect(await stageOf(project.id, thread.id)).toBe('working')
  })

  it('a pane closed after the thread finished is not a failure', async () => {
    const project = await service.create({ name: 'Closed', folder: '' })
    const thread = await service.startThread(project.id, { brief: 'Quick job' })
    await report(project.id, thread, 'done')
    const finishedAt = (await store.get(project.id))!.threads[0].finishedAt
    clock += 5000
    await report(project.id, thread, 'gone')
    const saved = (await store.get(project.id))!.threads[0]
    expect(saved.failed).toBe(false)
    // done → gone is still the same finish, not a new one.
    expect(saved.finishedAt).toBe(finishedAt)
    expect(await stageOf(project.id, thread.id)).toBe('review')
  })

  it('reopens a resolved thread when someone works in its herdr pane directly', async () => {
    const project = await service.create({ name: 'Direct', folder: '' })
    const thread = await service.startThread(project.id, { brief: 'Job' })
    await report(project.id, thread, 'done')
    await service.setResolved(project.id, thread.id, true)
    // A repeated done report keeps it resolved.
    await service.threadStatusChanged({ id: project.id, thread: thread.id }, thread.paneId, 'done')
    expect(await stageOf(project.id, thread.id)).toBe('resolved')
    await report(project.id, thread, 'blocked')
    expect(await stageOf(project.id, thread.id)).toBe('needs_you')
  })

  it('an adopted Studio chat (no herdr pane) is done, and working while Studio runs it', async () => {
    const project = await service.create({ name: 'Adopt', folder: '' })
    db.sessions.set('old-chat', { id: 'old-chat', title: 'Old chat', agent: 'hermes' })
    const thread = await service.adoptChat(project.id, 'old-chat')
    expect(thread.stage).toBe('done')
    busy.add('old-chat')
    expect(await stageOf(project.id, thread.id)).toBe('working')
  })

  it('rejects a bad auto-resolve setting and keeps the old one', async () => {
    const project = await service.create({ name: 'Days', folder: '', autoResolveDays: 7 })
    expect(project.autoResolveDays).toBe(7)
    for (const bad of [-1, 91, 1.5, 'soon', '', null]) await expect(service.update(project.id, { autoResolveDays: bad })).rejects.toMatchObject({ status: 400 })
    expect((await service.get(project.id)).autoResolveDays).toBe(7)
    expect((await service.update(project.id, { autoResolveDays: 0 })).autoResolveDays).toBe(0)
    // Unknown thread ids are a 404, not a crash.
    await expect(service.markSeen(project.id, 'nope')).rejects.toMatchObject({ status: 404 })
  })
})

describe('TestProjects_autoResolve', () => {
  async function setup(days = 3) {
    const project = await service.create({ name: `Sweep ${days}`, folder: '', autoResolveDays: days })
    const make = async (title: string) => service.startThread(project.id, { brief: title, title })
    const done = await make('done')
    const review = await make('review')
    const blocked = await make('blocked')
    const failed = await make('failed')
    const working = await make('working')
    await report(project.id, done, 'done'); await service.markSeen(project.id, done.id)
    await report(project.id, review, 'idle')
    await report(project.id, blocked, 'blocked')
    await report(project.id, failed, 'gone')
    return { project, done, review, blocked, failed, working }
  }

  it('resolves only done threads, and only once they are old enough', async () => {
    const t = await setup(3)
    expect(await service.sweep()).toEqual([])
    clock += 3 * DAY - 1
    expect(await service.sweep()).toEqual([])
    clock += 1
    expect(await service.sweep()).toEqual([{ project: t.project.id, thread: t.done.id, title: 'done' }])
    const stages = Object.fromEntries((await service.get(t.project.id)).threads.map(item => [item.title, item.stage]))
    expect(stages).toEqual({ done: 'resolved', review: 'review', blocked: 'needs_you', failed: 'needs_you', working: 'working' })
    // Nothing left: a second sweep is a no-op, even much later.
    clock += 30 * DAY
    expect(await service.sweep()).toEqual([])
    expect((await store.get(t.project.id))!.threads.find(item => item.id === t.done.id)!.resolvedAt).toBe(clock - 30 * DAY)
  })

  it('never auto-resolves with 0 days, but resolve_done still works', async () => {
    const t = await setup(0)
    clock += 365 * DAY
    expect(await service.sweep()).toEqual([])
    const ctx: any = { params: { action: 'resolve_done' }, request: { body: { project: t.project.id } } }
    await projectController.tool(ctx)
    expect(ctx.body.resolved.map((item: any) => item.title)).toEqual(['done'])
  })

  it('a thread reopened by the person is not swept straight back', async () => {
    const t = await setup(1)
    clock += 2 * DAY
    await service.sweep()
    await service.setResolved(t.project.id, t.done.id, false)
    expect(await stageOf(t.project.id, t.done.id)).toBe('done')
    expect(await service.sweep()).toEqual([])
    clock += DAY
    expect((await service.sweep()).map(item => item.thread)).toEqual([t.done.id])
  })

  it('a report that lands while the sweep runs wins over the sweep', async () => {
    const t = await setup(1)
    clock += 2 * DAY
    // herdr reports work between the sweep's first look and its save.
    const update = store.update.bind(store)
    let raced = false
    store.update = async (id, change) => {
      if (!raced) {
        raced = true
        fake.panes.get(t.done.paneId)!.status = 'working'
      }
      return update(id, change)
    }
    expect(await service.sweep()).toEqual([])
    expect(await stageOf(t.project.id, t.done.id)).toBe('working')
  })

  it('does not let a thread resolve itself or sweep the project', async () => {
    const t = await setup(1)
    for (const action of ['resolve_done', 'resolve_thread']) {
      const ctx: any = { params: { action }, request: { body: { project: t.project.id, from: t.review.id, thread: t.review.id } } }
      await projectController.tool(ctx)
      expect(ctx.status).toBe(403)
    }
  })

  it('starts one hourly timer, runs at once, and stops cleanly', async () => {
    const t = await setup(1)
    clock += 2 * DAY
    service.startSweeps(10)
    service.startSweeps(10)
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(await stageOf(t.project.id, t.done.id)).toBe('resolved')
    service.stopSweeps()
    service.stopSweeps()
  })
})

describe('TestProjects_coordinatorStages', () => {
  it('shows each open thread\'s stage and the resolve rules to the coordinator', async () => {
    const project = await service.create({ name: 'Ctx', folder: '', autoResolveDays: 1 })
    const thread = await service.startThread(project.id, { brief: 'Job', title: 'Job' })
    await report(project.id, thread, 'working')
    await report(project.id, thread, 'gone')
    const block = projectContextBlock(await service.get(project.id), 'coordinator')
    expect(block).toContain(`${thread.id} · Job · claude-code · needs_you (gone)`)
    expect(block).toContain('Done threads resolve by themselves after 1 day.')
    expect(block).toContain('Never resolve one in needs_you or review on your own')
  })

  it('tells the coordinator a thread failed, not just stopped', async () => {
    const runs: any[] = []
    service = new ProjectService({ store, runtime: () => fake.runtime, now: () => clock, waker: () => ({ busy: () => false, run: async input => { runs.push(input) } }), wakeDelayMs: 60_000, chatBusy: () => false })
    const project = await service.create({ name: 'Wake', folder: '' })
    const thread = await service.startThread(project.id, { brief: 'Job', title: 'Job' })
    await report(project.id, thread, 'working')
    await report(project.id, thread, 'gone')
    expect(await service.flushWake(project.id)).toBe(true)
    expect(runs[0].display).toBe('Project update: “Job” failed.')
    expect(runs[0].input).toContain('failed: its herdr pane closed while it was still working')
  })
})

describe('TestProjects_concurrentChanges', () => {
  it('keeps both changes when a herdr report and the person opening threads land at once', async () => {
    const project = await service.create({ name: 'Race', folder: '' })
    const one = await service.startThread(project.id, { brief: 'one' })
    const two = await service.startThread(project.id, { brief: 'two' })
    await report(project.id, one, 'done')
    fake.panes.get(two.paneId)!.status = 'done'
    clock += 10
    await Promise.all([
      service.markSeen(project.id, one.id),
      service.threadStatusChanged({ id: project.id, thread: two.id }, two.paneId, 'done'),
      service.setResolved(project.id, two.id, true),
    ])
    const saved = (await new ProjectStore(join(dir, 'projects.json')).get(project.id))!
    const byId = Object.fromEntries(saved.threads.map(item => [item.id, item]))
    expect(byId[one.id].seenAt).toBe(clock)
    expect(byId[two.id]).toMatchObject({ status: 'done', resolved: true })
    expect(byId[two.id].finishedAt).toBe(clock)
  })

  it('a person who opened a thread while it was still working sees it in review once it finishes', async () => {
    const project = await service.create({ name: 'Early', folder: '' })
    const thread = await service.startThread(project.id, { brief: 'job' })
    await service.markSeen(project.id, thread.id)
    expect(await stageOf(project.id, thread.id)).toBe('working')
    clock += 10
    await report(project.id, thread, 'done')
    expect(await stageOf(project.id, thread.id)).toBe('review')
  })
})

describe('TestProjects_threadMenu', () => {
  it('renames a thread and its chat, pins it, and refuses bad input', async () => {
    const project = await service.create({ name: 'Menu', folder: '' })
    const thread = await service.startThread(project.id, { brief: 'job', title: 'Old name' })
    db.sessions.set(thread.sessionId, { id: thread.sessionId, title: 'Old name' })
    const renamed = await service.updateThread(project.id, thread.id, { title: '  New name  ' })
    expect(renamed.title).toBe('New name')
    expect(db.sessions.get(thread.sessionId).title).toBe('New name')
    expect((await service.updateThread(project.id, thread.id, { pinned: true })).pinned).toBe(true)
    // Pinning leaves the title alone, and the order key (updatedAt) too.
    const pinned = (await service.get(project.id)).threads[0]
    expect(pinned).toMatchObject({ title: 'New name', pinned: true, updatedAt: thread.updatedAt })
    for (const bad of [{ title: '   ' }, { pinned: 'yes' }]) await expect(service.updateThread(project.id, thread.id, bad)).rejects.toMatchObject({ status: 400 })
    await expect(service.updateThread(project.id, 'nope', { pinned: true })).rejects.toMatchObject({ status: 404 })
    expect((await service.updateThread(project.id, thread.id, { pinned: false })).pinned).toBe(false)
  })
})
