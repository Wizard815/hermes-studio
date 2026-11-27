import { createServer, request, type Server } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import AdmZip from 'adm-zip'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeDocker, type FakeObject } from './fixtures/fake-docker'
import { LabDocker, runLabels } from '../../packages/server/src/modules/studio/services/test-lab/docker'
import { TestLabService, refusalReason, type TestLabDeps, type TestLabRun } from '../../packages/server/src/modules/studio/services/test-lab/service'
import { modelPin, testLabSessionId } from '../../packages/server/src/modules/studio/services/test-lab/pin'

const MODEL = { id: 'openrouter/tencent/hy4-flash', provider: 'openrouter', model: 'tencent/hy4-flash', profile: 'default' }
let fake: FakeDocker
let home: string
let gateway: Server
let gatewayPort = 0
const gatewayCalls: Array<{ path: string; auth: string; body: string }> = []
let spent = { costUsd: 0, tokens: 0, unpricedCalls: 0 }
const limits: Record<string, { capUsd: number; minutes: number }> = {}

function bind(container: FakeObject, inside: string): string {
  return container.Binds!.find(b => b.split(':')[1] === inside)!.split(':')[0]
}

function makeService(overrides: Partial<TestLabDeps> = {}) {
  return new TestLabService({
    home: () => home,
    docker: new LabDocker(() => fake.socket),
    instance: 'inst',
    models: async () => [MODEL],
    registerGateway: vi.fn(async () => ({ dispose: vi.fn() })),
    gatewayPort: () => gatewayPort,
    limits: { set: (s, capUsd, minutes) => { limits[s] = { capUsd, minutes } }, spent: () => spent, forget: s => { delete limits[s] } },
    openRouterUsage: async () => null,
    pollMs: 40,
    ...overrides,
  })
}

async function waitFor<T>(read: () => T, done: (value: T) => boolean, ms = 8000): Promise<T> {
  const until = Date.now() + ms
  for (;;) {
    const value = read()
    if (done(value)) return value
    if (Date.now() > until) throw new Error(`timed out: ${JSON.stringify(value).slice(0, 600)}`)
    await new Promise(r => setTimeout(r, 30))
  }
}

function tunnel(socket: string, method: string, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: socket, method, path, headers: { 'content-type': 'application/json' } }, res => {
      let body = ''; res.on('data', c => { body += c }); res.on('end', () => resolve({ status: res.statusCode || 0, body }))
    })
    req.on('error', reject)
    req.end(JSON.stringify({ model: MODEL.id, messages: [] }))
  })
}

beforeEach(async () => {
  fake = new FakeDocker()
  fake.ignoreFilters = false
  await fake.start()
  home = mkdtempSync(join(tmpdir(), 'tl-'))
  gatewayCalls.length = 0
  spent = { costUsd: 0, tokens: 0, unpricedCalls: 0 }
  gateway = createServer((req, res) => {
    let body = ''; req.on('data', c => { body += c })
    req.on('end', () => { gatewayCalls.push({ path: req.url || '', auth: String(req.headers.authorization), body }); res.writeHead(200, { 'content-type': 'application/json' }).end('{"choices":[]}') })
  })
  await new Promise<void>(done => gateway.listen(0, '127.0.0.1', () => { gatewayPort = (gateway.address() as any).port; done() }))
})
afterEach(async () => {
  await new Promise(done => gateway.close(done))
  await fake.stop()
  rmSync(home, { recursive: true, force: true })
})

