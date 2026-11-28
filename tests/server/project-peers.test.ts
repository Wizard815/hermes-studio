import { generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { deviceIdFromPublicKey } from '../../packages/server/src/modules/studio/public/system-info'
import {
  CODE_TTL_MS,
  PeerService,
  PeerStore,
  SIGNATURE_WINDOW_MS,
  normalizeCode,
  peerUrl,
  signRequest,
  type PeerFetch,
  type PeerIdentity,
  type PeerRequest,
} from '../../packages/server/src/modules/studio/services/projects/peers'

function identity(): PeerIdentity {
  const pair = generateKeyPairSync('ed25519', { publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } })
  return { device_id: deviceIdFromPublicKey(pair.publicKey), device_public_key: pair.publicKey, device_private_key: pair.privateKey }
}

function fakeProjects() {
  const messages: Array<[string, string, unknown]> = []
  const tasks: Array<[string, any]> = []
  const froms: unknown[] = []
  const project = (id: string, name: string) => ({
    id,
    name,
    counts: { needsYou: 1, working: 0, done: 0, resolved: 0 },
    threads: [{ id: 't1', title: 'Fix login', agent: 'codex', liveStatus: 'blocked', resolved: false, pr: '', brief: 'secret brief', sessionId: 's1' }],
    tasks: [{ id: 'k1', title: 'Review PR', column: 'todo', pr: 'https://github.com/o/r/pull/1', threadId: '' }, { id: 'k2', title: 'Started', column: 'doing', pr: '', threadId: 't1' }],
    artifacts: [{ id: 'a1', title: 'Guide', ref: 'https://example.com/guide', kind: 'link' }, { id: 'a2', title: 'Local', ref: '/srv/x.md', kind: 'file' }],
    instructions: 'private rules',
    memory: [{ id: 'm1', text: 'private fact' }],
  })
  return {
    messages,
    tasks,
    froms,
    projects: {
      list: async () => [project('p1', 'Homelab'), project('p2', 'Private')],
      messageFromStudio: async (projectId: string, studio: string, text: unknown, from?: unknown) => { messages.push([projectId, studio, text]); froms.push(from); return { queued: true } },
      addTask: async (projectId: string, input: any) => { tasks.push([projectId, input]); return { id: 'k9', ...input } },
    },
  }
}

/** Studios in memory; each one's fetch reaches the others' federation handlers. */
function network() {
  let now = 1_000_000
  const sent: PeerRequest[] = []
  const nodes: Record<string, PeerService> = {}
  const fetch: PeerFetch = async (url, init) => {
    const parsed = new URL(url)
    const target = nodes[parsed.origin]
    if (!target) throw new Error('connect ECONNREFUSED')
    const request = { method: init.method, path: parsed.pathname, headers: init.headers, rawBody: init.body ?? '' }
    sent.push(request)
    const reply = await target.handle(request)
    return { status: reply.status, json: async () => reply.body }
  }
  const make = (origin: string, label: string) => {
    const id = identity()
    const fake = fakeProjects()
    const service = new PeerService({ store: new PeerStore(null), projects: () => fake.projects as any, identity: async () => id, fetch, now: () => now, label: () => label })
    nodes[origin] = service
    return { service, id, fake }
  }
  return { make, sent, tick: (ms: number) => { now += ms }, nodes }
}

function studios() {
  const net = network()
  const a = net.make('http://studio-a:8648', 'Office Studio')
  const b = net.make('http://studio-b:8648', 'Garage Studio')
  return { a, b, sent: net.sent, tick: net.tick }
}

type Node = ReturnType<ReturnType<typeof network>['make']> & { url: string; label: string }

/** n Studios named s1…sn. */
function group(n: number) {
  const net = network()
  const all: Node[] = []
  for (let i = 1; i <= n; i++) {
    const url = `http://s${i}:8648`
    all.push({ ...net.make(url, `Studio ${i}`), url, label: `Studio ${i}` })
  }
  const idle = async () => { for (let round = 0; round < 5; round++) await Promise.all(all.map(node => node.service.idle())) }
  /** joiner types host's code, both mark each other as group members, host approves. */
  const join = async (host: Node, joiner: Node, options: { group?: boolean } = { group: true }) => {
    const { code } = await host.service.createCode()
    await joiner.service.pair({ url: host.url, code, selfUrl: joiner.url, group: options.group })
    await host.service.update(joiner.id.device_id, { approved: true, group: options.group })
    await idle()
  }
  const known = async (node: Node) => (await node.service.list()).filter(peer => peer.approved).map(peer => peer.label).sort()
  return { ...net, all, idle, join, known }
}

