import { describe, expect, it, vi } from 'vitest'
import { HermesApiBridge, hermesApiPathAllowed } from '../../packages/server/src/modules/hermes/services/hermes-api'

describe("Studio's private Hermes Agent API", () => {
  it("forwards Hermes's API paths but never its terminals, web app or secret reveal", () => {
    for (const path of ['memory', 'messaging/platforms', 'tools/toolsets/web/config', 'webhooks', 'mcp/catalog/install']) expect(hermesApiPathAllowed(path)).toBe(true)
    for (const path of ['pty', 'console', 'host-terminal', 'webapp/launch', 'webapp-access/start', 'env/reveal', 'hermes/update', '../etc', '/abs', '']) expect(hermesApiPathAllowed(path)).toBe(false)
  })

  it("sends Studio's session token and the active profile, and keeps an explicit one", async () => {
    const calls: Array<{ url: string; init: any }> = []
    const fetcher = vi.fn(async (url: any, init?: any) => {
      calls.push({ url: String(url), init })
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch
    const bridge = new HermesApiBridge(fetcher)
    ;(bridge as any).child = { exitCode: null }
    ;(bridge as any).port = 1234
    ;(bridge as any).token = 'secret-token'
    await bridge.request('GET', 'memory', new URLSearchParams(), undefined, 'work')
    await bridge.request('PUT', 'memory/provider', new URLSearchParams('profile=home'), { name: 'honcho' }, 'work')
    expect(calls[0].url).toBe('http://127.0.0.1:1234/api/memory?profile=work')
    expect(calls[0].init.headers['X-Hermes-Session-Token']).toBe('secret-token')
    expect(calls[1].url).toBe('http://127.0.0.1:1234/api/memory/provider?profile=home')
    expect(JSON.parse(calls[1].init.body)).toEqual({ name: 'honcho' })
  })
})
