import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OrbClient, OrbError } from '../../packages/server/src/modules/studio/services/orb/client'

type Call = { url: string; init: RequestInit }

/** Fake Orb: answers health, me, REST data and MCP tools/call. */
function fakeOrb(token = 'tok-1') {
  const calls: Call[] = []
  const fetcher = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init })
    const auth = (init.headers as Record<string, string>)?.Authorization
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    const path = new URL(url).pathname
    if (path === '/api/health') return json(200, { ok: true, version: '0.1.0' })
    if (auth !== `Bearer ${token}`) return json(401, { error: 'sign in' })
    if (path === '/api/me') return json(200, { user: 'studio' })
    if (path === '/api/c/tasks') return json(200, [{ id: 't1', title: 'Fix it' }])
    if (path === '/mcp') {
      const request = JSON.parse(String(init.body))
      const { name, arguments: args } = request.params
      if (name === 'orb_complete_task' && !args.id) return json(200, { jsonrpc: '2.0', id: 1, result: { isError: true, content: [{ type: 'text', text: 'id is required' }] } })
      return json(200, { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify({ called: name, args }) }] } })
    }
    return json(404, { error: 'nope' })
  }) as unknown as typeof fetch
  return { calls, fetcher }
}

describe('Pondering Orb client', () => {
  let dir: string
  let file: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'orb-client-'))
    file = join(dir, 'orb', 'settings.json')
  })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  it('reports not connected until an address is saved', async () => {
    const { fetcher, calls } = fakeOrb()
    const client = new OrbClient(file, {}, fetcher)
    expect(await client.status()).toMatchObject({ connected: false, error: '' })
    expect(calls).toHaveLength(0)
    await expect(client.data('tasks')).rejects.toMatchObject({ status: 409 })
  })

  it('saves settings privately and never returns the token', async () => {
    const { fetcher } = fakeOrb()
    const client = new OrbClient(file, {}, fetcher)
    const saved = await client.save({ url: 'http://orb:8080/', token: 'tok-1' })
    expect(saved).toEqual({ url: 'http://orb:8080', hasToken: true, fromEnv: false })
    expect(JSON.stringify(saved)).not.toContain('tok-1')
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    // An empty token keeps the stored one.
    await client.save({ url: 'http://orb:9090', token: '' })
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ url: 'http://orb:9090', token: 'tok-1' })
    await expect(client.save({ url: 'ftp://orb' })).rejects.toMatchObject({ status: 400 })
  })

  it('checks the token, reads data and calls allowed tools', async () => {
    const { fetcher, calls } = fakeOrb()
    const client = new OrbClient(file, {}, fetcher)
    await client.save({ url: 'http://orb:8080', token: 'tok-1' })
    expect(await client.status()).toMatchObject({ connected: true, version: '0.1.0' })
    expect(await client.data('tasks')).toEqual([{ id: 't1', title: 'Fix it' }])
    expect(await client.tool('orb_add_task', { title: 'New' })).toEqual({ called: 'orb_add_task', args: { title: 'New' } })
    expect(calls.every(call => call.url.startsWith('http://orb:8080/'))).toBe(true)
    await expect(client.data('secrets')).rejects.toMatchObject({ status: 404 })
    await expect(client.tool('orb_delete_everything')).rejects.toMatchObject({ status: 404 })
    await expect(client.tool('orb_complete_task', {})).rejects.toThrow('id is required')
  })

  it('reports a rejected token as not connected', async () => {
    const { fetcher } = fakeOrb('right')
    const client = new OrbClient(file, {}, fetcher)
    await client.save({ url: 'http://orb:8080', token: 'wrong' })
    const status = await client.status()
    expect(status.connected).toBe(false)
    expect(status.error).toContain('sign in')
  })

  it('uses ORB_URL and ORB_TOKEN when set, and refuses edits', async () => {
    const { fetcher } = fakeOrb('env-tok')
    const client = new OrbClient(file, { ORB_URL: 'http://env-orb/', ORB_TOKEN: 'env-tok' }, fetcher)
    expect(await client.publicSettings()).toEqual({ url: 'http://env-orb', hasToken: true, fromEnv: true })
    expect((await client.status()).connected).toBe(true)
    await expect(client.save({ url: 'http://other' })).rejects.toBeInstanceOf(OrbError)
  })

  it('reports an unreachable Orb clearly', async () => {
    const client = new OrbClient(file, {}, (async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch)
    await client.save({ url: 'http://orb:8080', token: 'tok-1' })
    await expect(client.data('tasks')).rejects.toThrow('Pondering Orb is unreachable: ECONNREFUSED')
  })
})
