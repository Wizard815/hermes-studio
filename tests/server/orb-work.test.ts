import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../../packages/server/src/modules/studio/repositories/session-store', () => ({
  getSession: (id: string) => ({ id, title: 'Plan the pricing page' }),
  updateSession: vi.fn(),
}))
vi.mock('../../packages/server/src/modules/studio/public/config', () => ({ config: { port: 1 } }))

const { OrbWorkTracker, cleanWorkRef, statusForEvent, workRunPayload } = await import('../../packages/server/src/modules/studio/services/orb/work')

/** A chat-run socket stand-in: records what Studio sends and lets the test emit run events. */
class FakeSocket extends EventEmitter {
  sent: Array<[string, unknown]> = []
  disconnected = false
  override emit(name: string, ...args: unknown[]): boolean {
    if (name === 'run') { this.sent.push([name, args[0]]); return true }
    return super.emit(name, ...args)
  }
  disconnect() { this.disconnected = true; return this }
  server(name: string, payload: unknown = {}) { super.emit(name, payload) }
}

describe('Orb sends work to Studio', () => {
  let dir = ''
  afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); dir = '' })

  it('starts the right kind of Studio chat for each agent', () => {
    const base = { prompt: 'Do it', profile: 'default', sessionId: 's1' }
    expect(workRunPayload({ ...base, agentId: 'hermes' })).toEqual({ input: 'Do it', session_id: 's1', profile: 'default' })
    expect(workRunPayload({ ...base, agentId: 'ekko-agent' })).toEqual({ input: 'Do it', session_id: 's1', profile: 'default', source: 'coding_agent', coding_agent_id: 'ekko-agent' })
    expect(workRunPayload({ ...base, agentId: 'claude-code', workspace: '/srv/site' })).toMatchObject({ source: 'coding_agent', coding_agent_id: 'claude-code', mode: 'global', workspace: '/srv/site' })
  })

  it('maps run events to Orb states and keeps only a task or a project', () => {
    expect(statusForEvent('run.started')).toBe('working')
    expect(statusForEvent('approval.requested')).toBe('blocked')
    expect(statusForEvent('run.failed')).toBe('blocked')
    expect(statusForEvent('run.completed')).toBe('done')
    expect(statusForEvent('usage.updated')).toBeNull()
    expect(cleanWorkRef({ task: { title: ' Fix login ', list: 'site' }, project: 'x' })).toEqual({ task: { title: 'Fix login', list: 'site' } })
    expect(cleanWorkRef({ project: 'site' })).toEqual({ project: 'site' })
    expect(cleanWorkRef({})).toBeNull()
  })

  it('starts a chat, follows its run and tells Orb each change', async () => {
    dir = await mkdtemp(join(tmpdir(), 'orb-work-'))
    const socket = new FakeSocket()
    const reports: string[] = []
    const tracker = new OrbWorkTracker(join(dir, 'work.json'), () => socket as any, async work => { reports.push(`${work.status}:${work.orb.task?.title}`) })
    const started = tracker.start({ token: 't', agentId: 'ekko-agent', prompt: 'Plan the pricing page', orb: { task: { title: 'Pricing', list: 'site' } } })
    await vi.waitFor(() => expect(socket.listenerCount('connect')).toBe(1))
    socket.server('connect')
    expect(socket.sent[0][1]).toMatchObject({ input: 'Plan the pricing page', source: 'coding_agent', coding_agent_id: 'ekko-agent' })
    socket.server('run.started')
    const work = await started
    expect(work).toMatchObject({ agentId: 'ekko-agent', status: 'working', title: 'Pricing' })
    socket.server('approval.requested')
    socket.server('run.completed')
    await vi.waitFor(() => expect(reports).toEqual(['working:Pricing', 'blocked:Pricing', 'done:Pricing']))
    expect(socket.disconnected).toBe(true)
    expect(JSON.parse(await readFile(join(dir, 'work.json'), 'utf8'))[0]).toMatchObject({ status: 'done', sessionId: work.sessionId })
    expect((await tracker.list())[0].title).toBe('Plan the pricing page')
  })

  it('refuses agents Studio cannot run and reports a chat that fails to start', async () => {
    dir = await mkdtemp(join(tmpdir(), 'orb-work-'))
    const socket = new FakeSocket()
    const tracker = new OrbWorkTracker(join(dir, 'work.json'), () => socket as any, async () => {})
    await expect(tracker.start({ token: 't', agentId: 'rm -rf', prompt: 'x' })).rejects.toThrow(/cannot run that agent/)
    await expect(tracker.start({ token: '', agentId: 'hermes', prompt: 'x' })).rejects.toThrow(/Sign in/)
    const failing = tracker.start({ token: 't', agentId: 'hermes', prompt: 'x' })
    await vi.waitFor(() => expect(socket.listenerCount('connect')).toBe(1))
    socket.server('connect')
    socket.server('run.failed', { error: 'No model provider configured' })
    await expect(failing).rejects.toThrow(/No model provider configured/)
  })
})