describe('TestProjects_federation', () => {
  it('cleans addresses and codes', () => {
    expect(peerUrl('http://studio.tailnet.ts.net:8648/')).toBe('http://studio.tailnet.ts.net:8648')
    expect(peerUrl('https://user:pw@studio')).toBe('')
    expect(peerUrl('ftp://studio')).toBe('')
    expect(peerUrl('http://studio/?x=1')).toBe('')
    expect(normalizeCode(' abcd-2345 ')).toBe('ABCD2345')
  })

  it('pairs with a one-time code, waits for approval, then shares only the granted project', async () => {
    const { a, b } = studios()
    const { code } = await a.service.createCode()
    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/)

    const peer = await b.service.pair({ url: 'http://studio-a:8648', code: code.toLowerCase(), selfUrl: 'http://studio-b:8648' })
    expect(peer).toMatchObject({ id: a.id.device_id, label: 'Office Studio', approved: true, url: 'http://studio-a:8648' })
    expect(peer).not.toHaveProperty('publicKey')

    // A knows B now, but B waits for A's approval.
    const [pending] = await a.service.list()
    expect(pending).toMatchObject({ id: b.id.device_id, label: 'Garage Studio', approved: false, url: 'http://studio-b:8648' })
    await expect(b.service.remoteProjects(a.id.device_id)).rejects.toMatchObject({ status: 403, message: expect.stringContaining('Waiting for approval') })

    // The code worked once.
    await expect(b.service.pair({ url: 'http://studio-a:8648', code, selfUrl: 'http://studio-b:8648' })).rejects.toMatchObject({ status: 403 })

    await a.service.update(b.id.device_id, { approved: true })
    expect(await b.service.remoteProjects(a.id.device_id)).toEqual([])

    await a.service.update(b.id.device_id, { projects: ['p1'] })
    await expect(a.service.update(b.id.device_id, { projects: ['nope'] })).rejects.toMatchObject({ status: 404 })
    const projects = await b.service.remoteProjects(a.id.device_id)
    expect(projects.map(project => project.id)).toEqual(['p1'])
    // Only the board summary crosses: no instructions, memory, briefs, chats or local files.
    expect(projects[0]).toEqual({
      id: 'p1',
      name: 'Homelab',
      counts: { needsYou: 1, working: 0, done: 0, resolved: 0 },
      threads: [{ id: 't1', title: 'Fix login', agent: 'codex', status: 'blocked', resolved: false, pr: '' }],
      tasks: [{ id: 'k1', title: 'Review PR', column: 'todo', pr: 'https://github.com/o/r/pull/1' }],
      artifacts: [{ id: 'a1', title: 'Guide', ref: 'https://example.com/guide' }],
    })
    expect(JSON.stringify(projects)).not.toMatch(/private|secret|\/srv/)

    // B messages A's coordinator and adds a task, on the shared project only.
    await b.service.remoteMessage(a.id.device_id, 'p1', 'Can you look at the Argos PR?')
    expect(a.fake.messages).toEqual([['p1', 'Garage Studio', 'Can you look at the Argos PR?']])
    await b.service.remoteTask(a.id.device_id, 'p1', { title: 'Check the ROCm build' })
    expect(a.fake.tasks[0][1]).toMatchObject({ title: 'Check the ROCm build', notes: 'Added by the Studio “Garage Studio”.' })
    await expect(b.service.remoteMessage(a.id.device_id, 'p2', 'hi')).rejects.toMatchObject({ status: 404 })
    expect(a.fake.messages).toHaveLength(1)

    // A shares nothing with B by default the other way, even though B approved A.
    expect(await a.service.remoteProjects(b.id.device_id)).toEqual([])
  })

  it('refuses wrong or expired codes, a Studio pairing with itself, and bad addresses', async () => {
    const { a, b, tick } = studios()
    await expect(b.service.pair({ url: 'http://studio-a:8648', code: 'AAAA-AAAA', selfUrl: 'http://studio-b:8648' })).rejects.toMatchObject({ status: 403, message: expect.stringContaining('wrong or expired') })
    const { code } = await a.service.createCode()
    tick(CODE_TTL_MS + 1)
    await expect(b.service.pair({ url: 'http://studio-a:8648', code, selfUrl: 'http://studio-b:8648' })).rejects.toMatchObject({ status: 403 })
    await expect(b.service.pair({ url: 'nope', code, selfUrl: 'http://studio-b:8648' })).rejects.toMatchObject({ status: 400 })
    await expect(b.service.pair({ url: 'http://studio-a:8648', code: 'ABC', selfUrl: 'http://studio-b:8648' })).rejects.toMatchObject({ status: 400 })
    await expect(b.service.pair({ url: 'http://studio-a:8648', code, selfUrl: '' })).rejects.toMatchObject({ status: 400 })
    const own = await b.service.createCode()
    await expect(b.service.pair({ url: 'http://studio-b:8648', code: own.code, selfUrl: 'http://studio-b:8648' })).rejects.toMatchObject({ status: 400 })
    await expect(b.service.pair({ url: 'http://studio-c:8648', code: own.code, selfUrl: 'http://studio-b:8648' })).rejects.toMatchObject({ status: 502, message: expect.stringContaining("isn't answering") })
    expect(await a.service.list()).toEqual([])
  })

  it('rejects unsigned, forged, replayed, stale and tampered requests', async () => {
    const { a, b, sent, tick } = studios()
    const { code } = await a.service.createCode()
    await b.service.pair({ url: 'http://studio-a:8648', code, selfUrl: 'http://studio-b:8648' })
    await a.service.update(b.id.device_id, { approved: true, projects: ['p1'] })
    await b.service.remoteMessage(a.id.device_id, 'p1', 'hello')
    const good = sent.at(-1)!

    // The same request again: its nonce was used.
    expect((await a.service.handle(good)).status).toBe(401)
    // Unsigned, or from a Studio A never paired with.
    expect((await a.service.handle({ ...good, headers: {} })).status).toBe(401)
    const stranger = identity()
    const forged = signRequest(stranger, 'POST', good.path, good.rawBody, 1_000_000)
    expect((await a.service.handle({ ...good, headers: { ...forged, 'x-studio-peer': b.id.device_id } })).status).toBe(401)
    // B's real key, but a changed body or path.
    const signed = signRequest(b.id, 'POST', good.path, good.rawBody, 1_000_000)
    expect((await a.service.handle({ ...good, headers: signed, rawBody: JSON.stringify({ text: 'rm -rf' }) })).status).toBe(401)
    expect((await a.service.handle({ ...good, headers: signed, path: '/api/studio/federation/projects/p2/message' })).status).toBe(401)
    // Too old.
    tick(SIGNATURE_WINDOW_MS + 1)
    expect((await a.service.handle({ ...good, headers: signRequest(b.id, 'POST', good.path, good.rawBody, 1_000_000) })).status).toBe(401)
    expect(a.fake.messages).toEqual([['p1', 'Garage Studio', 'hello']])
  })

  it('unpairing on one side removes it on both', async () => {
    const { a, b } = studios()
    const { code } = await a.service.createCode()
    await b.service.pair({ url: 'http://studio-a:8648', code, selfUrl: 'http://studio-b:8648' })
    expect(await b.service.remove(a.id.device_id)).toEqual({ removed: true, told: true })
    expect(await a.service.list()).toEqual([])
    expect(await b.service.list()).toEqual([])
    await expect(b.service.remoteProjects(a.id.device_id)).rejects.toMatchObject({ status: 404 })
  })
})

