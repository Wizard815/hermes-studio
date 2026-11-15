import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * A Hermes chat in herdr runs as `hermes chat --resume` on the chat's model
 * (`-m`). `/model` typed in that pane changes the model of the Hermes session
 * (its `state.db` row), not Studio's chat. To keep a model picked in herdr,
 * Studio remembers both models when it opens the pane and, once the pane is
 * done (or before the next launch), takes the Hermes session's model when only
 * herdr changed it. A model picked in Studio since the launch always wins.
 */

export interface ModelRoute { model: string; provider: string }

export interface HerdrHermesLaunchRecord {
  /** Studio's model for the chat when the pane started. */
  studio: ModelRoute
  /** The Hermes session's own model when the pane started (empty: no session yet). */
  hermes: ModelRoute
  /** The model the pane started on: the chat's, else the profile's default. */
  launched: string
  at: number
}

/** The model to give Studio's chat after a herdr pane, or null to leave it. */
export function herdrModelChange(record: HerdrHermesLaunchRecord | null | undefined, studioNow: ModelRoute, hermesNow: ModelRoute | null): ModelRoute | null {
  if (!record || !hermesNow?.model) return null
  // Changed in Studio since the pane started: Studio's pick stands.
  if (studioNow.model !== record.studio.model || studioNow.provider !== record.studio.provider) return null
  // Hermes's session did not change during the pane (or only took the launch model).
  if (hermesNow.model === record.hermes.model && (hermesNow.provider || '') === (record.hermes.provider || '')) return null
  // Still the model the pane started on (a session row Hermes made or updated for the launch).
  if (hermesNow.model === record.launched) return null
  // Studio's Claude sign-in runs as Hermes's `anthropic`: keep Studio's key for it.
  const provider = hermesNow.provider === 'anthropic' && studioNow.provider === 'claude-oauth' ? 'claude-oauth' : hermesNow.provider
  return { model: hermesNow.model, provider: provider || studioNow.provider }
}

/** The provider a Hermes session row runs on (`model_config`: `gateway_runtime.provider`, else the top-level key). */
export function hermesRowProvider(modelConfig: unknown): string {
  let config: any = modelConfig
  if (typeof modelConfig === 'string') {
    try { config = JSON.parse(modelConfig) } catch { return '' }
  }
  if (!config || typeof config !== 'object') return ''
  return String(config.gateway_runtime?.provider || config.provider || '').trim()
}

/** A Hermes session's model and provider from its profile's state.db, or null. */
export async function readHermesSessionRoute(profileHome: string, sessionId: string): Promise<ModelRoute | null> {
  const file = join(profileHome, 'state.db')
  if (!sessionId || !existsSync(file)) return null
  try {
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(file, { open: true, readOnly: true })
    try {
      const row = db.prepare('SELECT model, model_config FROM sessions WHERE id = ?').get(sessionId) as { model?: unknown; model_config?: unknown } | undefined
      if (!row) return null
      return { model: String(row.model || '').trim(), provider: hermesRowProvider(row.model_config) }
    } finally { db.close() }
  } catch {
    return null
  }
}

/** Launch records, one per chat, in a small JSON file. */
export class HerdrHermesLaunchStore {
  private cache: Record<string, HerdrHermesLaunchRecord> | null = null

  constructor(private readonly file: string) {}

  private read(): Record<string, HerdrHermesLaunchRecord> {
    if (!this.cache) {
      try { this.cache = JSON.parse(readFileSync(this.file, 'utf8')) || {} } catch { this.cache = {} }
    }
    return this.cache!
  }

  private write(records: Record<string, HerdrHermesLaunchRecord>): void {
    this.cache = records
    mkdirSync(dirname(this.file), { recursive: true })
    const temp = `${this.file}.${process.pid}.tmp`
    writeFileSync(temp, `${JSON.stringify(records, null, 2)}\n`, { mode: 0o600 })
    renameSync(temp, this.file)
  }

  get(sessionId: string): HerdrHermesLaunchRecord | null {
    return this.read()[sessionId] ?? null
  }

  set(sessionId: string, record: HerdrHermesLaunchRecord): void {
    const records = { ...this.read(), [sessionId]: record }
    // Keep the newest 500 chats.
    const kept = Object.entries(records).sort((a, b) => b[1].at - a[1].at).slice(0, 500)
    this.write(Object.fromEntries(kept))
  }

  delete(sessionId: string): void {
    const records = { ...this.read() }
    if (!(sessionId in records)) return
    delete records[sessionId]
    this.write(records)
  }
}
