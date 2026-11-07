import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

/** Where the Android SDK and adb come from. Empty strings mean "find it". */
export interface AndroidToolPaths {
  adbPath: string
  sdkPath: string
}

export interface AdbResult {
  stdout: Buffer
  stderr: string
}

const exe = (name: string) => (process.platform === 'win32' ? `${name}.exe` : name)

/** SDK roots to look in, in order: the setting, the standard variables, then the usual install places. */
export function sdkCandidates(paths: AndroidToolPaths, env: NodeJS.ProcessEnv = process.env, home = homedir()): string[] {
  const roots = [
    paths.sdkPath,
    env.ANDROID_HOME,
    env.ANDROID_SDK_ROOT,
    join(home, 'Android', 'Sdk'),
    join(home, 'Library', 'Android', 'sdk'),
    env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'Android', 'Sdk') : '',
    '/opt/android-sdk',
  ]
  return [...new Set(roots.map(root => root?.trim() || '').filter(Boolean))]
}

function onPath(name: string, env: NodeJS.ProcessEnv): string | null {
  for (const dir of (env.PATH || '').split(delimiter)) {
    if (!dir) continue
    const candidate = join(dir, exe(name))
    if (existsSync(candidate)) return candidate
  }
  return null
}

/** The adb binary: an explicit path, an SDK's platform-tools, or adb on PATH (Debian's `adb` package). */
export function resolveAdb(paths: AndroidToolPaths, env: NodeJS.ProcessEnv = process.env): string | null {
  if (paths.adbPath.trim()) return existsSync(paths.adbPath.trim()) ? paths.adbPath.trim() : null
  for (const root of sdkCandidates(paths, env)) {
    const candidate = join(root, 'platform-tools', exe('adb'))
    if (existsSync(candidate)) return candidate
  }
  return onPath('adb', env)
}

/** The emulator binary from an SDK, or on PATH. Null where only adb is installed (Docker, Unraid). */
export function resolveEmulator(paths: AndroidToolPaths, env: NodeJS.ProcessEnv = process.env): string | null {
  for (const root of sdkCandidates(paths, env)) {
    const candidate = join(root, 'emulator', exe('emulator'))
    if (existsSync(candidate)) return candidate
  }
  return onPath('emulator', env)
}

export class AdbError extends Error {
  status = 502
  constructor(message: string) { super(message) }
}

/** Runs a binary with an argument array (never a shell string) and resolves with raw stdout. */
export function run(binary: string, args: string[], options: { timeoutMs?: number; maxBuffer?: number } = {}): Promise<AdbResult> {
  return new Promise((resolve, reject) => {
    execFile(binary, args, {
      encoding: 'buffer',
      timeout: options.timeoutMs ?? 15_000,
      maxBuffer: options.maxBuffer ?? 32 * 1024 * 1024,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      const err = stderr.toString('utf8').trim()
      if (error) {
        const message = err || stdout.toString('utf8').trim() || error.message
        reject(new AdbError(message.split('\n').slice(-3).join(' ').slice(0, 500)))
        return
      }
      resolve({ stdout, stderr: err })
    })
  })
}

/** A serial adb prints: emulator-5554, a USB serial, or host:port for network devices. */
export const SERIAL = /^[A-Za-z0-9[][A-Za-z0-9._:\-[\]]{0,127}$/

export function assertSerial(serial: string): string {
  if (!SERIAL.test(serial)) throw Object.assign(new Error('Invalid device serial'), { status: 400 })
  return serial
}

/** host:port for `adb connect` / `adb pair`. Hostnames, IPv4 and bracketed IPv6; never something adb reads as a flag. */
export function parseEndpoint(raw: string, defaultPort?: number): string {
  const value = raw.trim()
  const match = /^(\[[0-9a-fA-F:]+\]|[A-Za-z0-9][A-Za-z0-9.-]{0,252})(?::(\d{1,5}))?$/.exec(value)
  const port = match?.[2] ? Number(match[2]) : defaultPort
  if (!match || !port || port < 1 || port > 65535) {
    throw Object.assign(new Error('Enter a host and port, for example 192.168.1.20:5555'), { status: 400 })
  }
  return `${match[1]}:${port}`
}
