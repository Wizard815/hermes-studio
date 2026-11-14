import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { getWebUiHome } from '../../public/config'
import { installStudioExtension } from './extension'

/**
 * VS Code inside Studio: code-server (MIT, from npm) on a Unix socket that only
 * Studio talks to. Studio serves it at /vscode/<ticket>/ behind its own login
 * (see gateway.ts), so code-server runs with --auth none and is never on a port.
 */
export const CODE_SERVER_VERSION = '4.145.2'
const READY_TIMEOUT_MS = 60_000
const LOG_LINES = 80

export interface VsCodeStatus {
  /** code-server can be started (installed by Studio, or found on the machine). */
  available: boolean
  source: 'studio' | 'env' | 'path' | null
  version: string | null
  running: boolean
  installing: boolean
  /** Why it cannot be installed or started here, if it cannot. */
  problem: string | null
  error: string | null
  log: string[]
}

export function vscodeHome(): string {
  return join(getWebUiHome(), 'vscode')
}

/** A socket path short enough for Unix sockets (about 107 bytes). */
export function vscodeSocketPath(home = vscodeHome()): string {
  const path = join(home, 'cs.sock')
  if (Buffer.byteLength(path) < 100) return path
  return join(tmpdir(), `studio-vscode-${createHash('sha1').update(home).digest('hex').slice(0, 12)}.sock`)
}

function nodeMajor(node: string): number {
  if (node === process.execPath) return Number(process.versions.node.split('.')[0])
  const out = spawnSync(node, ['-p', 'process.versions.node'], { encoding: 'utf8', timeout: 10_000 })
  return Number(String(out.stdout || '').trim().split('.')[0]) || 0
}

/** The Node that runs a Studio-installed code-server (code-server needs Node 24). */
function codeServerNode(): string {
  return process.env.STUDIO_VSCODE_NODE?.trim() || process.execPath
}

function onPath(name: string): string | null {
  for (const dir of (process.env.PATH || '').split(delimiter)) {
    if (dir && existsSync(join(dir, name))) return join(dir, name)
  }
  return null
}

interface Launch { command: string; args: string[]; source: 'studio' | 'env' | 'path'; version: string | null }

function installedEntry(home: string): string {
  return join(home, 'app', 'node_modules', 'code-server', 'out', 'node', 'entry.js')
}

/** Written after npm finishes, so a half-done install never counts. */
function installedMarker(home: string): string {
  return join(home, 'app', '.studio-installed')
}

function installedVersion(home: string): string | null {
  try { return JSON.parse(readFileSync(join(home, 'app', 'node_modules', 'code-server', 'package.json'), 'utf8')).version || null } catch { return null }
}

/**
 * VS Code settings for a first start: Studio's chat is the agent chat, so VS
 * Code's own AI chat panel stays out of the way. Written only when there is no
 * settings file yet; change them in VS Code like any setting.
 */
export const DEFAULT_USER_SETTINGS = {
  'workbench.secondarySideBar.defaultVisibility': 'hidden',
  'chat.disableAIFeatures': true,
  'workbench.startupEditor': 'none',
  'telemetry.telemetryLevel': 'off',
}

