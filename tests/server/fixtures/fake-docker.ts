import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * A fake Docker Engine API on a Unix socket, for Test Lab tests. It keeps
 * containers, networks, volumes and images in memory and records every call.
 * List calls ignore label filters on purpose (`ignoreFilters`), so the code's
 * own label check is what keeps other objects safe.
 */
export interface FakeObject { Id: string; Name?: string; Names?: string[]; Labels: Record<string, string>; State?: string; Image?: string; Binds?: string[]; Env?: string[]; Running?: boolean; HostConfig?: any }

export class FakeDocker {
  containers = new Map<string, FakeObject>()
  networks = new Map<string, FakeObject>()
  volumes = new Map<string, FakeObject>()
  images = new Map<string, FakeObject>()
  calls: Array<{ method: string; path: string; body?: any }> = []
  pulled: string[] = []
  built: string[] = []
  ignoreFilters = true
  failPull = new Set<string>()
  /** Called when a container starts (the test plays the runner). */
  onStart: (container: FakeObject) => void = () => {}
  private server!: Server
  private dir = mkdtempSync(join(tmpdir(), 'fd-'))
  socket = join(this.dir, 'd.sock')
  private seq = 0

  add(kind: 'containers' | 'networks' | 'volumes' | 'images', object: Partial<FakeObject> & { Labels?: Record<string, string> }): FakeObject {
    const id = object.Id || `${kind.slice(0, 1)}${String(++this.seq).padStart(11, '0')}`
    const full = { State: 'running', Running: kind === 'containers', ...object, Id: id, Labels: object.Labels || {} } as FakeObject
    this[kind].set(id, full)
    return full
  }

  private filtered(map: Map<string, FakeObject>, query: URLSearchParams): FakeObject[] {
    const all = [...map.values()]
    if (this.ignoreFilters) return all
    const labels: string[] = JSON.parse(query.get('filters') || '{}').label || []
    return all.filter(item => labels.every(label => {
      const [key, value] = label.split('=')
      return value === undefined ? key in item.Labels : item.Labels[key] === value
    }))
  }

  start(): Promise<void> {
    this.server = createServer((req, res) => {
      let raw = ''
      req.on('data', chunk => { raw += chunk })
      req.on('end', () => {
        const url = new URL(req.url || '/', 'http://docker')
        const path = url.pathname.replace(/^\/v1\.\d+/, '')
        const body = raw ? JSON.parse(raw) : undefined
        this.calls.push({ method: req.method || '', path: `${path}${url.search}`, body })
        const send = (status: number, value?: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(value === undefined ? '' : JSON.stringify(value)) }
        const m = (re: RegExp) => re.exec(path)
        let match: RegExpExecArray | null
        if (req.method === 'GET' && path === '/version') return send(200, { Version: '99.0-fake' })
        if (req.method === 'GET' && (match = m(/^\/images\/(.+)\/json$/))) return this.images.has(decodeURIComponent(match[1])) ? send(200, {}) : send(404, { message: 'no such image' })
        if (req.method === 'POST' && path === '/images/create') {
          const ref = `${url.searchParams.get('fromImage')}:${url.searchParams.get('tag')}`
          this.pulled.push(ref)
          if (this.failPull.has(ref)) { res.writeHead(200); res.end(`{"status":"Pulling"}\n{"errorDetail":{"message":"pull access denied for ${ref}"},"error":"denied"}\n`); return }
          this.images.set(ref, { Id: ref, Labels: {} })
          res.writeHead(200); res.end('{"status":"Downloaded"}\n'); return
        }
        if (req.method === 'POST' && path === '/build') {
          const tag = url.searchParams.get('t') || ''
          this.built.push(url.searchParams.get('remote') || '')
          this.images.set(tag, { Id: tag, Labels: JSON.parse(url.searchParams.get('labels') || '{}') })
          res.writeHead(200); res.end('{"stream":"Successfully built"}\n'); return
        }
        if (req.method === 'GET' && path === '/images/json') return send(200, this.filtered(this.images, url.searchParams))
        if (req.method === 'DELETE' && (match = m(/^\/images\/(.+)$/))) { this.images.delete(decodeURIComponent(match[1])); return send(200, []) }
        if (req.method === 'POST' && path === '/networks/create') {
          const network = this.add('networks', { Name: body.Name, Labels: body.Labels })
          return send(201, { Id: network.Id })
        }
        if (req.method === 'GET' && path === '/networks') return send(200, this.filtered(this.networks, url.searchParams).map(n => ({ ...n, Name: n.Name })))
        if (req.method === 'DELETE' && (match = m(/^\/networks\/(.+)$/))) { this.networks.delete(decodeURIComponent(match[1])); return send(204) }
        if (req.method === 'GET' && path === '/volumes') return send(200, { Volumes: this.filtered(this.volumes, url.searchParams).map(v => ({ ...v, Name: v.Id })) })
        if (req.method === 'DELETE' && (match = m(/^\/volumes\/(.+)$/))) { this.volumes.delete(decodeURIComponent(match[1])); return send(204) }
        if (req.method === 'POST' && path === '/containers/create') {
          const container = this.add('containers', { Names: [`/${url.searchParams.get('name')}`], Labels: body.Labels, Image: body.Image, Binds: body.HostConfig?.Binds, Env: body.Env, State: 'created', Running: false, HostConfig: body.HostConfig })
          return send(201, { Id: container.Id })
        }
        if (req.method === 'GET' && path === '/containers/json') return send(200, this.filtered(this.containers, url.searchParams))
        if ((match = m(/^\/containers\/([^/]+)(\/[a-z]+)?$/))) {
          const container = this.containers.get(decodeURIComponent(match[1]))
          if (!container) return send(404, { message: 'No such container' })
          const action = match[2]
          if (req.method === 'POST' && action === '/start') { container.State = 'running'; container.Running = true; send(204); this.onStart(container); return }
          if (req.method === 'POST' && action === '/kill') { container.State = 'exited'; container.Running = false; return send(204) }
          if (req.method === 'GET' && action === '/json') return send(200, { Id: container.Id, State: { Running: container.Running, Status: container.State }, Mounts: [] })
          if (req.method === 'GET' && action === '/logs') { res.writeHead(200); res.end(`log of ${container.Names?.[0]}\n`); return }
          if (req.method === 'DELETE' && !action) { this.containers.delete(container.Id); return send(204) }
        }
        send(404, { message: `fake docker: ${req.method} ${path}` })
      })
    })
    return new Promise(done => this.server.listen(this.socket, () => done()))
  }

  async stop() {
    await new Promise<void>(done => this.server.close(() => done()))
    rmSync(this.dir, { recursive: true, force: true })
  }

  /** Calls that changed something (create, start, kill, delete). */
  writes() { return this.calls.filter(call => call.method !== 'GET') }
}
