import { spawn } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseReport } from '../../packages/server/src/modules/studio/services/test-lab/report'

const RUNNER = resolve('packages/server/src/assets/test-lab/runner.mjs')
const servers: Server[] = []
const dirs: string[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise(done => server.close(done))))
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function listen(server: Server, where: number | string): Promise<number> {
  servers.push(server)
  return new Promise(done => server.listen(where as any, '127.0.0.1' as any, () => done((server.address() as any)?.port || 0)))
}

function readBody(req: any): Promise<string> {
  return new Promise(done => { let raw = ''; req.on('data', (c: Buffer) => { raw += c }); req.on('end', () => done(raw)) })
}

describe('Test Lab runner', () => {
  it('waits for health, seeds with saved variables, runs the agent loop and writes the report', async () => {
    const out = mkdtempSync(join(tmpdir(), 'tl-run-')); dirs.push(out)
    const appCalls: string[] = []
    let healthy = 0
    const app = createServer(async (req, res) => {
      const body = await readBody(req)
      appCalls.push(`${req.method} ${req.url} ${req.headers.authorization || ''} ${body}`)
      if (req.url === '/health') { res.writeHead(++healthy < 2 ? 503 : 200).end('ok'); return }
      if (req.url === '/login') { res.writeHead(200, { 'content-type': 'application/json', token: 'hdr-token' }).end(JSON.stringify({ user: { id: 7 } })); return }
      if (req.url === '/users/7/tasks') { res.writeHead(201).end('{}'); return }
      if (req.url === '/tasks') { res.writeHead(200).end('[{"title":"secret"}]'); return }
      res.writeHead(404).end('no')
    })
    const port = await listen(app, 0)
    const requests: any[] = []
    const gateway = createServer(async (req, res) => {
      const body = JSON.parse(await readBody(req))
      requests.push({ url: req.url, body })
      const call = (name: string, args: unknown) => ({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: `c${requests.length}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] })
      const reply = requests.length === 1 ? call('http_request', { method: 'GET', url: `http://127.0.0.1:${port}/tasks` })
        : requests.length === 2 ? call('http_request', { method: 'GET', url: 'http://example.com/' })
          : call('report', { summary: 'Tasks load.', checks: [{ name: 'Task list', result: 'pass', detail: 'one task' }, { name: 'Private tasks', result: 'fail', detail: 'bob sees "secret"' }] })
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(reply))
    })
    const socket = join(out, 'lab.sock')
    await new Promise<void>(done => { servers.push(gateway); gateway.listen(socket, () => done()) })
    const apps = [{
      id: 'todo', name: 'Todo', baseUrl: `http://127.0.0.1:${port}`, health: { path: '/health', timeoutSeconds: 20 },
      logins: [{ username: 'alice', password: 'pw' }],
      seed: [
        { name: 'Login', method: 'POST', path: '/login', json: { user: 'alice' }, save: { token: 'header:token', uid: 'user.id' } },
        { name: 'Task', method: 'PUT', path: '/users/{{uid}}/tasks', headers: { Authorization: 'Bearer {{token}}' }, json: { title: 'secret' }, expect: [201] },
        { name: 'Optional broken', method: 'GET', path: '/missing', optional: true },
      ],
    }]
    const code = await new Promise<number>(done => {
      const child = spawn(process.execPath, [RUNNER], { env: { PATH: process.env.PATH, LAB_OUT: out, LAB_TUNNEL: socket, LAB_MODEL: 'openrouter/tencent/hy4-flash', LAB_APPS: JSON.stringify(apps), LAB_INSTRUCTIONS: 'Check private tasks', LAB_MAX_STEPS: '5' } })
      child.on('exit', c => done(c ?? -1))
    })
    expect(code).toBe(0)
    expect(appCalls).toContain(`PUT /users/7/tasks Bearer hdr-token {"title":"secret"}`)
    expect(requests[0].url).toBe('/v1/chat/completions')
    expect(requests[0].body.model).toBe('openrouter/tencent/hy4-flash')
    expect(requests[0].body.messages[0].content).toContain(`login: alice / pw`)
    expect(requests[0].body.messages[1].content).toBe('Check private tasks')
    expect(requests[1].body.messages.at(-1).content).toContain('HTTP 200')
    expect(requests[2].body.messages.at(-1).content).toBe('That address is not one of the apps')
    const events = readFileSync(join(out, 'progress.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    expect(events.filter(e => e.type === 'health')).toEqual([expect.objectContaining({ app: 'todo', ok: true })])
    expect(events.filter(e => e.type === 'seed').map(e => [e.step, e.ok])).toEqual([['Login', true], ['Task', true], ['Optional broken', false]])
    expect(events.at(-1)).toMatchObject({ type: 'done', outcome: 'reported' })
    const report = parseReport(readFileSync(join(out, 'report.md'), 'utf8'))
    expect(report).toMatchObject({ summary: 'Tasks load.', passed: 1, failed: 1, checks: [{ name: 'Task list', result: 'pass', detail: 'one task' }, { name: 'Private tasks', result: 'fail', detail: 'bob sees "secret"' }] })
  }, 30_000)

  it('ends with a failed report when the gateway refuses (cap, time or another model)', async () => {
    const out = mkdtempSync(join(tmpdir(), 'tl-run-')); dirs.push(out)
    const app = createServer((_req, res) => { res.writeHead(200).end('ok') })
    const port = await listen(app, 0)
    const gateway = createServer((_req, res) => { res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'Run stopped by Studio: cost limit $0.50 reached' } })) })
    const socket = join(out, 'lab.sock')
    await new Promise<void>(done => { servers.push(gateway); gateway.listen(socket, () => done()) })
    await new Promise<number>(done => {
      const child = spawn(process.execPath, [RUNNER], { env: { PATH: process.env.PATH, LAB_OUT: out, LAB_TUNNEL: socket, LAB_MODEL: 'm', LAB_APPS: JSON.stringify([{ id: 'a', name: 'A', baseUrl: `http://127.0.0.1:${port}`, health: { path: '/' }, logins: [] }]) } })
      child.on('exit', c => done(c ?? -1))
    })
    const events = readFileSync(join(out, 'progress.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    expect(events).toContainEqual(expect.objectContaining({ type: 'stopped', reason: 'refused', message: expect.stringContaining('cost limit') }))
    const report = parseReport(readFileSync(join(out, 'report.md'), 'utf8'))
    expect(report.failed).toBe(1)
    expect(report.summary).toContain('cost limit')
  }, 30_000)
})

describe('Test Lab report format', () => {
  it('reads the fixed format and lenient variants', () => {
    const report = parseReport([
      '# Test Lab report', '', '## Summary', '', 'Mostly fine.', 'Two lines.', '', '## Checks', '',
      '- [PASS] Login works — alice signs in',
      '* [ fail ] Menu: Settings -- 500 error',
      '- [Skipped] Mattermost',
      '- [OK] Logout - back on sign-in page',
      '- not a check',
    ].join('\r\n'))
    expect(report.summary).toBe('Mostly fine.\nTwo lines.')
    expect(report.checks).toEqual([
      { name: 'Login works', result: 'pass', detail: 'alice signs in' },
      { name: 'Menu', result: 'fail', detail: 'Settings -- 500 error' },
      { name: 'Mattermost', result: 'skip' },
      { name: 'Logout', result: 'pass', detail: 'back on sign-in page' },
    ])
    expect([report.passed, report.failed, report.skipped]).toEqual([2, 1, 1])
    expect(parseReport('')).toMatchObject({ summary: '', checks: [], passed: 0 })
  })
})
