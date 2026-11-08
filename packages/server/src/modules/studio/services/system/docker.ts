import { request } from 'node:http'
import { existsSync } from 'node:fs'

/** Docker Engine API over its local socket: no Docker CLI needed in the Studio image. */

export interface DockerContainer {
  id: string
  name: string
  image: string
  state: string
  status: string
  ports: string[]
  composeProject?: string
}

export type DockerAction = 'start' | 'stop' | 'restart'

const API = '/v1.41'
const CONTAINER_ID = /^[a-f0-9]{12,64}$/

/** The engine socket: DOCKER_HOST (unix:// or npipe://), then the platform default. */
export function dockerSocket(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string | null {
  const host = env.DOCKER_HOST?.trim()
  if (host?.startsWith('unix://')) return host.slice('unix://'.length)
  if (host?.startsWith('npipe://')) return host.slice('npipe://'.length).replace(/\//g, '\\')
  if (host) return null // tcp:// engines are out of scope: they need TLS settings Studio does not hold.
  if (platform === 'win32') return '\\\\.\\pipe\\docker_engine'
  return existsSync('/var/run/docker.sock') ? '/var/run/docker.sock' : null
}

function call(socketPath: string, method: string, path: string, timeoutMs = 15_000): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, method, path: `${API}${path}`, headers: { host: 'docker' }, timeout: timeoutMs }, res => {
      const chunks: Buffer[] = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks) }))
      res.on('error', reject)
    })
    req.on('timeout', () => req.destroy(new Error('Docker did not answer in time')))
    req.on('error', reject)
    req.end()
  })
}

function engineError(status: number, body: Buffer): Error {
  let message = body.toString('utf8').trim()
  try { message = JSON.parse(message).message || message } catch { /* plain text */ }
  return Object.assign(new Error(message || `Docker answered ${status}`), { status: status >= 400 && status < 600 ? status : 502 })
}

export function parseContainers(json: any[]): DockerContainer[] {
  return json.map(c => ({
    id: String(c.Id).slice(0, 12),
    name: String(c.Names?.[0] || c.Id).replace(/^\//, ''),
    image: String(c.Image || ''),
    state: String(c.State || ''),
    status: String(c.Status || ''),
    ports: [...new Set<string>((c.Ports || [])
      .filter((p: any) => p.PublicPort)
      .map((p: any) => `${p.PublicPort}→${p.PrivatePort}/${p.Type}`))],
    ...(c.Labels?.['com.docker.compose.project'] ? { composeProject: String(c.Labels['com.docker.compose.project']) } : {}),
  })).sort((a, b) => (a.state === 'running' ? 0 : 1) - (b.state === 'running' ? 0 : 1) || a.name.localeCompare(b.name))
}

/**
 * Container logs come multiplexed: frames of [stream, 0, 0, 0, u32 size] + payload
 * unless the container has a TTY, in which case the bytes are raw.
 */
export function demuxLogs(body: Buffer): string {
  const parts: Buffer[] = []
  let i = 0
  while (i + 8 <= body.length && (body[i] === 1 || body[i] === 2 || body[i] === 0) && body[i + 1] === 0 && body[i + 2] === 0 && body[i + 3] === 0) {
    const size = body.readUInt32BE(i + 4)
    parts.push(body.subarray(i + 8, i + 8 + size))
    i += 8 + size
  }
  return (parts.length && i === body.length ? Buffer.concat(parts) : body).toString('utf8')
}

export class DockerClient {
  constructor(private readonly socketPath: () => string | null = () => dockerSocket()) {}

  private socket(): string {
    const path = this.socketPath()
    if (!path) throw Object.assign(new Error('Docker is not available here. Mount /var/run/docker.sock into the Studio container, or install Docker on this computer.'), { status: 503 })
    return path
  }

  async status(): Promise<{ available: boolean; version?: string; error?: string }> {
    const path = this.socketPath()
    if (!path) return { available: false }
    try {
      const res = await call(path, 'GET', '/version', 5_000)
      if (res.status !== 200) throw engineError(res.status, res.body)
      return { available: true, version: JSON.parse(res.body.toString('utf8')).Version }
    } catch (error) {
      return { available: false, error: (error as Error).message }
    }
  }

  async containers(): Promise<DockerContainer[]> {
    const res = await call(this.socket(), 'GET', '/containers/json?all=1')
    if (res.status !== 200) throw engineError(res.status, res.body)
    return parseContainers(JSON.parse(res.body.toString('utf8')))
  }

  async action(id: string, action: DockerAction): Promise<void> {
    if (!CONTAINER_ID.test(id)) throw Object.assign(new Error('Invalid container id'), { status: 400 })
    if (!['start', 'stop', 'restart'].includes(action)) throw Object.assign(new Error('Invalid action'), { status: 400 })
    const res = await call(this.socket(), 'POST', `/containers/${id}/${action}`, 60_000)
    // 304: already in that state.
    if (res.status !== 204 && res.status !== 304) throw engineError(res.status, res.body)
  }

  async logs(id: string, tail = 200): Promise<string> {
    if (!CONTAINER_ID.test(id)) throw Object.assign(new Error('Invalid container id'), { status: 400 })
    const lines = Math.min(2000, Math.max(1, Math.round(tail)))
    const res = await call(this.socket(), 'GET', `/containers/${id}/logs?stdout=1&stderr=1&timestamps=0&tail=${lines}`)
    if (res.status !== 200) throw engineError(res.status, res.body)
    return demuxLogs(res.body)
  }
}

export const dockerClient = new DockerClient()
