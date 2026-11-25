import { describe, expect, it, vi } from 'vitest'
import {
  UPSTREAM_MCP_NAME, WIKI_KEY_ENV, WIKI_MCP_NAME, giveHermesUpstreamTools, giveHermesWikiTools, hermesHasUpstreamTools, hermesHasWikiTools,
  upstreamMcpServer, upstreamOverview, upstreamWikiConnection, type ProfileConfigAccess,
} from '../../packages/server/src/modules/studio/services/upstream/client'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function memoryConfig(initial: Record<string, any>): ProfileConfigAccess & { data: Record<string, any>; writes: number } {
  const store = { data: initial, writes: 0 } as any
  store.read = async () => store.data
  store.update = async (_profile: string, fn: any) => {
    const out = fn(JSON.parse(JSON.stringify(store.data)))
    if (out.write !== false) { store.data = out.data; store.writes++ }
    return out.result
  }
  return store
}

describe('Upstream\'s Overseer and board, seen from Studio', () => {
  it('summarises what the Overseer sees', async () => {
    const fetchImpl = vi.fn(async (url: string) => url.endsWith('/api/overseer')
      ? json({ ok: true, report: { at: '2026-11-25T02:00:00+00:00',
          next: [{ id: 't1', title: 'Prod is down', repo: 'hub', priority: 'urgent' }, { id: 't2', title: 'Docs', repo: 'hub', priority: 'low' }],
          working: [{ id: 't3', title: 'Tests', repo: 'hub', agent: 'herdr:w1:p2' }], waiting_for_you: [{ id: 'r1' }], agents: [{ name: 'a' }] } })
      : json({ ok: true, unread: 4, items: [] }))
    const o = await upstreamOverview(fetchImpl as unknown as typeof fetch)
    expect(o).toMatchObject({ reachable: true, waitingForYou: 1, unread: 4, agents: 1 })
    expect(o.next[0]).toEqual({ id: 't1', title: 'Prod is down', repo: 'hub', priority: 'urgent' })
    expect(o.working[0].agent).toBe('herdr:w1:p2')
    const down = await upstreamOverview((async () => { throw new TypeError('fetch failed') }) as unknown as typeof fetch)
    expect(down.reachable).toBe(false)
  })

  it('learns how to start Upstream\'s tools, and adds them to a Hermes profile once', async () => {
    const fetchImpl = vi.fn(async () => json({ ok: true, stdio_command: ['/opt/um/.venv/bin/python', '-m', 'upstream_upkeep.mcp_server'],
      stdio_env: { UPSTREAM_APP_URL: 'http://127.0.0.1:5001' } }))
    const server = await upstreamMcpServer(fetchImpl as unknown as typeof fetch)
    expect(server).toEqual({ command: '/opt/um/.venv/bin/python', args: ['-m', 'upstream_upkeep.mcp_server'], env: { UPSTREAM_APP_URL: 'http://127.0.0.1:5001' } })
    expect(await upstreamMcpServer((async () => json({ ok: true })) as unknown as typeof fetch)).toBeNull()   // an older Upstream

    const cfg = memoryConfig({ model: 'x', mcp_servers: { other: { command: 'o' } } })
    expect(await hermesHasUpstreamTools('default', cfg)).toBe(false)
    expect(await giveHermesUpstreamTools('default', server!, cfg)).toBe(true)
    expect(cfg.data.mcp_servers[UPSTREAM_MCP_NAME]).toEqual({ command: server!.command, args: server!.args, env: server!.env })
    expect(cfg.data.mcp_servers.other).toEqual({ command: 'o' })      // the rest is kept
    expect(cfg.data.model).toBe('x')
    expect(await hermesHasUpstreamTools('default', cfg)).toBe(true)
    expect(await giveHermesUpstreamTools('default', server!, cfg)).toBe(false)   // once
    expect(cfg.writes).toBe(1)
    // a hand-made "upstream" entry counts as having them
    const mine = memoryConfig({ mcp_servers: { Upstream: { url: 'http://box:5002/mcp' } } })
    expect(await giveHermesUpstreamTools('default', server!, mine)).toBe(false)
    expect(mine.writes).toBe(0)
  })

  it('gives Hermes the LLM wiki Upstream reaches, the key in the profile .env, once', async () => {
    const fetchImpl = vi.fn(async (url: string) => json({ ok: true, url: 'http://vault.lan:27123/mcp', key: 'k-secret' }))
    const conn = await upstreamWikiConnection(fetchImpl as unknown as typeof fetch)
    expect(conn).toEqual({ url: 'http://vault.lan:27123/mcp', key: 'k-secret' })
    expect(String(fetchImpl.mock.calls[0][0])).toMatch(/\/api\/wiki\/connect$/)
    expect(await upstreamWikiConnection((async () => json({ ok: false }, 403)) as unknown as typeof fetch)).toBeNull()
    expect(await upstreamWikiConnection((async () => json({ ok: true, url: 'javascript:alert(1)' })) as unknown as typeof fetch)).toBeNull()

    const cfg = memoryConfig({ mcp_servers: { 'upstream-manager': { command: 'x' } } })
    const env: Record<string, string> = {}
    const saveEnv = async (_p: string, k: string, v: string) => { env[k] = v }
    expect(await hermesHasWikiTools('default', cfg, conn!.url)).toBe(false)
    expect(await giveHermesWikiTools('default', conn!, cfg, saveEnv)).toBe(true)
    expect(cfg.data.mcp_servers[WIKI_MCP_NAME]).toEqual({ url: 'http://vault.lan:27123/mcp', headers: { Authorization: `Bearer \${${WIKI_KEY_ENV}}` } })
    expect(JSON.stringify(cfg.data)).not.toContain('k-secret')          // the key is only in .env
    expect(env).toEqual({ [WIKI_KEY_ENV]: 'k-secret' })
    expect(await giveHermesWikiTools('default', conn!, cfg, saveEnv)).toBe(false)
    // an entry of the user's own at the same address counts
    const own = memoryConfig({ mcp_servers: { vault: { url: 'http://vault.lan:27123/mcp/' } } })
    expect(await hermesHasWikiTools('default', own, conn!.url)).toBe(true)
  })
})
