import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  DEFAULT_RUN_LIMITS, LIMIT_FIELDS, sanitizeLimitValue,
  type RunLimitHit, type RunLimitKind, type RunLimitOverrides, type RunLimits,
} from '../../../../../../shared/run-limits'

/**
 * Run limits on disk (HERMES_WEB_UI_HOME/run-limits.json): the limits from
 * Settings, and each chat's own overrides (`/limits` in the chat or the
 * "Continue with a higher limit" button). A field a chat sets wins over
 * Settings for that chat; null there means "off for this chat".
 */
export interface RunLimitSettingsFile {
  defaults: RunLimits
  chats: Record<string, RunLimitOverrides>
  /**
   * Chats a limit stopped that still wait on Continue or Stop, so they stay
   * blocked after Studio restarts. `turn` is the agent turn the limit caught
   * (a herdr pane's retry of that turn is still refused).
   */
  blocked?: Record<string, { hit: RunLimitHit; turn?: string }>
}

/** A saved hit as read back from disk, or null when it does not look like one. */
export function normalizeBlockedHit(raw: unknown): RunLimitHit | null {
  if (!raw || typeof raw !== 'object') return null
  const hit = raw as Record<string, unknown>
  if (!KINDS.includes(hit.kind as RunLimitKind)) return null
  if (hit.via !== 'run' && hit.via !== 'gateway') return null
  const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : null
  const limit = number(hit.limit), value = number(hit.value), suggested = number(hit.suggested), at = number(hit.at)
  if (limit === null || value === null || suggested === null || at === null) return null
  return {
    kind: hit.kind as RunLimitKind, limit, value, suggested, at, via: hit.via,
    ...(typeof hit.detail === 'string' ? { detail: hit.detail.slice(0, 500) } : {}),
    ...(hit.failing === true ? { failing: true } : {}),
    ...(typeof hit.runId === 'string' ? { runId: hit.runId.slice(0, 200) } : {}),
  }
}

const KINDS = Object.keys(LIMIT_FIELDS) as RunLimitKind[]

function fieldKind(field: keyof RunLimits): RunLimitKind {
  return KINDS.find(kind => LIMIT_FIELDS[kind] === field)!
}

export function normalizeLimits(raw: unknown, base: RunLimits = DEFAULT_RUN_LIMITS): RunLimits {
  const input = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const next = { ...base }
  for (const kind of KINDS) {
    const field = LIMIT_FIELDS[kind]
    if (field in input) next[field] = sanitizeLimitValue(kind, input[field])
  }
  return next
}

export function normalizeOverrides(raw: unknown): RunLimitOverrides {
  const input = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const next: RunLimitOverrides = {}
  for (const kind of KINDS) {
    const field = LIMIT_FIELDS[kind]
    if (field in input) next[field] = sanitizeLimitValue(kind, input[field])
  }
  return next
}

export class RunLimitSettingsStore {
  private cache: RunLimitSettingsFile | null = null

  constructor(private readonly file: () => string) {}

  read(): RunLimitSettingsFile {
    if (this.cache) return this.cache
    let parsed: RunLimitSettingsFile = { defaults: { ...DEFAULT_RUN_LIMITS }, chats: {} }
    try {
      const path = this.file()
      if (existsSync(path)) {
        const raw = JSON.parse(readFileSync(path, 'utf8'))
        const chats: Record<string, RunLimitOverrides> = {}
        for (const [id, value] of Object.entries(raw?.chats || {})) {
          const overrides = normalizeOverrides(value)
          if (id && id.length <= 200 && Object.keys(overrides).length) chats[id] = overrides
        }
        const blocked: NonNullable<RunLimitSettingsFile['blocked']> = {}
        for (const [id, value] of Object.entries(raw?.blocked || {})) {
          const hit = normalizeBlockedHit((value as { hit?: unknown })?.hit)
          const turn = (value as { turn?: unknown })?.turn
          if (id && id.length <= 200 && hit) blocked[id] = { hit, ...(typeof turn === 'string' && turn ? { turn: turn.slice(0, 200) } : {}) }
        }
        parsed = { defaults: normalizeLimits(raw?.defaults), chats, ...(Object.keys(blocked).length ? { blocked } : {}) }
      }
    } catch { /* unreadable: defaults */ }
    this.cache = parsed
    return parsed
  }

  private write(next: RunLimitSettingsFile) {
    const path = this.file()
    mkdirSync(dirname(path), { recursive: true })
    const temp = `${path}.${process.pid}.tmp`
    writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`)
    renameSync(temp, path)
    this.cache = next
  }

  defaults(): RunLimits { return { ...this.read().defaults } }

  saveDefaults(input: unknown): RunLimits {
    const current = this.read()
    const defaults = normalizeLimits(input, current.defaults)
    this.write({ ...current, defaults })
    return { ...defaults }
  }

  overrides(sessionId: string): RunLimitOverrides { return { ...(this.read().chats[sessionId] || {}) } }

  /** Merge fields into a chat's overrides; `reset: true` drops them all first (the chat follows Settings again). */
  saveOverrides(sessionId: string, input: unknown, options: { reset?: boolean; clear?: Array<keyof RunLimits> } = {}): RunLimitOverrides {
    const current = this.read()
    const merged = { ...(options.reset ? {} : current.chats[sessionId] || {}), ...normalizeOverrides(input) }
    for (const field of options.clear || []) delete merged[field]
    const chats = { ...current.chats }
    if (Object.keys(merged).length) chats[sessionId] = merged
    else delete chats[sessionId]
    this.write({ ...current, chats })
    return { ...merged }
  }

  forget(sessionId: string) {
    const current = this.read()
    if (!current.chats[sessionId] && !current.blocked?.[sessionId]) return
    const chats = { ...current.chats }
    delete chats[sessionId]
    const blocked = { ...(current.blocked || {}) }
    delete blocked[sessionId]
    this.write({ ...current, chats, blocked })
  }

  /** Chats waiting on Continue or Stop after a limit stopped them. */
  blocked(): Record<string, { hit: RunLimitHit; turn?: string }> {
    return { ...(this.read().blocked || {}) }
  }

  /** Remember (hit) or forget (null) that a chat waits on a limit. */
  saveBlocked(sessionId: string, hit: RunLimitHit | null, turn?: string) {
    const current = this.read()
    const blocked = { ...(current.blocked || {}) }
    if (!hit && !blocked[sessionId]) return
    if (hit) blocked[sessionId] = { hit: { ...hit }, ...(turn ? { turn } : {}) }
    else delete blocked[sessionId]
    this.write({ ...current, blocked })
  }

  effective(sessionId: string): RunLimits {
    const { defaults, chats } = this.read()
    const own = chats[sessionId] || {}
    const next = { ...defaults }
    for (const field of Object.keys(own) as Array<keyof RunLimits>) next[field] = own[field] ?? null
    return next
  }
}

export { fieldKind }
