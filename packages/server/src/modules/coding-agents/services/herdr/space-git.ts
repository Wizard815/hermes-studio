import { execFile } from 'node:child_process'
import { basename } from 'node:path'

/**
 * A space's repo, branch and ahead/behind for Studio's Spaces sidebar (as
 * herdr's spaces list and Space Folders show them, only when unusual). Asked
 * of git in the space's folder, at most a few at a time, and remembered a
 * little while: a sidebar of hundreds of chats shares a handful of repos.
 */
export interface SpaceGit {
  /** The repo's name (its main checkout's folder). */
  repo: string
  /** Branch, or null when detached. */
  branch: string | null
  ahead: number
  behind: number
  /** A linked worktree (not the main checkout). */
  linked: boolean
}

function git(cwd: string, args: string[], timeout = 4000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    execFile('git', args, { cwd, timeout, maxBuffer: 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof (error as any).code === 'number' ? (error as any).code : 1) : 0, stdout: String(stdout), stderr: String(stderr) })
    })
  })
}

/** Parse `git status --porcelain=v2 --branch` headers. */
export function parseBranchHeaders(stdout: string): { branch: string | null; ahead: number; behind: number } {
  let branch: string | null = null
  let ahead = 0
  let behind = 0
  for (const line of stdout.split('\n')) {
    if (line.startsWith('# branch.head ')) {
      const head = line.slice(14).trim()
      branch = head === '(detached)' ? null : head
    } else if (line.startsWith('# branch.ab ')) {
      const [a, b] = line.slice(12).split(' ')
      ahead = Math.abs(parseInt(a, 10)) || 0
      behind = Math.abs(parseInt(b, 10)) || 0
    }
  }
  return { branch, ahead, behind }
}

/** The repo's name from its common git dir: `/x/herdr/.git` → herdr, `/x/herdr.git` → herdr. */
export function repoName(commonDir: string): string {
  const dir = commonDir.trim().replace(/\/+$/, '')
  return dir.endsWith('/.git') ? basename(dir.slice(0, -5)) : basename(dir).replace(/\.git$/, '')
}

export async function readSpaceGit(cwd: string): Promise<SpaceGit | null> {
  const status = await git(cwd, ['--no-optional-locks', '-c', 'core.fsmonitor=false', 'status', '--porcelain=v2', '--branch', '--untracked-files=no', '--ignore-submodules'])
  if (status.code !== 0) return null
  const where = await git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir', '--show-toplevel'])
  if (where.code !== 0) return null
  const [common = '', top = ''] = where.stdout.trim().split('\n')
  return { repo: repoName(common), ...parseBranchHeaders(status.stdout), linked: common.trim() !== `${top.trim()}/.git` }
}

export class SpaceGitCache {
  private cache = new Map<string, { at: number; value: SpaceGit | null }>()
  private running = new Map<string, Promise<SpaceGit | null>>()

  constructor(private readonly ttlMs = 30_000, private readonly read: (cwd: string) => Promise<SpaceGit | null> = readSpaceGit, private readonly parallel = 6) {}

  /** Each folder's git (null: not a repo), at most `limit` folders. */
  async lookup(cwds: string[], limit = 300): Promise<Record<string, SpaceGit | null>> {
    const unique = [...new Set(cwds.filter(cwd => typeof cwd === 'string' && cwd.startsWith('/')))].slice(0, limit)
    const out: Record<string, SpaceGit | null> = {}
    const due: string[] = []
    const now = Date.now()
    for (const cwd of unique) {
      const hit = this.cache.get(cwd)
      if (hit && now - hit.at < this.ttlMs) out[cwd] = hit.value
      else due.push(cwd)
    }
    let next = 0
    const worker = async () => {
      while (next < due.length) {
        const cwd = due[next++]
        out[cwd] = await this.one(cwd)
      }
    }
    await Promise.all(Array.from({ length: Math.min(this.parallel, due.length) }, worker))
    if (this.cache.size > 2000) this.cache.clear()
    return out
  }

  private one(cwd: string): Promise<SpaceGit | null> {
    const running = this.running.get(cwd)
    if (running) return running
    const work = this.read(cwd).catch(() => null).then(value => {
      this.cache.set(cwd, { at: Date.now(), value })
      this.running.delete(cwd)
      return value
    })
    this.running.set(cwd, work)
    return work
  }
}
