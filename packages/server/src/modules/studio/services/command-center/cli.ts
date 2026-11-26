import { execFile } from 'node:child_process'

/** One finished command. `missing`: the program is not on the server's PATH. */
export interface CliResult {
  code: number
  stdout: string
  stderr: string
  missing?: boolean
}

export interface CliOptions {
  timeoutMs?: number
  cwd?: string
  env?: Record<string, string | undefined>
}

/** Runs a program with an argument array (never a shell string). */
export type CliRunner = (bin: string, args: string[], options?: CliOptions) => Promise<CliResult>

const MAX_OUTPUT = 8 * 1024 * 1024

export const runCli: CliRunner = (bin, args, options = {}) => new Promise(resolve => {
  execFile(bin, args, {
    timeout: options.timeoutMs ?? 20_000,
    maxBuffer: MAX_OUTPUT,
    cwd: options.cwd,
    env: { ...process.env, ...options.env, NO_COLOR: '1' },
    windowsHide: true,
  }, (error, stdout, stderr) => {
    const err = error as (NodeJS.ErrnoException & { code?: number | string }) | null
    if (err && err.code === 'ENOENT') {
      resolve({ code: 127, stdout: '', stderr: `${bin} not found`, missing: true })
      return
    }
    const code = !err ? 0 : typeof err.code === 'number' ? err.code : 1
    resolve({ code, stdout: String(stdout || ''), stderr: String(stderr || (err && !stdout ? err.message : '') || '') })
  })
})

export function parseJson<T = any>(text: string): T | null {
  try { return JSON.parse(text) as T } catch { return null }
}

/** The last useful line of a command's output, for a message. */
export function lastLine(text: string): string {
  return String(text || '').replace(/\x1b\[[0-9;]*m/g, '').split('\n').map(line => line.trim()).filter(Boolean).pop() || ''
}

/** What went wrong: an `{ "error": … }` body, else the last line of stderr or stdout. */
export function failure(result: CliResult, what: string): string {
  const body = parseJson<{ error?: string }>(result.stdout)
  return body?.error || lastLine(result.stderr) || lastLine(result.stdout) || `${what} exited with ${result.code}`
}
