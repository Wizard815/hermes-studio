import { describe, expect, it, vi } from 'vitest'
import { reportUpstreamAgentStatus, upstreamPrefix, upstreamStatus, upstreamTarget, upstreamWorkRef } from '../../packages/server/src/modules/studio/services/upstream/client'
import { studioUrlForUpstream } from '../../packages/server/src/modules/studio/middleware/upstream-upkeep-proxy'

describe('Upstream Manager seen from Studio', () => {
  it('finds Upstream where the proxy does', () => {
    expect(upstreamTarget({})).toBe('http://127.0.0.1:5001')
    expect(upstreamTarget({ UPSTREAM_UPKEEP_TARGET: 'http://box:6000///' })).toBe('http://box:6000')
    expect(upstreamPrefix({})).toBe('/upstream')
    expect(upstreamPrefix({ UPSTREAM_UPKEEP_PATH_PREFIX: '/um/' })).toBe('/um')
  })

  it('tells Upstream where Studio is', () => {
    expect(studioUrlForUpstream({}, 8648)).toBe('http://127.0.0.1:8648')
    expect(studioUrlForUpstream({ HERMES_STUDIO_URL_FOR_UPSTREAM: 'http://studio.lan:8648/' }, 8648)).toBe('http://studio.lan:8648')
  })

  it('accepts only a well-formed task from a launch request', () => {
    expect(upstreamWorkRef({ task: 'ab12', title: 'Fix it', repo: 'mine' })).toEqual({ task: 'ab12', title: 'Fix it', repo: 'mine' })
    expect(upstreamWorkRef({ task: 'ab12' })).toEqual({ task: 'ab12' })
    for (const bad of [null, undefined, {}, { task: '' }, { task: '../x' }, { task: 'a b' }, { task: 'x'.repeat(65) }]) {
      expect(upstreamWorkRef(bad)).toBeUndefined()
    }
    expect(upstreamWorkRef({ task: 'ok', title: 'y'.repeat(500) })!.title!.length).toBe(300)
  })

  it('reports an agent\'s status to the task, as Upstream\'s trusted proxy', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"ok":true}', { status: 200 }))
    await reportUpstreamAgentStatus({ task: 'ab12' }, 'w1:p2', 'blocked', fetchImpl as unknown as typeof fetch)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('http://127.0.0.1:5001/api/tasks/ab12/agent-status')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>)['x-upstream-base']).toBe('/upstream')
    expect(JSON.parse(String(init.body))).toEqual({ status: 'blocked', pane: 'w1:p2' })
    // nothing to report, or a bad id: no call; Upstream down: no throw
    await reportUpstreamAgentStatus(undefined, 'w1:p2', 'done', fetchImpl as unknown as typeof fetch)
    await reportUpstreamAgentStatus({ task: '../../x' }, 'w1:p2', 'done', fetchImpl as unknown as typeof fetch)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    await expect(reportUpstreamAgentStatus({ task: 'ab12' }, 'w1:p2', 'done', (async () => { throw new TypeError('fetch failed') }) as unknown as typeof fetch)).resolves.toBeUndefined()
  })

  it('says whether Upstream answers and how many tasks are open', async () => {
    const ok = async () => new Response(JSON.stringify({ ok: true, items: [{ status: 'open' }, { status: 'working' }, { status: 'done' }] }), { status: 200 })
    expect(await upstreamStatus(ok as unknown as typeof fetch)).toEqual({ target: 'http://127.0.0.1:5001', reachable: true, openTasks: 2 })
    const down = async () => { throw new TypeError('fetch failed') }
    const st = await upstreamStatus(down as unknown as typeof fetch)
    expect(st.reachable).toBe(false)
    expect(st.error).toMatch(/is Upstream running/)
    const refused = async () => new Response('no', { status: 403 })
    expect((await upstreamStatus(refused as unknown as typeof fetch)).error).toBe('Upstream answered 403')
  })
})
