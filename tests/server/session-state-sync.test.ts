import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const records = new Map<string, any>()

vi.mock('../../packages/server/src/modules/studio/repositories/session-state-store', () => ({
  listSessionStateRecords: (_user: number, sessionId?: string) => {
    const all = [...records.values()]
    return sessionId ? all.filter(r => r.id === sessionId) : all
  },
  markSessionRead: vi.fn(),
}))

const { SessionStateSync } = await import('../../packages/server/src/modules/studio/services/session-state')
const hub = await import('../../packages/server/src/modules/studio/public/session-status')

function record(id: string, extra: Record<string, unknown> = {}) {
  return { id, profile: 'default', source: 'coding_agent', studio_user_id: null, lastMessageId: 0, readMessageId: 0, lastAttentionId: 0, readAttentionId: 0, ...extra }
}

function fakeSocket() {
  const handlers = new Map<string, (...args: any[]) => void>()
  const emitted: Array<[string, any]> = []
  return {
    data: { user: { id: 1, username: 'a', role: 'super_admin' } },
    handshake: { query: { session_state: '1' } },
    on: (event: string, handler: any) => handlers.set(event, handler),
    emit: (event: string, payload: any) => { emitted.push([event, payload]) },
    emitted,
    last: (sessionId: string) => [...emitted].reverse().find(([event, payload]) => event === 'sessions.state.updated' && payload.sessionId === sessionId)?.[1],
  }
}

describe('SessionStateSync', () => {
  const runtime = new Map<string, boolean>()
  let sync: InstanceType<typeof SessionStateSync>
  let socket: ReturnType<typeof fakeSocket>

  beforeEach(() => {
    vi.useFakeTimers()
    records.clear(); runtime.clear(); hub.resetSessionStatusHub()
    sync = new SessionStateSync(id => ({ working: runtime.get(id) === true, backgroundPending: 0 }), () => true)
    socket = fakeSocket()
    sync.attach(socket as any)
  })
  afterEach(() => { sync.close(); vi.useRealTimers() })

  it('never lets a stale finished flag hide a live run', () => {
    records.set('s1', record('s1'))
    sync.observe('run.started', { session_id: 's1' })
    sync.observe('run.completed', { session_id: 's1' })
    expect(socket.last('s1')?.working).toBe(false)
    // The next turn starts without a run.started (e.g. a queue drain).
    runtime.set('s1', true)
    sync.observe('message.interim', { session_id: 's1' })
    expect(socket.last('s1')?.working).toBe(true)
  })

  it('reports blocked while an approval or question is open', () => {
    records.set('s2', record('s2'))
    runtime.set('s2', true)
    sync.observe('approval.requested', { session_id: 's2', approval_id: 'a1' })
    expect(socket.last('s2')).toMatchObject({ working: true, blocked: true })
    sync.observe('approval.resolved', { session_id: 's2', approval_id: 'a1' })
    expect(socket.last('s2')?.blocked).toBe(false)
    sync.observe('clarify.requested', { session_id: 's2', clarify_id: 'c1' })
    runtime.set('s2', false)
    sync.observe('run.completed', { session_id: 's2' })
    expect(socket.last('s2')).toMatchObject({ working: false, blocked: false })
  })

  it('retries when a run starts before its chat row exists', () => {
    sync.observe('run.started', { session_id: 'late' })
    expect(socket.last('late')).toBeUndefined()
    records.set('late', record('late'))
    runtime.set('late', true)
    vi.advanceTimersByTime(200)
    expect(socket.last('late')?.working).toBe(true)
  })

  it('pushes herdr pane status and list changes', () => {
    records.set('h1', record('h1'))
    hub.setSessionHerdrLink('h1', { paneId: 'w1:p1', workspaceId: 'w1', status: 'blocked' })
    expect(socket.last('h1')?.herdr).toEqual({ paneId: 'w1:p1', workspaceId: 'w1', status: 'blocked' })
    hub.setSessionHerdrLink('h1', null)
    expect(socket.last('h1')?.herdr).toBeUndefined()
    hub.notifySessionListChanged({ type: 'created', sessionId: 'h1' })
    hub.notifySessionListChanged({ type: 'deleted', sessionId: 'gone' })
    expect(socket.emitted.filter(([event]) => event === 'sessions.list.changed').map(([, change]) => change)).toEqual([
      { type: 'created', sessionId: 'h1' },
      { type: 'deleted', sessionId: 'gone' },
    ])
  })
})