describe('Test Lab runs', () => {
  it('starts apps on a private network, runs the runner, reports, then removes only its own containers', async () => {
    const plex = fake.add('containers', { Names: ['/plex'], Labels: {} })
    let tunnelChecks: Array<{ status: number; body: string }> = []
    fake.onStart = container => {
      if (container.Labels['studio.testlab.app'] !== 'runner') return
      const out = bind(container, '/out')
      const socket = join(bind(container, '/tunnel'), 'lab.sock')
      void (async () => {
        tunnelChecks = [await tunnel(socket, 'POST', '/v1/chat/completions'), await tunnel(socket, 'GET', '/v1/models'), await tunnel(socket, 'POST', '/api/studio/users')]
        mkdirSync(join(out, 'screenshots'), { recursive: true })
        writeFileSync(join(out, 'screenshots', 'app-nginx.png'), Buffer.from([0x89, 0x50]))
        const emit = (e: object) => appendFileSync(join(out, 'progress.jsonl'), `${JSON.stringify({ at: Date.now(), ...e })}\n`)
        emit({ type: 'health', app: 'nginx', ok: true, status: 200 })
        emit({ type: 'screenshot', file: 'app-nginx.png' })
        emit({ type: 'agent', role: 'tool', tool: 'browser_open', text: '{"url":"http://nginx:80"}' })
        emit({ type: 'agent', role: 'assistant', text: 'The welcome page loads.' })
        writeFileSync(join(out, 'report.md'), '# Test Lab report\n\n## Summary\n\nFine.\n\n## Checks\n\n- [PASS] Welcome page — it loads\n')
        emit({ type: 'report' })
        container.Running = false
        container.State = 'exited'
      })()
    }
    spent = { costUsd: 0.0123, tokens: 4567, unpricedCalls: 0 }
    const service = makeService()
    const started = await service.start(1, { model: MODEL.id, apps: ['nginx'], instructions: 'Click every menu', capUsd: 0.25 })
    expect(started.status).toBe('starting')
    const run = await waitFor(() => service.read(started.id), r => !!r.finishedAt && !!r.removed)
    expect(run.status).toBe('passed')
    expect(run.report).toMatchObject({ summary: 'Fine.', passed: 1, failed: 0 })
    expect(run.apps[0]).toMatchObject({ id: 'nginx', state: 'removed', url: 'http://nginx:80' })
    expect(run.transcript.map(line => line.text)).toEqual(['{"url":"http://nginx:80"}', 'The welcome page loads.'])
    expect(run.screenshots).toEqual(['app-nginx.png'])
    expect(run.logs.sort()).toEqual(['browser', 'nginx', 'runner'])
    expect(run.cost).toMatchObject({ gatewayUsd: 0.0123, tokens: 4567 })
    expect(run.steps.find(s => s.key === 'cleanup')).toMatchObject({ state: 'done' })
    // Images through the mirror; a private, internal network; the runner locked down.
    expect(fake.pulled).toEqual(expect.arrayContaining(['mirror.gcr.io/library/nginx:1.29.8-alpine', 'mirror.gcr.io/library/node:24-bookworm-slim']))
    const created = fake.calls.filter(c => c.path.startsWith('/containers/create'))
    const runner = created.find(c => c.body.Labels['studio.testlab.app'] === 'runner')!.body
    expect(runner.HostConfig).toMatchObject({ ReadonlyRootfs: true, CapDrop: ['ALL'], NetworkMode: `studio-testlab-${run.id}` })
    expect(runner.User).toBe('1000:1000')
    expect(runner.Env.find((e: string) => e.startsWith('LAB_MODEL='))).toBe(`LAB_MODEL=${MODEL.id}`)
    expect(runner.Env.join('\n')).not.toMatch(/hwui_testlab_/)
    for (const call of created) expect(call.body.Labels).toMatchObject(runLabels(run.id, 'inst', run.createdAt))
    expect(fake.calls.find(c => c.path === '/networks/create')!.body.Internal).toBe(true)
    // The tunnel: chat completions only, with the run's credential added by Studio.
    expect(tunnelChecks.map(c => c.status)).toEqual([200, 403, 403])
    expect(gatewayCalls).toHaveLength(1)
    expect(gatewayCalls[0].path).toBe('/api/ekko-studio/models/v1/chat/completions')
    expect(gatewayCalls[0].auth).toMatch(/^Bearer hwui_testlab_/)
    // Cap and time went to run limits; the pin is gone after the run.
    expect(modelPin(testLabSessionId(run.id))).toBeUndefined()
    expect(limits[testLabSessionId(run.id)]).toBeUndefined()
    // Only the run's containers went; Plex is still there.
    expect(fake.containers.has(plex.Id)).toBe(true)
    expect([...fake.containers.values()].filter(c => c.Labels['studio.testlab.run'])).toEqual([])
    expect(fake.networks.size).toBe(0)
    // The zip holds the report, screenshots and logs.
    const zip = new AdmZip(service.zip(run.id))
    expect(zip.getEntries().map(e => e.entryName).sort()).toEqual(['logs/browser.log', 'logs/nginx.log', 'logs/runner.log', 'progress.jsonl', 'report.md', 'run.json', 'screenshots/app-nginx.png'])
    expect(service.list()[0]).toMatchObject({ id: run.id, status: 'passed', passed: 1 })
  })

  it('stops at the spending cap from OpenRouter\'s counter and kills the runner', async () => {
    const usage = [7.5, 7.6, 8.2, 8.2]
    let runnerId = ''
    fake.onStart = container => { if (container.Labels['studio.testlab.app'] === 'runner') runnerId = container.Id }
    let pinned: unknown
    const service = makeService({
      openRouterUsage: async () => usage.length > 1 ? usage.shift()! : usage[0],
      now: (() => { let t = Date.now(); return () => (t += 20_000) })(),
    })
    const started = await service.start(1, { model: MODEL.id, apps: ['nginx'], capUsd: 0.5, keepRunning: true })
    await waitFor(() => runnerId, id => !!id)
    pinned = modelPin(testLabSessionId(started.id))
    expect(pinned).toMatchObject({ model: 'tencent/hy4-flash' })
    expect(limits[testLabSessionId(started.id)]).toEqual({ capUsd: 0.5, minutes: 20 })
    const run: TestLabRun = await waitFor(() => service.read(started.id), r => !!r.finishedAt)
    expect(run).toMatchObject({ status: 'stopped', stopReason: 'cap' })
    expect(run.cost.openrouterBefore).toBe(7.5)
    expect(run.cost.openrouterUsd).toBeGreaterThanOrEqual(0.5)
    expect(fake.calls.some(c => c.method === 'POST' && c.path === `/containers/${runnerId}/kill`)).toBe(true)
    // Keep running: the containers stay until Remove.
    expect(fake.containers.has(runnerId)).toBe(true)
    expect(run.steps.find(s => s.key === 'cleanup')).toMatchObject({ state: 'skipped' })
    const removed = await service.remove(run.id)
    expect(removed.removed).toBe(true)
    expect([...fake.containers.values()].filter(c => c.Labels['studio.testlab.run'])).toEqual([])
  })

  it('stops at the cap counted by Studio\'s gateway too', async () => {
    const service = makeService()
    fake.onStart = () => { spent = { costUsd: 0.31, tokens: 10, unpricedCalls: 0 } }
    const started = await service.start(1, { model: MODEL.id, apps: ['nginx'], capUsd: 0.3 })
    const run = await waitFor(() => service.read(started.id), r => !!r.finishedAt && !!r.removed)
    expect(run).toMatchObject({ status: 'stopped', stopReason: 'cap' })
  })

  it('skips an app with no image and no git address, and refuses unknown models and apps', async () => {
    const service = makeService()
    await expect(service.start(1, { model: 'openai/gpt-5', apps: ['nginx'] })).rejects.toMatchObject({ code: 'test_lab_model' })
    await expect(service.start(1, { model: MODEL.id, apps: ['nope'] })).rejects.toMatchObject({ code: 'test_lab_apps' })
    await expect(service.start(1, { model: MODEL.id, apps: ['allglance'], builds: { allglance: 'file:///etc' } })).rejects.toMatchObject({ code: 'test_lab_build_url' })
    fake.onStart = container => { if (container.Labels['studio.testlab.app'] === 'runner') { container.Running = false } }
    const started = await service.start(1, { model: MODEL.id, apps: ['nginx', 'allglance', 'pondering-orb'], browser: false })
    const run = await waitFor(() => service.read(started.id), r => !!r.finishedAt && !!r.removed)
    expect(run.apps.find(a => a.id === 'allglance')).toMatchObject({ state: 'skipped', message: expect.stringContaining('git address') })
    expect(fake.built).toEqual(['https://github.com/Wizard815/pondering-orb.git#main'])
    expect(fake.images.has(`studio-testlab/pondering-orb:${run.id}`)).toBe(false) // built image removed with the run
    expect(run.status).toBe('error') // no report written
  })

  it('builds a private forge repo from a context Studio cloned, never sending Docker the token', async () => {
    const forge = { url: 'http://192.168.20.5:3030', token: 'forgetok', hosts: new Set(['192.168.20.5:3030']), defaultHome: '' as const }
    const cloned: string[] = []
    const service = makeService({ forge, forgeContext: async url => { cloned.push(url); return Buffer.from('fake tar bytes') } })
    fake.onStart = container => { if (container.Labels['studio.testlab.app'] === 'runner') { container.Running = false } }
    await expect(service.start(1, { model: MODEL.id, apps: ['allglance'], builds: { allglance: 'http://lan.example/w/r.git' } })).rejects.toMatchObject({ code: 'test_lab_build_url' })
    const started = await service.start(1, { model: MODEL.id, apps: ['allglance'], builds: { allglance: 'http://192.168.20.5:3030/wizard/allglance.git#main' }, browser: false })
    await waitFor(() => service.read(started.id), r => !!r.finishedAt && !!r.removed)
    expect(cloned).toEqual(['http://192.168.20.5:3030/wizard/allglance.git#main'])
    expect(fake.built).toEqual([`context:${'fake tar bytes'.length}`])
    expect(JSON.stringify(fake.calls)).not.toContain('forgetok')
  })

  it('shows the requirement and runs nothing when Docker is not reachable', async () => {
    const service = makeService({ docker: new LabDocker(() => null) })
    const status = await service.status(1)
    expect(status.docker).toEqual({ available: false })
    expect(status.models).toEqual([])
    await expect(service.start(1, { model: MODEL.id, apps: ['nginx'] })).rejects.toMatchObject({ status: 503, code: 'test_lab_no_docker' })
    expect(service.list()).toEqual([])
  })

  it('startup sweep: ends interrupted runs and removes this Studio\'s runs older than a day, nothing else', async () => {
    const now = Date.now()
    const old = fake.add('containers', { Labels: runLabels('20261120-100000-aaaa', 'inst', now - 3 * 86400_000) })
    const recent = fake.add('containers', { Labels: runLabels('20261125-100000-bbbb', 'inst', now - 3600_000) })
    const theirs = fake.add('containers', { Labels: runLabels('20261120-100000-cccc', 'other', now - 3 * 86400_000) })
    const plain = fake.add('containers', { Labels: {} })
    const service = makeService()
    const { removed } = await service.sweep()
    expect(removed).toEqual(['20261120-100000-aaaa'])
    expect(fake.containers.has(old.Id)).toBe(false)
    for (const kept of [recent, theirs, plain]) expect(fake.containers.has(kept.Id)).toBe(true)
  })

  it('names why the gateway refused the agent', () => {
    expect(refusalReason('Run stopped by Studio: cost limit reached: this run used $0.029 of its $0.020 limit.')).toBe('cap')
    expect(refusalReason('Run stopped by Studio: time limit reached')).toBe('time')
    expect(refusalReason('Run stopped by Studio: loop detected')).toBe('limit')
    expect(refusalReason('This Test Lab run is pinned to a/b; c is not allowed')).toBeUndefined()
  })
})
