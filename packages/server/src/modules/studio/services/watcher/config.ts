import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'
import {
  DEFAULT_WATCHER_SETTINGS, sanitizeWatcherSettings,
  type TrustKind, type TrustRule, type TrustScope, type WatcherSettings,
} from '../../../../../../shared/watcher'

export class WatcherInputError extends Error {
  constructor(message: string, readonly status = 400) { super(message) }
}

const KINDS: TrustKind[] = ['command', 'write', 'tool']
const SCOPES: TrustScope[] = ['chat', 'task', 'agent', 'folder']

/** A rule as typed in Settings or "Trust this"; throws WatcherInputError with plain words. */
export function sanitizeTrustRule(raw: unknown, now: number, by = ''): TrustRule {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const kind = String(input.kind || '') as TrustKind
  const scope = String(input.scope || '') as TrustScope
  if (!KINDS.includes(kind)) throw new WatcherInputError('Pick what to trust: a command, a file write or a tool')
  if (!SCOPES.includes(scope)) throw new WatcherInputError('Pick where to trust it: a chat, a task, an agent or a folder')
  const target = String(input.target ?? '').trim().slice(0, 1000)
  if (!target) throw new WatcherInputError(`Say which ${scope} the rule is for`)
  if (scope === 'folder' && !isAbsolute(target)) throw new WatcherInputError('The folder must be a full path, like /srv/projects/app')
  const pattern = String(input.pattern ?? '').trim().slice(0, 2000)
  if (!pattern) throw new WatcherInputError('Give the pattern to allow, like "npm run *"')
  if (pattern === '*' && scope !== 'chat' && scope !== 'task') throw new WatcherInputError('"*" alone allows everything; use it only for one chat or one task')
  const expiresAt = Number(input.expiresAt || 0)
  if (!Number.isFinite(expiresAt) || expiresAt < 0) throw new WatcherInputError('The expiry is not a date')
  if (expiresAt && expiresAt <= now) throw new WatcherInputError('The expiry is already past')
  return {
    id: `trust-${randomUUID()}`,
    kind, scope, target, pattern,
    expiresAt: Math.round(expiresAt),
    createdAt: now,
    createdBy: String(by || '').slice(0, 80),
    note: String(input.note ?? '').trim().slice(0, 300),
  }
}

interface FileShape { settings: WatcherSettings; trust: TrustRule[] }

/** `HERMES_WEB_UI_HOME/watcher.json`: Settings → Watcher and the trust rules. */
export class WatcherConfigFile {
  private cache: { mtime: number; value: FileShape } | null = null

  constructor(private readonly file: () => string) {}

  private read(): FileShape {
    const path = this.file()
    try {
      if (!existsSync(path)) return { settings: DEFAULT_WATCHER_SETTINGS, trust: [] }
      const raw = JSON.parse(readFileSync(path, 'utf8'))
      const trust = Array.isArray(raw?.trust) ? raw.trust.filter((rule: any) => rule && typeof rule.id === 'string' && KINDS.includes(rule.kind) && SCOPES.includes(rule.scope)
        && typeof rule.target === 'string' && typeof rule.pattern === 'string') : []
      return { settings: sanitizeWatcherSettings(raw?.settings), trust }
    } catch {
      return { settings: DEFAULT_WATCHER_SETTINGS, trust: [] }
    }
  }

  private load(): FileShape {
    // Approvals read the rules on every question: keep the parsed file until it changes.
    if (this.cache) return this.cache.value
    const value = this.read()
    this.cache = { mtime: Date.now(), value }
    return value
  }

  private write(next: FileShape): void {
    const path = this.file()
    mkdirSync(dirname(path), { recursive: true })
    const temp = `${path}.${process.pid}.tmp`
    writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`)
    renameSync(temp, path)
    this.cache = { mtime: Date.now(), value: next }
  }

  settings(): WatcherSettings { return this.load().settings }

  saveSettings(input: unknown): WatcherSettings {
    const current = this.load()
    const settings = sanitizeWatcherSettings(input, current.settings)
    this.write({ ...current, settings })
    return settings
  }

  rules(): TrustRule[] { return this.load().trust }

  addRule(rule: TrustRule): TrustRule[] {
    const current = this.load()
    const trust = [...current.trust.filter(item => !(item.kind === rule.kind && item.scope === rule.scope && item.target === rule.target && item.pattern === rule.pattern)), rule].slice(-500)
    this.write({ ...current, trust })
    return trust
  }

  removeRule(id: string): boolean {
    const current = this.load()
    const trust = current.trust.filter(rule => rule.id !== id)
    if (trust.length === current.trust.length) return false
    this.write({ ...current, trust })
    return true
  }

  /** Expired rules go when Settings lists them. */
  dropExpired(now: number): void {
    const current = this.load()
    const trust = current.trust.filter(rule => !rule.expiresAt || rule.expiresAt > now)
    if (trust.length !== current.trust.length) this.write({ ...current, trust })
  }
}
