import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, request, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Koa from 'koa'
import { WebSocket, WebSocketServer } from 'ws'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const users: Record<string, { role: string } | null> = {}
vi.mock('../../packages/server/src/modules/studio/public/auth', () => ({
  authenticateUserToken: async (token: string) => users[token] ?? null,
}))

const { VsCodeGateway } = await import('../../packages/server/src/modules/studio/services/vscode/gateway')
const { codeServerArgs, vscodeSocketPath, writeDefaultUserSettings } = await import('../../packages/server/src/modules/studio/services/vscode/manager')
const { installStudioExtension, studioExtensionSource, IGNORED_PATH, STUDIO_EXTENSION_ID } = await import('../../packages/server/src/modules/studio/services/vscode/extension')

describe('VS Code: code-server flags and the Studio extension', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'studio-vscode-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('runs code-server on a private socket with no login of its own and no port', () => {
    const args = codeServerArgs('/data/vscode', '/data/vscode/cs.sock')
    expect(args.join(' ')).toContain('--socket /data/vscode/cs.sock --socket-mode 600')
    expect(args.join(' ')).toContain('--auth none')
    expect(args).toContain('--disable-telemetry')
    expect(args.join(' ')).toContain('--config /data/vscode/config.yaml')
    expect(args.join(' ')).not.toContain('--bind-addr')
  })

  it('hides VS Code\'s own AI chat on a first start and never overwrites your settings', () => {
    writeDefaultUserSettings(dir)
    const file = join(dir, 'data', 'User', 'settings.json')
    expect(JSON.parse(readFileSync(file, 'utf8'))['chat.disableAIFeatures']).toBe(true)
    writeFileSync(file, '{"editor.fontSize": 15}')
    writeDefaultUserSettings(dir)
    expect(readFileSync(file, 'utf8')).toBe('{"editor.fontSize": 15}')
  })

  it('keeps the socket path short enough for a Unix socket', () => {
    expect(vscodeSocketPath('/data/vscode')).toBe('/data/vscode/cs.sock')
    const long = vscodeSocketPath(`/${'x'.repeat(150)}`)
    expect(Buffer.byteLength(long)).toBeLessThan(108)
  })

  it('registers the extension once and keeps other extensions', () => {
    writeFileSync(join(dir, 'extensions.json'), JSON.stringify([{ identifier: { id: 'someone.other' }, version: '1.0.0' }]))
    installStudioExtension(dir)
    installStudioExtension(dir)
    const entries = JSON.parse(readFileSync(join(dir, 'extensions.json'), 'utf8'))
    expect(entries.map((entry: any) => entry.identifier.id)).toEqual(['someone.other', STUDIO_EXTENSION_ID])
    const manifest = JSON.parse(readFileSync(join(dir, entries[1].relativeLocation, 'package.json'), 'utf8'))
    expect(manifest.main).toBe('./extension.js')
    expect(manifest.contributes.configuration.properties['hermesStudio.followAgentEdits'].default).toBe(true)
  })

  it('finds where a file changed and skips build output', () => {
    const module = { exports: {} as any }
    // eslint-disable-next-line no-new-func
    new Function('require', 'module', studioExtensionSource())(() => ({}), module)
    const { firstChangedLine } = module.exports
    expect(firstChangedLine('a\nb\nc', 'a\nB\nc')).toBe(1)
    expect(firstChangedLine('a\nb', 'a\nb\nc')).toBe(2)
    expect(firstChangedLine(undefined, 'a\nb')).toBe(0)
    expect(IGNORED_PATH.test('/w/node_modules/x/index.js')).toBe(true)
    expect(IGNORED_PATH.test('/w/.git/index')).toBe(true)
    expect(IGNORED_PATH.test('/w/package-lock.json')).toBe(true)
    expect(IGNORED_PATH.test('/w/src/build.ts')).toBe(false)
    expect(IGNORED_PATH.test('/w/src/app.ts')).toBe(false)
  })
})

