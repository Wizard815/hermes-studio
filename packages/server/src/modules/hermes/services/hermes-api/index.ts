import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { findHermesCli } from '../herdr-launch'

/**
 * Hermes Agent's own API, run privately for Studio. Studio starts
 * `hermes dashboard --isolated` on a loopback port with a session token only
 * Studio knows, and Studio's pages call it through /api/hermes-agent/* behind
 * Studio's login. Studio is the UI for every Hermes integration (messaging
 * platforms, memory providers, toolsets, webhooks, MCP catalog, plugins hub,
 * local models, ...); Hermes's own dashboard UI is never needed.
 */
const READY_TIMEOUT_MS = 90_000
const IDLE_STOP_MS = Number(process.env.STUDIO_HERMES_API_IDLE_MINUTES || 30) * 60_000
const LOG_LINES = 60

export interface HermesApiStatus {
  available: boolean
  running: boolean
  starting: boolean
  error: string | null
  version: string | null
  log: string[]
}

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.unref()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => resolvePort(port))
    })
  })
}

export class HermesApiBridge {
  private child: ChildProcess | null = null
  private port = 0
  private token = ''
  private starting: Promise<void> | null = null
  private error: string | null = null
  private version: string | null = null
  private log: string[] = []
  private lastUse = 0
  private idleTimer: NodeJS.Timeout | null = null

  constructor(private readonly fetcher: typeof fetch = fetch) {}

  private remember(text: string) {
    for (const line of text.split(/\r?\n/)) if (line.trim() && !line.includes('install out of sync')) this.log.push(line.slice(0, 300))
    if (this.log.length > LOG_LINES) this.log.splice(0, this.log.length - LOG_LINES)
  }

  status(): HermesApiStatus {
    return {
      available: !!findHermesCli(),
      running: !!this.child && this.child.exitCode === null && !this.starting,
      starting: !!this.starting,
      error: this.error,
      version: this.version,
      log: this.log.slice(-15),
    }
  }

  /** Starts Hermes's API if it is not running and waits until it answers. */
  ensureRunning(): Promise<void> {
    this.lastUse = Date.now()
    if (this.child && this.child.exitCode === null && !this.starting) return Promise.resolve()
    if (this.starting) return this.starting
    this.starting = this.start().finally(() => { this.starting = null })
    return this.starting
  }

  private async start() {
    const cli = findHermesCli()
    if (!cli) { this.error = 'Hermes Agent is not installed here'; throw Object.assign(new Error(this.error), { status: 503 }) }
    this.error = null
    this.port = await freePort()
    this.token = randomBytes(32).toString('base64url')
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HERMES_HOME: resolve(process.env.HERMES_HOME || join(homedir(), '.hermes')),
      HERMES_DASHBOARD_SESSION_TOKEN: this.token,
      // Run as Studio's user (the image's shim would switch users).
      HERMES_DOCKER_EXEC_AS_ROOT: '1',
    }
    this.remember(`Starting Hermes Agent API on 127.0.0.1:${this.port}`)
    const child = spawn(cli, ['dashboard', '--isolated', '--host', '127.0.0.1', '--port', String(this.port), '--skip-build', '--no-open'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    this.child = child
    child.stdout?.on('data', chunk => this.remember(String(chunk)))
    child.stderr?.on('data', chunk => this.remember(String(chunk)))
    child.once('exit', (code, signal) => {
      if (this.child === child) this.child = null
      this.remember(`Hermes Agent API stopped (${signal || `exit ${code}`})`)
    })
    const deadline = Date.now() + READY_TIMEOUT_MS
    while (Date.now() < deadline && child.exitCode === null) {
      try {
        const response = await this.fetcher(`http://127.0.0.1:${this.port}/api/status`, { signal: AbortSignal.timeout(2000) })
        if (response.ok) {
          const body = await response.json().catch(() => ({})) as { version?: string; release_date?: string }
          this.version = [body.version, body.release_date ? `(${body.release_date})` : ''].filter(Boolean).join(' ') || null
          this.watchIdle()
          return
        }
      } catch { /* not up yet */ }
      await new Promise(resolveWait => setTimeout(resolveWait, 500))
    }
    this.error = child.exitCode !== null ? `Hermes Agent API exited (code ${child.exitCode}); see the log` : 'Hermes Agent API did not start in time'
    child.kill('SIGTERM')
    throw Object.assign(new Error(this.error), { status: 503 })
  }

  private watchIdle() {
    if (this.idleTimer || !(IDLE_STOP_MS > 0)) return
    this.idleTimer = setInterval(() => {
      if (this.child && Date.now() - this.lastUse > IDLE_STOP_MS) {
        this.remember('Stopping the Hermes Agent API: not used for a while')
        this.stop()
      }
    }, 60_000)
    this.idleTimer.unref()
  }

  /**
   * One call to Hermes's API (`path` starts after /api/). Studio's active
   * profile is added unless the caller names one.
   */
  async request(method: string, path: string, query: URLSearchParams, body: unknown, profile?: string): Promise<{ status: number; contentType: string; body: Buffer }> {
    await this.ensureRunning()
    this.lastUse = Date.now()
    const params = new URLSearchParams(query)
    if (profile && !params.has('profile')) params.set('profile', profile)
    const search = params.toString()
    const url = `http://127.0.0.1:${this.port}/api/${path}${search ? `?${search}` : ''}`
    const hasBody = !['GET', 'HEAD'].includes(method) && body !== undefined
    const response = await this.fetcher(url, {
      method,
      headers: { 'X-Hermes-Session-Token': this.token, Accept: 'application/json', ...(hasBody ? { 'Content-Type': 'application/json' } : {}) },
      ...(hasBody ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(Number(process.env.STUDIO_HERMES_API_TIMEOUT_MS || 120_000)),
    })
    return {
      status: response.status,
      contentType: response.headers.get('content-type') || 'application/json',
      body: Buffer.from(await response.arrayBuffer()),
    }
  }

  stop() {
    const child = this.child
    this.child = null
    if (child && child.exitCode === null) {
      child.kill('SIGTERM')
      setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL') }, 5000).unref()
    }
  }

  close() {
    if (this.idleTimer) clearInterval(this.idleTimer)
    this.idleTimer = null
    this.stop()
  }
}

export const hermesApi = new HermesApiBridge()

/**
 * Paths Studio never forwards: Hermes's own web app, terminals, and its auth
 * and update machinery belong to Hermes's UI (Studio has its own).
 */
const BLOCKED = [/^webapp/, /^pty/, /^console/, /^host-terminal/, /^hermes\/update$/, /^env\/reveal$/]

export function hermesApiPathAllowed(path: string): boolean {
  if (!path || path.includes('..') || path.startsWith('/')) return false
  return !BLOCKED.some(pattern => pattern.test(path))
}
