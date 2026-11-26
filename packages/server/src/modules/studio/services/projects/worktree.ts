import { execFile } from 'node:child_process'
import { mkdir, readdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { promisify } from 'node:util'

/**
 * Git worktrees for project threads: each thread gets its own checkout and
 * branch of the project's repo, so threads working at once don't edit or
 * commit each other's files (docs/projects.md).
 */
const run = promisify(execFile)

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run('git', ['-C', cwd, ...args], { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 })
  return stdout.trim()
}

/** The repo a folder is in, or null when it is not a git repo (or git is missing). */
export async function repoRoot(folder: string): Promise<string | null> {
  if (!folder) return null
  try { return await git(folder, 'rev-parse', '--show-toplevel') || null } catch { return null }
}

/** A branch name for a thread: `studio/<title words>-<thread id>`. */
export function threadBranch(title: string, threadId: string): string {
  const words = title.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '')
  return `studio/${words ? `${words}-` : ''}${threadId}`
}

/** A new worktree at `path` on a new branch from the repo's current HEAD. */
export async function addWorktree(repo: string, path: string, branch: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await git(repo, 'worktree', 'add', '-b', branch, path, 'HEAD')
}

/**
 * Remove a thread's worktree when it has no uncommitted changes. Its branch
 * (and the commits on it) stays. A worktree with changes is left in place.
 */
export async function removeWorktree(repo: string, path: string): Promise<{ removed: boolean; reason?: string }> {
  try {
    await git(repo, 'worktree', 'remove', path)
    return { removed: true }
  } catch (error: any) {
    return { removed: false, reason: String(error?.stderr || error?.message || error).trim().split('\n')[0] }
  }
}

/**
 * A git URL a project may clone: https://, ssh:// or git@host:path. Local paths,
 * file:// and anything that looks like an option are refused.
 */
export function repoUrl(value: unknown): string {
  const url = String(value ?? '').trim()
  if (!url || url.length > 500 || /\s/.test(url) || url.startsWith('-')) return ''
  if (/^https:\/\/[^/\s]+\/.+/i.test(url) || /^ssh:\/\/[^/\s]+\/.+/i.test(url)) return url
  if (/^[\w.-]+@[\w.-]+:[\w./~-]+$/.test(url)) return url
  return ''
}

/** A folder name for a clone: the repo's name. */
export function repoFolderName(url: string): string {
  const last = url.replace(/\.git$/i, '').split(/[/:]/).filter(Boolean).at(-1) || 'repo'
  return last.replace(/[^\w.-]+/g, '-').replace(/^[.-]+/, '').slice(0, 80) || 'repo'
}

/** Clone `url` into `dest`, which must not exist or be empty. */
export async function cloneRepo(url: string, dest: string): Promise<void> {
  const entries = await readdir(dest).catch(() => null)
  if (entries && entries.length) throw Object.assign(new Error(`${dest} is not empty. Pick an empty or new folder for the clone.`), { status: 409 })
  await mkdir(dirname(dest), { recursive: true })
  try {
    await run('git', ['clone', '--', url, dest], { timeout: 10 * 60_000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
  } catch (error: any) {
    const reason = String(error?.stderr || error?.message || error).trim().split('\n').filter(Boolean).at(-1) || 'git clone failed'
    throw Object.assign(new Error(`Could not clone ${url}: ${reason}`), { status: 422 })
  }
}
