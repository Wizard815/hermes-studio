import { execFile } from 'node:child_process'
import { isAbsolute, normalize } from 'node:path'

/**
 * The Changes panel of Studio's Herdr App layout (Herdr App's `changes`
 * panel): the uncommitted changes of the repo a pane works in, and one
 * file's diff. Read-only git (`status`, `diff`), in a folder a herdr pane
 * works in (the controller checks that), never a path from the page alone.
 */
export interface SpaceChange {
  path: string
  /** Porcelain v1 letters, e.g. "M", "A", "D", "R", "??". */
  status: string
  added: number
  removed: number
}

export interface SpaceChanges {
  root: string
  branch: string | null
  changes: SpaceChange[]
}

function git(cwd: string, args: string[], timeout = 6000): Promise<{ code: number; stdout: string }> {
  return new Promise(resolve => {
    execFile('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.quotepath=false', ...args], {
      cwd, timeout, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    }, (error, stdout) => {
      resolve({ code: error ? (typeof (error as any).code === 'number' ? (error as any).code : 1) : 0, stdout: String(stdout) })
    })
  })
}

/** `git status --porcelain=v1 -z` → path and status letters (renames: the new path). */
export function parsePorcelain(stdout: string): Array<{ path: string; status: string }> {
  const parts = stdout.split('\0')
  const out: Array<{ path: string; status: string }> = []
  for (let i = 0; i < parts.length; i += 1) {
    const entry = parts[i]
    if (entry.length < 4) continue
    const xy = entry.slice(0, 2)
    const path = entry.slice(3)
    if (xy[0] === 'R' || xy[0] === 'C') i += 1 // the old path follows
    const status = xy === '??' ? '??' : (xy.replace(/ /g, '')[0] || 'M')
    out.push({ path, status })
  }
  return out
}

/** `git diff --numstat` → path → added/removed ("-" for binary is 0). */
export function parseNumstat(stdout: string): Map<string, { added: number; removed: number }> {
  const out = new Map<string, { added: number; removed: number }>()
  for (const line of stdout.split('\n')) {
    const match = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line)
    if (!match) continue
    let path = match[3]
    // Renames: "old => new" or "dir/{old => new}/file".
    const brace = /^(.*)\{.* => (.*)\}(.*)$/.exec(path)
    if (brace) path = `${brace[1]}${brace[2]}${brace[3]}`.replace(/\/\//g, '/')
    else if (path.includes(' => ')) path = path.split(' => ').pop() || path
    out.set(path, { added: match[1] === '-' ? 0 : Number(match[1]), removed: match[2] === '-' ? 0 : Number(match[2]) })
  }
  return out
}

export async function readSpaceChanges(cwd: string, limit = 400): Promise<SpaceChanges | null> {
  const top = await git(cwd, ['rev-parse', '--show-toplevel'])
  if (top.code !== 0) return null
  const root = top.stdout.trim()
  const [status, numstat, head] = await Promise.all([
    git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
    git(root, ['diff', 'HEAD', '--numstat', '-M']),
    git(root, ['rev-parse', '--abbrev-ref', 'HEAD']),
  ])
  if (status.code !== 0) return null
  const counts = numstat.code === 0 ? parseNumstat(numstat.stdout) : new Map()
  const changes = parsePorcelain(status.stdout).slice(0, limit).map(entry => ({
    ...entry,
    added: counts.get(entry.path)?.added ?? 0,
    removed: counts.get(entry.path)?.removed ?? 0,
  }))
  const branch = head.code === 0 ? head.stdout.trim() : ''
  return { root, branch: branch && branch !== 'HEAD' ? branch : null, changes }
}

/** A repo-relative path that stays inside the repo. */
export function safeRepoPath(path: string): string | null {
  if (typeof path !== 'string' || !path || path.length > 1024 || path.includes('\0') || isAbsolute(path)) return null
  const clean = normalize(path)
  if (clean === '..' || clean.startsWith('../') || clean.startsWith('..\\')) return null
  return clean
}

/** One file's diff against HEAD (an untracked file: its content as added lines). */
export async function readSpaceDiff(cwd: string, path: string, maxBytes = 400_000): Promise<{ root: string; path: string; diff: string; truncated: boolean } | null> {
  const file = safeRepoPath(path)
  if (!file) return null
  const top = await git(cwd, ['rev-parse', '--show-toplevel'])
  if (top.code !== 0) return null
  const root = top.stdout.trim()
  let diff = (await git(root, ['diff', 'HEAD', '-M', '--', file])).stdout
  if (!diff.trim()) {
    const tracked = await git(root, ['ls-files', '--error-unmatch', '--', file])
    if (tracked.code !== 0) diff = (await git(root, ['diff', '--no-index', '--', '/dev/null', file])).stdout
  }
  const truncated = diff.length > maxBytes
  return { root, path: file, diff: truncated ? diff.slice(0, maxBytes) : diff, truncated }
}