export function writeDefaultUserSettings(home: string) {
  const file = join(home, 'data', 'User', 'settings.json')
  if (existsSync(file)) return
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(DEFAULT_USER_SETTINGS, null, 2)}\n`)
}

export function findCodeServer(home = vscodeHome()): Launch | null {
  const fromEnv = process.env.STUDIO_CODE_SERVER?.trim()
  if (fromEnv && existsSync(fromEnv)) return { command: fromEnv, args: [], source: 'env', version: null }
  if (existsSync(installedMarker(home)) && existsSync(installedEntry(home))) return { command: codeServerNode(), args: [installedEntry(home)], source: 'studio', version: installedVersion(home) }
  const found = onPath('code-server')
  if (found) return { command: found, args: [], source: 'path', version: null }
  return null
}

/** The flags Studio always runs code-server with. */
export function codeServerArgs(home: string, socket: string): string[] {
  return [
    '--socket', socket, '--socket-mode', '600',
    '--auth', 'none',
    '--disable-telemetry', '--disable-update-check', '--disable-workspace-trust', '--disable-getting-started-override',
    '--user-data-dir', join(home, 'data'),
    '--extensions-dir', join(home, 'extensions'),
    '--config', join(home, 'config.yaml'),
  ]
}

export class VsCodeManager {
  private child: ChildProcess | null = null
  private starting: Promise<void> | null = null
  private installing: Promise<void> | null = null
  private error: string | null = null
  private log: string[] = []
  private lastUse = Date.now()
  private openTunnels = 0
  private idleTimer: NodeJS.Timeout | null = null

  constructor(private home = vscodeHome()) {}

  get socketPath(): string { return vscodeSocketPath(this.home) }

  private remember(text: string) {
    for (const line of text.split(/\r?\n/)) if (line.trim()) this.log.push(line.slice(0, 400))
    if (this.log.length > LOG_LINES) this.log.splice(0, this.log.length - LOG_LINES)
  }

  /** Why Studio cannot install code-server itself here, if it cannot. */
  installProblem(): string | null {
    const major = nodeMajor(codeServerNode())
    if (major < 24) return `VS Code needs Node 24 (Studio runs on Node ${major || 'unknown'}). Set STUDIO_VSCODE_NODE to a Node 24 binary.`
    return null
  }

  status(): VsCodeStatus {
    const launch = findCodeServer(this.home)
    return {
      available: !!launch && !this.installing,
      source: launch?.source || null,
      version: launch?.version || null,
      running: !!this.child && this.child.exitCode === null,
      installing: !!this.installing,
      problem: launch ? null : this.installProblem(),
      error: this.error,
      log: this.log.slice(-20),
    }
  }

  /** Installs code-server from npm into Studio's data folder (runs in the background). */
  install(): Promise<void> {
    if (this.installing) return this.installing
    const problem = this.installProblem()
    if (problem) return Promise.reject(new Error(problem))
    this.error = null
    const node = codeServerNode()
    const app = join(this.home, 'app')
    mkdirSync(app, { recursive: true })
    rmSync(installedMarker(this.home), { force: true })
    if (!existsSync(join(app, 'package.json'))) writeFileSync(join(app, 'package.json'), '{"private":true}\n')
    this.remember(`Installing code-server ${CODE_SERVER_VERSION} from npm...`)
    this.installing = new Promise<void>((resolve, reject) => {
      const env = { ...process.env, PATH: `${dirname(node)}${delimiter}${process.env.PATH || ''}` }
      const npm = existsSync(join(dirname(node), 'npm')) ? join(dirname(node), 'npm') : 'npm'
      const child = spawn(npm, ['install', '--prefix', app, '--no-audit', '--no-fund', `code-server@${CODE_SERVER_VERSION}`], { env, stdio: ['ignore', 'pipe', 'pipe'] })
      child.stdout?.on('data', chunk => this.remember(String(chunk)))
      child.stderr?.on('data', chunk => this.remember(String(chunk)))
      child.once('error', error => reject(error))
      child.once('close', code => {
        if (code === 0 && existsSync(installedEntry(this.home))) {
          writeFileSync(installedMarker(this.home), `${CODE_SERVER_VERSION}\n`)
          this.remember('code-server installed.')
          resolve()
        }
        else reject(new Error(`npm install failed (exit ${code}); see the log`))
      })
    }).catch((error) => {
      this.error = error.message
      throw error
    }).finally(() => { this.installing = null })
    return this.installing
  }

  /** Starts code-server if it is not running and waits until it answers. */
  ensureRunning(): Promise<void> {
    this.lastUse = Date.now()
    if (this.child && this.child.exitCode === null && !this.starting) return Promise.resolve()
    if (this.starting) return this.starting
    this.starting = this.start().finally(() => { this.starting = null })
    return this.starting
  }

  private async start() {
    const launch = findCodeServer(this.home)
    if (!launch) throw new Error('VS Code is not installed')
    this.error = null
    mkdirSync(join(this.home, 'data'), { recursive: true })
    mkdirSync(join(this.home, 'extensions'), { recursive: true })
    writeDefaultUserSettings(this.home)
    // Keeps code-server from writing ~/.config/code-server/config.yaml.
    writeFileSync(join(this.home, 'config.yaml'), 'bind-addr: 127.0.0.1:0\nauth: none\ncert: false\n')
    try { installStudioExtension(join(this.home, 'extensions')) } catch (error: any) { this.remember(`Studio extension not installed: ${error?.message || error}`) }
    const socket = this.socketPath
    rmSync(socket, { force: true })
    const env: NodeJS.ProcessEnv = { ...process.env }
    // code-server reads these as its own login settings.
    delete env.PASSWORD; delete env.HASHED_PASSWORD
    if (launch.source === 'studio') env.PATH = `${dirname(launch.command)}${delimiter}${env.PATH || ''}`
    this.remember(`Starting VS Code (${launch.source})`)
    const child = spawn(launch.command, [...launch.args, ...codeServerArgs(this.home, socket)], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    this.child = child
    child.stdout?.on('data', chunk => this.remember(String(chunk)))
    child.stderr?.on('data', chunk => this.remember(String(chunk)))
    child.once('exit', (code, signal) => {
      if (this.child === child) this.child = null
      this.remember(`VS Code stopped (${signal || `exit ${code}`})`)
    })
    const deadline = Date.now() + READY_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (child.exitCode !== null) break
      if (await this.answers()) { this.watchIdle(); return }
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    this.error = child.exitCode !== null ? `VS Code exited (code ${child.exitCode}); see the log` : 'VS Code did not start in time'
    child.kill('SIGTERM')
    throw new Error(this.error)
  }

  private answers(): Promise<boolean> {
    return new Promise(resolve => {
      const probe = request({ socketPath: this.socketPath, path: '/healthz', method: 'GET', timeout: 2000 }, (response) => { response.resume(); resolve(true) })
      probe.once('error', () => resolve(false))
      probe.once('timeout', () => { probe.destroy(); resolve(false) })
      probe.end()
    })
  }

  /** Marks VS Code as in use (requests and open connections keep it running). */
  touch() { this.lastUse = Date.now() }
  tunnelOpened() { this.openTunnels += 1; this.touch() }
  tunnelClosed() { this.openTunnels = Math.max(0, this.openTunnels - 1); this.touch() }

  private watchIdle() {
    if (this.idleTimer) return
    const minutes = Number(process.env.STUDIO_VSCODE_IDLE_MINUTES || 30)
    if (!(minutes > 0)) return
    this.idleTimer = setInterval(() => {
      if (!this.child) return
      if (this.openTunnels === 0 && Date.now() - this.lastUse > minutes * 60_000) {
        this.remember('Stopping VS Code: not used for a while')
        this.stop()
      }
    }, 60_000)
    this.idleTimer.unref()
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