describe('TestProjects_federationHttp', () => {
  it('works between two real Studio servers over HTTP, body signature included', async () => {
    const Koa = (await import('koa')).default
    const { createRequestBodyParser } = await import('../../packages/server/src/modules/studio/middleware/request-body-parser')
    const { federationHandler } = await import('../../packages/server/src/modules/studio/controllers/peers')
    const servers: any[] = []
    const start = async (label: string) => {
      const id = identity()
      const fake = fakeProjects()
      const service = new PeerService({ store: new PeerStore(null), projects: () => fake.projects as any, identity: async () => id, label: () => label })
      const app = new Koa()
      app.use(createRequestBodyParser())
      app.use(async ctx => { if (ctx.path.startsWith('/api/studio/federation/')) await federationHandler(() => service)(ctx) })
      const server = app.listen(0, '127.0.0.1')
      servers.push(server)
      await new Promise(resolve => server.once('listening', resolve))
      return { service, id, fake, url: `http://127.0.0.1:${server.address().port}` }
    }
    try {
      const a = await start('Office Studio')
      const b = await start('Garage Studio')
      const { code } = await a.service.createCode()
      await b.service.pair({ url: a.url, code, selfUrl: b.url })
      await a.service.update(b.id.device_id, { approved: true, projects: ['p1'] })
      expect((await b.service.remoteProjects(a.id.device_id)).map(p => p.name)).toEqual(['Homelab'])
      await b.service.remoteMessage(a.id.device_id, 'p1', 'Ünïcode and "quotes" survive')
      expect(a.fake.messages).toEqual([['p1', 'Garage Studio', 'Ünïcode and "quotes" survive']])
      expect(await b.service.remove(a.id.device_id)).toMatchObject({ told: true })
      expect(await a.service.list()).toEqual([])
    } finally {
      for (const server of servers) server.close()
    }
  })
})

