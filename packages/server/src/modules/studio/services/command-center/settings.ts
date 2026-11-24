import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * Command Center settings (the herdr page's Tools dock). GitHub: whether the
 * Inbox asks `gh` for failed CI and review requests, and which repositories
 * it watches ([] = every repository of the signed-in account).
 */
export interface CommandCenterSettings {
  github: { enabled: boolean; repos: string[] }
}

export const DEFAULT_SETTINGS: CommandCenterSettings = { github: { enabled: true, repos: [] } }

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const MAX_REPOS = 20

export function normalizeRepos(value: unknown): string[] {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[\s,]+/) : []
  const out: string[] = []
  for (const item of list) {
    const repo = String(item || '').trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/, '').replace(/\/$/, '')
    if (REPO.test(repo) && !out.includes(repo)) out.push(repo)
  }
  return out.slice(0, MAX_REPOS)
}

export function normalizeSettings(raw: any): CommandCenterSettings {
  const github = raw && typeof raw === 'object' ? raw.github || {} : {}
  return {
    github: {
      enabled: typeof github.enabled === 'boolean' ? github.enabled : DEFAULT_SETTINGS.github.enabled,
      repos: normalizeRepos(github.repos),
    },
  }
}

export class CommandCenterSettingsFile {
  constructor(private readonly path: string) {}

  async load(): Promise<CommandCenterSettings> {
    try { return normalizeSettings(JSON.parse(await readFile(this.path, 'utf8'))) } catch { return normalizeSettings({}) }
  }

  async save(change: { github?: { enabled?: unknown; repos?: unknown } }): Promise<CommandCenterSettings> {
    const current = await this.load()
    const next = normalizeSettings({
      github: {
        enabled: typeof change.github?.enabled === 'boolean' ? change.github.enabled : current.github.enabled,
        repos: change.github?.repos !== undefined ? change.github.repos : current.github.repos,
      },
    })
    await mkdir(dirname(this.path), { recursive: true })
    const temp = `${this.path}.${process.pid}.tmp`
    await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
    await rename(temp, this.path)
    return next
  }
}
