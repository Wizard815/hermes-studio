import { describe, expect, it } from 'vitest'
import { projectRuntime } from '../../packages/server/src/bootstrap/herdr'

/** A stand-in for herdr's bridge: panes, links and what was typed where. */
function fakeManager(options: { links?: Record<string, { paneId: string; waiting?: boolean }>; panes?: any[]; connected?: boolean } = {}) {
  const calls: string[] = []
  const panes = options.panes || []
  const bridge = {
    getState: () => ({ connected: options.connected ?? true, panes }),
    linkFor: (id: string) => options.links?.[id] ? { workspaceId: 'w', status: 'idle', ...options.links[id] } : undefined,
    promptSession: async (id: string, text: string) => { calls.push(`prompt ${id} ${text}`); return { paneId: 'x' } },
    openSession: async (id: string) => { calls.push(`open ${id}`); return { paneId: 'w9:p1', workspaceId: 'w9', status: 'unknown' } },
    promptWhenReady: async (paneId: string, text: string) => { calls.push(`ready ${paneId} ${text}`); return true },
    launchAgent: async (agentId: string, input: any) => { calls.push(`launch ${agentId} ${JSON.stringify(input)}`); return { paneId: 'w5:p1', workspaceId: 'w5', status: 'unknown' } },
  }
  return { calls, manager: { getBridge: () => bridge as any, requireBridge: () => bridge as any } }
}

describe('TestProjects_herdrRuntime', () => {
  it('launches a thread with its project work ref, so the bridge files it and reports its status', async () => {
    const { calls, manager } = fakeManager()
    const runtime = projectRuntime(manager as any)
    expect(await runtime.launch({ agentId: 'codex', title: 'Fix', prompt: 'Do it', workspace: '/srv/app', project: { id: 'p1', thread: 't1' } })).toEqual({ paneId: 'w5:p1' })
    expect(calls).toEqual(['launch codex {"workspace":"/srv/app","title":"Fix","prompt":"Do it","onWorking":{"project":{"id":"p1","thread":"t1"}}}'])
    expect(runtime.canRun('codex')).toBe(true)
    expect(runtime.canRun('ekko-agent')).toBe(false)
  })

  it('messages a live thread in its pane, resumes a stopped one first, and reads status from panes', async () => {
    const live = fakeManager({ links: { chat: { paneId: 'w1:p1' } } })
    await projectRuntime(live.manager as any).message({ sessionId: 'chat', paneId: 'w1:p1', text: 'hi' })
    expect(live.calls).toEqual(['prompt chat hi'])

    const stopped = fakeManager({ links: { chat: { paneId: 'w1:p1', waiting: true } } })
    await projectRuntime(stopped.manager as any).message({ sessionId: 'chat', paneId: 'w1:p1', text: 'go on' })
    expect(stopped.calls).toEqual(['open chat', 'ready w9:p1 go on'])

    const noChat = fakeManager({ panes: [{ pane_id: 'w2:p1', agent_status: 'working', studioSessionId: null }] })
    const runtime = projectRuntime(noChat.manager as any)
    await runtime.message({ sessionId: '', paneId: 'w2:p1', text: 'and tests' })
    expect(noChat.calls).toEqual(['ready w2:p1 and tests'])
    expect(runtime.statusForPane('w2:p1')).toBe('working')
    expect(runtime.statusForPane('w3:p1')).toBe('gone')
    await expect(runtime.message({ sessionId: '', paneId: 'w3:p1', text: 'x' })).rejects.toMatchObject({ status: 409 })
    expect(projectRuntime(fakeManager({ connected: false }).manager as any).statusForPane('w2:p1')).toBeNull()
  })
})