describe('TestProjects_studioGroup', () => {
  it('pairs 6 Studios into one group with one approval each, and all of them can talk', async () => {
    const net = group(6)
    const [hub, ...rest] = net.all
    for (const node of rest) await net.join(hub, node)
    for (const node of net.all) {
      const others = net.all.filter(item => item !== node).map(item => item.label).sort()
      expect(await net.known(node)).toEqual(others)
      expect((await node.service.list()).every(peer => peer.group && peer.approved)).toBe(true)
    }
    // Introduced Studios say who introduced them.
    const s3 = (await net.all[5].service.list()).find(peer => peer.label === 'Studio 3')!
    expect(s3.introducedBy).toMatch(/^Studio \d$/)

    // Studio 3 shares a project with its whole group; Studio 6 reaches it directly, not through the hub.
    await net.all[2].service.setGroupProjects(['p1'])
    const seen = await net.all[5].service.remoteProjects(net.all[2].id.device_id)
    expect(seen.map(project => project.id)).toEqual(['p1'])
    await net.all[5].service.remoteMessage(net.all[2].id.device_id, 'p1', 'Build the ROCm image')
    expect(net.all[2].fake.messages).toEqual([['p1', 'Studio 6', 'Build the ROCm image']])
    // Not shared: p2 stays private.
    await expect(net.all[5].service.remoteMessage(net.all[2].id.device_id, 'p2', 'hi')).rejects.toMatchObject({ status: 404 })
    await expect(net.all[2].service.setGroupProjects(['nope'])).rejects.toMatchObject({ status: 404 })
  })

  it('joins two groups when one member of each pairs with the other', async () => {
    const net = group(5)
    const [a, b, c, d, e] = net.all
    await net.join(a, b)
    await net.join(c, d)
    await net.join(d, e)
    await net.join(b, c)
    for (const node of net.all) expect(await net.known(node)).toHaveLength(4)
  })

  it('learns the other side\'s group even when this Studio had no group yet', async () => {
    const net = group(3)
    const [a, b, c] = net.all
    await net.join(b, c)
    await net.join(a, b)
    expect(await net.known(a)).toEqual(['Studio 2', 'Studio 3'])
    expect(await net.known(c)).toEqual(['Studio 1', 'Studio 2'])
  })

  it('keeps plain pairs out of the group, and refuses introductions from them', async () => {
    const net = group(3)
    const [a, b, c] = net.all
    await net.join(a, b)
    await net.join(a, c, { group: false })
    expect(await net.known(b)).toEqual(['Studio 1'])
    expect(await net.known(c)).toEqual(['Studio 1'])
    // c is paired with a, but not in its group: a takes no introductions from c.
    const body = JSON.stringify({ studios: [] })
    const path = '/api/studio/federation/introduce'
    const reply = await a.service.handle({ method: 'POST', path, headers: signRequest(c.id, 'POST', path, body, 1_000_000), rawBody: body })
    expect(reply.status).toBe(403)
    // Group projects go to group members only.
    await a.service.setGroupProjects(['p1'])
    expect((await b.service.remoteProjects(a.id.device_id)).map(project => project.id)).toEqual(['p1'])
    expect(await c.service.remoteProjects(a.id.device_id)).toEqual([])
  })

  it('does not bring back a Studio the person unpaired', async () => {
    const net = group(4)
    const [a, b, c, d] = net.all
    await net.join(a, b)
    await net.join(a, c)
    await b.service.remove(c.id.device_id)
    expect(await net.known(b)).toEqual(['Studio 1'])
    await net.join(a, d)
    expect(await net.known(b)).toEqual(['Studio 1', 'Studio 4'])
    expect(await net.known(c)).toEqual(['Studio 1', 'Studio 4'])
    expect(await net.known(d)).toEqual(['Studio 1', 'Studio 2', 'Studio 3'])
  })

  it('lets a coordinator get an answer to the project it wrote from, for a day', async () => {
    const net = group(2)
    const [a, b] = net.all
    await net.join(a, b)
    await b.service.setGroupProjects(['p1'])
    await a.service.remoteMessage(b.id.device_id, 'p1', 'Can you run the eval?', { by: 'coordinator', from: { project: 'p2', name: 'Private' } })
    expect(b.fake.froms.at(-1)).toEqual({ project: 'p2', name: 'Private', studio: 'Studio 1' })
    // p2 is not shared with b, but b answers the coordinator that asked.
    await b.service.remoteMessage(a.id.device_id, 'p2', 'Done: 92%', { by: 'coordinator', from: { project: 'p1', name: 'Homelab' } })
    expect(a.fake.messages).toEqual([['p2', 'Studio 2', 'Done: 92%']])
    net.tick(24 * 60 * 60_000 + 1)
    await expect(b.service.remoteMessage(a.id.device_id, 'p2', 'late', { by: 'person' })).rejects.toMatchObject({ status: 404 })

    const log = await a.service.log()
    expect(log.map(entry => [entry.direction, entry.kind, entry.project, entry.by])).toEqual([
      ['out', 'message', 'p1', 'coordinator'],
      ['in', 'message', 'p2', 'coordinator'],
    ])
    expect(log[0].from).toEqual({ project: 'p2', name: 'Private' })
  })

  it('limits how often coordinators message one Studio, but not the person', async () => {
    const net = group(2)
    const [a, b] = net.all
    await net.join(a, b)
    await b.service.setGroupProjects(['p1'])
    for (let i = 0; i < 30; i++) await a.service.remoteMessage(b.id.device_id, 'p1', `ping ${i}`, { by: 'coordinator', from: { project: 'p1', name: 'Homelab' } })
    await expect(a.service.remoteMessage(b.id.device_id, 'p1', 'one more', { by: 'coordinator' })).rejects.toMatchObject({ status: 429 })
    await expect(a.service.remoteTask(b.id.device_id, 'p1', { title: 'more' }, { by: 'coordinator' })).rejects.toMatchObject({ status: 429 })
    await a.service.remoteMessage(b.id.device_id, 'p1', 'from the person')
    expect(b.fake.messages).toHaveLength(31)
    net.tick(60 * 60_000)
    await a.service.remoteMessage(b.id.device_id, 'p1', 'next hour', { by: 'coordinator' })
    await expect(a.service.remoteMessage(b.id.device_id, 'p1', '   ')).rejects.toMatchObject({ status: 400 })
  })

  it('finds a Studio by name for the coordinator, and lists what each shares', async () => {
    const net = group(3)
    const [a, b, c] = net.all
    await net.join(a, b)
    await net.join(a, c)
    await c.service.setGroupProjects(['p2'])
    expect((await a.service.find('studio 3')).id).toBe(c.id.device_id)
    await expect(a.service.find('Nope')).rejects.toMatchObject({ status: 404, message: expect.stringContaining('"Studio 2"') })
    delete net.nodes[b.url]
    const directory = await a.service.directory()
    expect(directory.find(item => item.label === 'Studio 3')!.projects.map(project => project.id)).toEqual(['p2'])
    expect(directory.find(item => item.label === 'Studio 2')!.error).toMatch(/isn't answering/)
  })
})
