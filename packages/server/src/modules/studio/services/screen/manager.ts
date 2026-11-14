import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { findHermesCli } from '../../../hermes/services/herdr-launch'
import { getWebUiHome } from '../../public/config'

/**
 * The agents' screen: Hermes's Bot Screen (an Xvnc + Xfce desktop with a real
 * browser, one per Hermes profile). Studio starts, stops and installs it with
 * Hermes's own commands and leaves its rules to Hermes: who drives the screen
 * is Hermes's lease, shared with the agent's computer_use and browser tools.
 */
export interface ScreenLease {
  holder: 'agent' | 'human'
  reason: string
  since: number
  epoch: number
  /** Short hash of the holder's viewer id (compare with your own to know you hold it). */
  viewer_hash: string | null
}

export interface HermesScreenStatus {
  supported: boolean
  installed: boolean
  running: boolean
  missing: string[]
  install_command: string | null
  blocker: string | null
  display: string | null
  geometry: string | null
  socket: string | null
  browser: string | null
  memory_available_mb: number | null
  lease: ScreenLease
}

export interface ScreenStatus extends Partial<HermesScreenStatus> {
  /** Hermes (with Bot Screen) is present. */
  available: boolean
  installing: boolean
  starting: boolean
  error: string | null
  log: string[]
}

const COMMAND_TIMEOUT_MS = 180_000
const LOG_LINES = 60

export function hermesHome(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.HERMES_HOME || join(homedir(), '.hermes'))
}

/** The short hash Hermes shows instead of the holder's viewer id. */
export function viewerHash(viewerId: string): string {
  return createHash('sha256').update(viewerId).digest('hex').slice(0, 12)
}

/** Hermes's Python (the one that can import its tools). */
export function hermesPython(cli: string | null, env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.HERMES_PYTHON && existsSync(env.HERMES_PYTHON)) return env.HERMES_PYTHON
  if (cli) {
    const sibling = join(dirname(cli), 'python')
    if (existsSync(sibling)) return sibling
  }
  for (const candidate of ['/opt/hermes/.venv/bin/python']) if (existsSync(candidate)) return candidate
  return null
}

/** Studio's helper script (bin/bot-screen-bridge.py), in the source tree or the build. */
export function bridgeScript(): string {
  const candidates = [
    resolve(__dirname, '..', '..', '..', '..', '..', '..', '..', 'bin', 'bot-screen-bridge.py'),
    resolve(__dirname, '..', 'bin', 'bot-screen-bridge.py'),
    resolve(__dirname, '..', '..', 'bin', 'bot-screen-bridge.py'),
    resolve(process.cwd(), 'bin', 'bot-screen-bridge.py'),
  ]
  return candidates.find(path => existsSync(path)) || candidates[candidates.length - 1]
}

interface RunResult { code: number | null; stdout: string; stderr: string }

export class ScreenManager {
  private installing: Promise<void> | null = null
  private starting: Promise<void> | null = null
  private error: string | null = null
  private log: string[] = []

  constructor(private readonly stateFile = join(getWebUiHome(), 'screen', 'state.json')) {}

  get home(): string { return hermesHome() }
  get cli(): string | null { return findHermesCli() }
  get python(): string | null { return hermesPython(this.cli) }

  private remember(text: string) {
    for (const line of text.split(/\r?\n/)) if (line.trim() && !line.includes('install out of sync')) this.log.push(line.slice(0, 300))
    if (this.log.length > LOG_LINES) this.log.splice(0, this.log.length - LOG_LINES)
  }

  private env(): NodeJS.ProcessEnv {
    // Run Hermes as this user (Studio's image runs as root; the image's shim would
    // otherwise switch to another user whose files Studio could not reach).
    return { ...process.env, HERMES_HOME: this.home, STUDIO_SCREEN_HOME: this.home, HERMES_DOCKER_EXEC_AS_ROOT: '1' }
  }

