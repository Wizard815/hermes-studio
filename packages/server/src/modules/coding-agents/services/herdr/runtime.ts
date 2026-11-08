import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'

export interface HerdrSettings {
  /** Master switch. Turned on automatically the first time Studio finds herdr. */
  enabled: boolean
  /** Start a background herdr server when Studio starts (agents outlive Studio). */
  autoStart: boolean
  /** herdr version whose one-time setup (integrations, plugin, keybinding) has run. */
  setupVersion: string
  /** Studio's setup revision that ran (new setup steps run once on existing installs). */
  setupRevision: number
  /** Explicit herdr binary; empty means search PATH and common install dirs. */
  binaryPath: string
  /** Named herdr session; empty means herdr's default session. */
  session: string
  /** Create Studio chats for agents started directly in herdr. */
  autoImport: boolean
  /** Mirror agent transcripts into linked Studio chats. */
  mirrorTranscripts: boolean
  /** Studio profile used for chats created from herdr. */
  profile: string
}

export const DEFAULT_HERDR_SETTINGS: HerdrSettings = {
  enabled: false,
  autoStart: true,
  setupVersion: '',
  setupRevision: 0,
  binaryPath: '',
  session: '',
  autoImport: true,
  mirrorTranscripts: true,
  profile: 'default',
}

const SESSION_NAME = /^[A-Za-z0-9_.-]{0,64}$/

export function sanitizeHerdrSettings(input: Partial<HerdrSettings> | null | undefined, base = DEFAULT_HERDR_SETTINGS): HerdrSettings {
  const next = { ...base }
  if (!input || typeof input !== 'object') return next
  if (typeof input.enabled === 'boolean') next.enabled = input.enabled
  if (typeof input.autoImport === 'boolean') next.autoImport = input.autoImport
  if (typeof input.mirrorTranscripts === 'boolean') next.mirrorTranscripts = input.mirrorTranscripts
  if (typeof input.autoStart === 'boolean') next.autoStart = input.autoStart
  if (typeof input.setupVersion === 'string') next.setupVersion = input.setupVersion.slice(0, 32)
  if (typeof input.setupRevision === 'number' && Number.isInteger(input.setupRevision) && input.setupRevision >= 0) next.setupRevision = input.setupRevision
  if (typeof input.binaryPath === 'string') next.binaryPath = input.binaryPath.trim().slice(0, 1024)
  if (typeof input.session === 'string') {
    const session = input.session.trim()
    if (!SESSION_NAME.test(session)) throw Object.assign(new Error('Invalid herdr session name'), { status: 400 })
    next.session = session
  }
  if (typeof input.profile === 'string' && input.profile.trim()) next.profile = input.profile.trim().slice(0, 128)
  return next
}

export class HerdrSettingsStore {
  constructor(private readonly file: string) {}

  exists(): boolean {
    return existsSync(this.file)
  }

  async load(): Promise<HerdrSettings> {
    try {
      return sanitizeHerdrSettings(JSON.parse(await readFile(this.file, 'utf8')))
    } catch {
      return { ...DEFAULT_HERDR_SETTINGS }
    }
  }

  async save(settings: HerdrSettings): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true })
    const temp = `${this.file}.${process.pid}.tmp`
    await writeFile(temp, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 })
    await rename(temp, this.file)
  }
}

const BINARY = process.platform === 'win32' ? 'herdr.exe' : 'herdr'

/** Resolve the herdr binary without invoking a shell. */
export function locateHerdrBinary(settings: Pick<HerdrSettings, 'binaryPath'>, env: NodeJS.ProcessEnv = process.env, managedDir = ''): string | null {
  const explicit = settings.binaryPath || env.HERDR_BIN_PATH || ''
  if (explicit) return existsSync(explicit) ? explicit : null
  const home = homedir()
  const candidates = [
    // A copy Studio installed wins over PATH so Studio controls its version.
    ...(managedDir ? [join(managedDir, BINARY)] : []),
    ...String(env.PATH || '').split(delimiter).filter(Boolean).map(dir => join(dir, BINARY)),
    join(home, '.local', 'bin', BINARY),
    join(home, '.cargo', 'bin', BINARY),
    '/opt/homebrew/bin/herdr',
    '/usr/local/bin/herdr',
  ]
  return candidates.find(candidate => existsSync(candidate)) ?? null
}

export function herdrArgs(settings: Pick<HerdrSettings, 'session'>, args: string[]): string[] {
  return settings.session ? ['--session', settings.session, ...args] : args
}

export interface HerdrServerStatus {
  version: string
  running: boolean
  socket: string
  session: string
  compatible: boolean
}

export function runHerdr(binary: string, args: string[], timeoutMs = 8000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(binary, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, env: process.env }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(new Error(String(stderr || error.message).trim() || 'herdr failed'), { stdout }))
      else resolve(String(stdout))
    })
  })
}

export async function readHerdrServerStatus(binary: string, settings: Pick<HerdrSettings, 'session'>): Promise<HerdrServerStatus> {
  const raw = JSON.parse(await runHerdr(binary, herdrArgs(settings, ['status', '--json'])))
  const server = raw?.server ?? {}
  return {
    version: String(server.version || raw?.client?.version || ''),
    running: server.running === true,
    socket: String(server.socket || ''),
    session: String(server.session || raw?.client?.session || settings.session || 'default'),
    compatible: server.compatible !== false,
  }
}

/**
 * Start a detached headless herdr server; panes outlive Studio. If it exits
 * during the first seconds, `onEarlyExit` receives its error output so the
 * failure is shown instead of a bare "not running".
 */
export function startHerdrServer(binary: string, settings: Pick<HerdrSettings, 'session'>, onEarlyExit?: (message: string) => void): void {
  const child = spawn(binary, herdrArgs(settings, ['server']), { detached: true, stdio: ['ignore', 'ignore', 'pipe'], env: process.env })
  let stderr = ''
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-2000) })
  const watch = setTimeout(() => {
    // Healthy: stop listening so Studio holds no handle on the server.
    child.stderr?.destroy()
    child.removeAllListeners('exit')
    child.unref()
  }, 5000)
  watch.unref()
  child.once('exit', code => {
    clearTimeout(watch)
    if (code !== 0 || stderr.trim()) onEarlyExit?.(stderr.trim() || `herdr server exited with code ${code}`)
  })
  child.once('error', error => onEarlyExit?.(error.message))
  child.unref()
}
