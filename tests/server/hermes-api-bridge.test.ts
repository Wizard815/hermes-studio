import { describe, expect, it, vi } from 'vitest'
import { HermesApiBridge, hermesApiPathAllowed } from '../../packages/server/src/modules/hermes/services/hermes-api'

describe("Studio's private Hermes Agent API", () => {
  it("forwards Hermes's API paths but never its terminals, web app or secret reveal", () => {
    for (const path of ['memory', 'messaging/platforms', 'tools/toolsets/web/config', 'webhooks', 'mcp/catalog/install']) expect(hermesApiPathAllowed(path)).toBe(true)
    for (const path of ['pty', 'console', 'host-terminal', 'webapp/launch', 'webapp-access/start', 'env/reveal', 'hermes/update', '../etc', '/abs', '', 'env/reveal/', 'env//reveal', 'hermes/update/', 'Webapp/launch', 'PTY', 'env\\reveal']) expect(hermesApiPathAllowed(path)).toBe(false)
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

describe("Hermes's errors and uploads through Studio", () => {
  it('points "the dashboard" at Studio in error text', async () => {
    const { studioWording } = await import('../../packages/server/src/modules/hermes/controllers/hermes-api')
    expect(studioWording(Buffer.from('{"detail":"Mem0 is not ready. Configure it in the dashboard first."}')).toString()).toBe('{"detail":"Mem0 is not ready. Configure it in Studio first."}')
    const plain = Buffer.from('{"detail":"nope"}')
    expect(studioWording(plain)).toBe(plain)
  })

  it('streams an upload with its own content type instead of JSON', async () => {
    const calls: Array<{ url: string; init: any }> = []
    const fetcher = vi.fn(async (url: any, init?: any) => {
      calls.push({ url: String(url), init })
      return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch
    const bridge = new HermesApiBridge(fetcher)
    ;(bridge as any).child = { exitCode: null }
    ;(bridge as any).port = 1234
    ;(bridge as any).token = 't'
    const { Readable } = await import('node:stream')
    await bridge.request('POST', 'ops/import-upload', new URLSearchParams(), undefined, 'work', { stream: Readable.from([Buffer.from('zipdata')]), contentType: 'multipart/form-data; boundary=x', length: '7' })
    expect(calls[0].init.headers['Content-Type']).toBe('multipart/form-data; boundary=x')
    expect(calls[0].init.duplex).toBe('half')
    expect(calls[0].init.body).toBeDefined()
  })
})

describe("Hermes's API going away", () => {
  it('starts it again and sends once more when nothing answered', async () => {
    let calls = 0
    const fetcher = vi.fn(async () => {
      calls += 1
      if (calls === 1) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })
      return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch
    const bridge = new HermesApiBridge(fetcher)
    const killed: string[] = []
    ;(bridge as any).child = { exitCode: null, kill: (signal: string) => killed.push(signal) }
    ;(bridge as any).port = 1234
    // The restart: a fresh child that is up at once.
    ;(bridge as any).start = async function () { this.child = { exitCode: null } }
    const result = await bridge.request('GET', 'memory', new URLSearchParams(), undefined)
    expect(result.status).toBe(200)
    expect(calls).toBe(2)
    expect(killed).toEqual(['SIGKILL'])
  })
  it('does not send a request twice when Hermes may have received it', async () => {
    const fetcher = vi.fn(async () => { throw new Error('aborted') }) as unknown as typeof fetch
    const bridge = new HermesApiBridge(fetcher)
    ;(bridge as any).child = { exitCode: null }
    await expect(bridge.request('POST', 'x', new URLSearchParams(), {})).rejects.toThrow('aborted')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})