describe('VS Code gateway', () => {
  let dir: string
  let upstream: Server
  let studio: Server
  let base: string
  let close: () => void
  let gateway: InstanceType<typeof VsCodeGateway>
  const seen: Array<{ url: string; headers: Record<string, any> }> = []
  const manager = {
    socketPath: '',
    ensureRunning: vi.fn(async () => {}),
    touch: vi.fn(),
    tunnelOpened: vi.fn(),
    tunnelClosed: vi.fn(),
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'studio-vscode-gw-'))
    manager.socketPath = join(dir, 'cs.sock')
    seen.length = 0
    users.admin = { role: 'super_admin' }
    users.member = { role: 'user' }
    // A stand-in code-server on the socket.
    upstream = createServer((req, res) => {
      seen.push({ url: req.url || '', headers: req.headers })
      if (req.url?.startsWith('/go-home')) { res.writeHead(302, { Location: '/?folder=/w' }); res.end(); return }
      res.writeHead(200, { 'content-type': 'text/html', 'x-frame-options': 'DENY', 'content-security-policy': "default-src 'self'; frame-ancestors 'none'" })
      res.end(`code-server ${req.method} ${req.url}`)
    })
    const wss = new WebSocketServer({ server: upstream })
    wss.on('connection', socket => socket.on('message', data => socket.send(`echo:${data}`)))
    await new Promise<void>(resolve => upstream.listen(manager.socketPath, resolve))

    gateway = new VsCodeGateway(manager as any)
    const app = new Koa()
    app.use(async (ctx, next) => { ctx.set('X-Frame-Options', 'DENY'); ctx.set('Content-Security-Policy', "frame-ancestors 'none'"); await next() })
    app.use(gateway.middleware)
    app.use(ctx => { ctx.body = 'studio' })
    studio = createServer(app.callback())
    close = gateway.attach([studio])
    await new Promise<void>(resolve => studio.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(studio.address() as AddressInfo).port}`
  })

  afterEach(async () => {
    close()
    await new Promise(resolve => studio.close(resolve))
    upstream.closeAllConnections?.()
    await new Promise(resolve => upstream.close(resolve))
    rmSync(dir, { recursive: true, force: true })
  })

  it('only gives links to super administrators', async () => {
    await expect(gateway.create('member')).rejects.toThrow(/Super administrator/)
    await expect(gateway.create('nobody')).rejects.toThrow()
    const ticket = await gateway.create('admin')
    expect(ticket.path).toMatch(/^\/vscode\/[a-f0-9]{48}\/$/)
  })

  it('serves code-server under the link, framed only by Studio, without Studio credentials', async () => {
    const { path } = await gateway.create('admin')
    const response = await fetch(`${base}${path}?folder=%2Fw`, { headers: { Authorization: 'Bearer admin' } })
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('code-server GET /?folder=%2Fw')
    expect(response.headers.get('x-frame-options')).toBe('SAMEORIGIN')
    expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'self'")
    expect(seen[0].headers.authorization).toBeUndefined()
    expect(manager.ensureRunning).toHaveBeenCalled()
  })

  it('keeps redirects inside the link and adds the trailing slash', async () => {
    const { path } = await gateway.create('admin')
    const redirect = await fetch(`${base}${path}go-home`, { redirect: 'manual' })
    expect(redirect.headers.get('location')).toBe(`${path.slice(0, -1)}/?folder=/w`)
    const bare = await fetch(`${base}${path.slice(0, -1)}?folder=x`, { redirect: 'manual' })
    expect(bare.headers.get('location')).toBe(`${path}?folder=x`)
  })

  it('refuses unknown links, lost roles and other sites', async () => {
    expect((await fetch(`${base}/vscode/${'a'.repeat(48)}/`)).status).toBe(401)
    const { path } = await gateway.create('admin')
    expect((await fetch(`${base}${path}`, { headers: { Origin: 'https://evil.example' } })).status).toBe(403)
    users.admin = { role: 'user' }
    expect((await fetch(`${base}${path}`)).status).toBe(401)
    users.admin = { role: 'super_admin' }
    // The link was dropped when the role was lost.
    expect((await fetch(`${base}${path}`)).status).toBe(401)
    expect(await (await fetch(`${base}/other`)).text()).toBe('studio')
  })

  it('carries websockets through to code-server', async () => {
    const { path } = await gateway.create('admin')
    const url = `${base.replace('http', 'ws')}${path}socket?x=1`
    const socket = new WebSocket(url, { headers: { Origin: base } })
    const reply = await new Promise<string>((resolve, reject) => {
      socket.once('open', () => socket.send('hi'))
      socket.once('message', data => resolve(String(data)))
      socket.once('error', reject)
    })
    expect(reply).toBe('echo:hi')
    expect(manager.tunnelOpened).toHaveBeenCalled()
    socket.close()
    const bad = new WebSocket(`${base.replace('http', 'ws')}/vscode/${'b'.repeat(48)}/socket`)
    await expect(new Promise((resolve, reject) => { bad.once('open', resolve); bad.once('error', reject) })).rejects.toThrow(/403/)
  })
})