  run(command: string, args: string[], timeoutMs = COMMAND_TIMEOUT_MS, onOutput?: (text: string) => void): Promise<RunResult> {
    return new Promise((resolvePromise) => {
      const child = spawn(command, args, { env: this.env(), stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs)
      child.stdout?.on('data', (chunk) => { stdout += chunk; onOutput?.(String(chunk)) })
      child.stderr?.on('data', (chunk) => { stderr += chunk; onOutput?.(String(chunk)) })
      child.once('error', (error) => { clearTimeout(timer); resolvePromise({ code: -1, stdout, stderr: `${stderr}${error.message}` }) })
      child.once('close', (code) => { clearTimeout(timer); resolvePromise({ code, stdout, stderr }) })
    })
  }

  private hermes(args: string[], timeoutMs?: number, onOutput?: (text: string) => void): Promise<RunResult> {
    const cli = this.cli
    if (!cli) return Promise.resolve({ code: -1, stdout: '', stderr: 'Hermes is not installed' })
    return this.run(cli, ['computer-use', 'screen', ...args], timeoutMs, onOutput)
  }

  async hermesStatus(): Promise<HermesScreenStatus | null> {
    const result = await this.hermes(['status', '--json'], 30_000)
    const start = result.stdout.indexOf('{')
    if (start < 0) return null
    try { return JSON.parse(result.stdout.slice(start)) as HermesScreenStatus } catch { return null }
  }

  async status(): Promise<ScreenStatus> {
    const base = { installing: !!this.installing, starting: !!this.starting, error: this.error, log: this.log.slice(-20) }
    if (!this.cli) return { ...base, available: false, error: 'Hermes is not installed here' }
    const hermes = await this.hermesStatus()
    if (!hermes) return { ...base, available: false, error: this.error || 'This Hermes has no Bot Screen (update Hermes)' }
    return { ...base, ...hermes, available: true }
  }

  private wasInstalled(): boolean {
    try { return JSON.parse(readFileSync(this.stateFile, 'utf8')).installed === true } catch { return false }
  }

  private markInstalled() {
    try {
      mkdirSync(dirname(this.stateFile), { recursive: true })
      writeFileSync(this.stateFile, `${JSON.stringify({ installed: true, at: Date.now() })}\n`)
    } catch { /* best effort */ }
  }

  /**
   * Installs the desktop packages (TigerVNC, Xfce) with the system package
   * manager. Needs root, as in Studio's image. Hermes's installer does not
   * refresh apt's package lists, so Studio does that first.
   */
  install(): Promise<void> {
    if (this.installing) return this.installing
    this.error = null
    this.remember('Installing the screen (TigerVNC + Xfce)...')
    const work = async () => {
      if (existsSync('/usr/bin/apt-get')) {
        const update = await this.run('apt-get', ['update', '-qq'], 600_000, text => this.remember(text))
        if (update.code !== 0) throw new Error('apt-get update failed; see the log')
      }
      const result = await this.hermes(['install', '-y'], 900_000, text => this.remember(text))
      if (result.code !== 0) throw new Error(`Install failed (exit ${result.code}); see the log`)
      this.markInstalled()
      this.remember('Screen installed.')
    }
    this.installing = work()
      .catch((error) => { this.error = error instanceof Error ? error.message : String(error); throw error })
      .finally(() => { this.installing = null })
    return this.installing
  }

  /** After the container was recreated (an image update), put back a screen that was installed. */
  async restoreAfterRebuild(): Promise<void> {
    if (!this.wasInstalled() || !this.cli) return
    const status = await this.hermesStatus()
    if (status && !status.installed && status.supported) {
      this.remember('The screen was installed before this container was rebuilt; installing it again.')
      await this.install().catch(() => undefined)
    }
  }

  start(): Promise<void> {
    if (this.starting) return this.starting
    this.error = null
    this.starting = this.hermes(['start'], COMMAND_TIMEOUT_MS, text => this.remember(text))
      .then(async (result) => {
        const status = await this.hermesStatus()
        if (!status?.running) throw new Error(this.lastLine(result) || 'The screen did not start')
      })
      .catch((error) => { this.error = error instanceof Error ? error.message : String(error); throw error })
      .finally(() => { this.starting = null })
    return this.starting
  }

  async stop(force = false): Promise<void> {
    const result = await this.hermes(force ? ['stop', '--force'] : ['stop'], 60_000, text => this.remember(text))
    if (result.code !== 0) throw Object.assign(new Error(this.lastLine(result) || 'The screen did not stop'), { status: 409 })
  }

  private lastLine(result: RunResult): string {
    return `${result.stderr}\n${result.stdout}`.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.includes('out of sync')).pop() || ''
  }

  /**
   * The DevTools port of the screen's browser (Hermes's own Chrome, started on the
   * screen if needed). Fails with `exitCode` 42 while a person holds control and 41
   * when the screen is not running.
   */
  async browserPort(): Promise<{ port: number; profile: string }> {
    const python = this.python
    if (!python) throw Object.assign(new Error('Hermes is not installed here'), { exitCode: -1 })
    const result = await this.run(python, [bridgeScript(), 'browser'], 60_000)
    const line = result.stdout.trim().split(/\r?\n/).pop() || ''
    let parsed: { port?: unknown; profile?: unknown; error?: unknown } = {}
    try { parsed = JSON.parse(line) } catch { /* reported below */ }
    if (result.code === 0 && typeof parsed.port === 'number' && Number.isInteger(parsed.port) && parsed.port > 0) {
      return { port: parsed.port, profile: String(parsed.profile || '') }
    }
    const message = typeof parsed.error === 'string' && parsed.error
      ? parsed.error
      : result.stderr.trim().split(/\r?\n/).pop() || `The screen's browser is unavailable (exit ${result.code})`
    throw Object.assign(new Error(message), { exitCode: result.code })
  }

  /** Take control, hand it back, or clear a stuck hold, as Hermes's lease. */
  async lease(action: 'get' | 'take' | 'release' | 'force', viewerId = '', reason = ''): Promise<ScreenLease> {
    const python = this.python
    if (!python) throw Object.assign(new Error('Hermes is not installed here'), { status: 503 })
    const result = await this.run(python, [bridgeScript(), 'lease', action, viewerId, reason], 30_000)
    const line = result.stdout.trim().split(/\r?\n/).pop() || ''
    try {
      const lease = JSON.parse(line)
      if (lease.error) throw new Error(lease.error)
      return lease as ScreenLease
    } catch (error) {
      throw Object.assign(new Error(result.stderr.trim().split(/\r?\n/).pop() || (error as Error).message), { status: 502 })
    }
  }
}
