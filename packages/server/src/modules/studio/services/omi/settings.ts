import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { OMI_KEY_PREFIX } from './scope'

/**
 * Connections → Omi settings, kept in HERMES_WEB_UI_HOME/omi/settings.json:
 * Omi's address, its web page, the profile Omi's chats use, the Studio keys
 * made for Omi (only their SHA-256 hashes) and the results webhook Studio
 * registered for Omi.
 */

export interface OmiKeyRecord {
  id: string
  name: string
  /** SHA-256 of the key. The key itself is shown once, when it is made. */
  hash: string
  /** `sk-studio-omi-…abcd`, so the person can tell keys apart. */
  preview: string
  /** The Studio user the key acts as (the admin who made it). */
  userId: number
  createdAt: number
  lastUsedAt: number | null
}

export interface OmiSettings {
  /** Omi's backend, e.g. http://omi.lan:8000. */
  url: string
  /** Omi's web page, when it is not the backend address. */
  webUrl: string
  /** Hermes profile for the chats Omi starts. */
  profile: string
  keys: OmiKeyRecord[]
  /** The chat webhook (Settings → Webhooks) that sends results to Omi. */
  webhookEndpointId: string
}

export type OmiPublicKey = Omit<OmiKeyRecord, 'hash'>

export class OmiError extends Error {
  constructor(message: string, readonly status = 400) { super(message) }
}

const MAX_KEYS = 20
const EMPTY: OmiSettings = { url: '', webUrl: '', profile: '', keys: [], webhookEndpointId: '' }

export const hashOmiKey = (token: string) => createHash('sha256').update(token).digest('hex')

export function cleanUrl(value: unknown, what: string): string {
  const url = String(value ?? '').trim().replace(/\/+$/, '')
  if (url && !/^https?:\/\/[^\s/]+(?:\/\S*)?$/i.test(url)) throw new OmiError(`${what} must start with http:// or https://`)
  return url
}

export class OmiSettingsFile {
  private settings: OmiSettings = structuredClone(EMPTY)
  private loaded = false
  private saving: Promise<void> = Promise.resolve()

  constructor(private readonly file: string) {}

  async load(): Promise<OmiSettings> {
    if (!this.loaded) {
      this.loaded = true
      try {
        const raw = JSON.parse(await readFile(this.file, 'utf8'))
        this.settings = {
          url: String(raw.url || ''),
          webUrl: String(raw.webUrl || ''),
          profile: String(raw.profile || ''),
          keys: Array.isArray(raw.keys) ? raw.keys.filter((key: OmiKeyRecord) => key && typeof key.hash === 'string' && key.hash.length === 64) : [],
          webhookEndpointId: String(raw.webhookEndpointId || ''),
        }
      } catch { /* not set up yet */ }
    }
    return this.settings
  }

  save(): Promise<void> {
    const snapshot = `${JSON.stringify(this.settings, null, 2)}\n`
    const next = this.saving.catch(() => undefined).then(async () => {
      await mkdir(dirname(this.file), { recursive: true })
      const temp = `${this.file}.${process.pid}.${randomUUID()}.tmp`
      await writeFile(temp, snapshot, { mode: 0o600 })
      await rename(temp, this.file)
    })
    this.saving = next
    return next
  }

  async update(patch: Partial<Pick<OmiSettings, 'url' | 'webUrl' | 'profile' | 'webhookEndpointId'>>): Promise<OmiSettings> {
    const current = await this.load()
    Object.assign(current, patch)
    await this.save()
    return current
  }

  /** A new key: the plain key is returned once and never stored. */
  async createKey(userId: number, name: unknown): Promise<{ key: OmiPublicKey; apiKey: string }> {
    const label = String(name ?? '').trim() || 'Omi'
    if (label.length > 80) throw new OmiError('Key name must be 80 characters or fewer.')
    const current = await this.load()
    if (current.keys.length >= MAX_KEYS) throw new OmiError(`Revoke a key first (at most ${MAX_KEYS}).`)
    const apiKey = `${OMI_KEY_PREFIX}${randomBytes(32).toString('base64url')}`
    const record: OmiKeyRecord = {
      id: randomUUID(), name: label, hash: hashOmiKey(apiKey), preview: `${OMI_KEY_PREFIX}…${apiKey.slice(-4)}`,
      userId, createdAt: Date.now(), lastUsedAt: null,
    }
    current.keys.push(record)
    await this.save()
    return { key: publicKey(record), apiKey }
  }

  async revokeKey(id: string): Promise<boolean> {
    const current = await this.load()
    const before = current.keys.length
    current.keys = current.keys.filter(key => key.id !== id)
    if (current.keys.length === before) return false
    await this.save()
    return true
  }

  async findKey(token: string): Promise<OmiKeyRecord | null> {
    if (!/^sk-studio-omi-[A-Za-z0-9_-]{43}$/.test(token)) return null
    const hash = hashOmiKey(token)
    return (await this.load()).keys.find(key => key.hash === hash) || null
  }

  /** Last use, saved at most once a minute per key. */
  async touchKey(id: string, now = Date.now()): Promise<void> {
    const key = (await this.load()).keys.find(item => item.id === id)
    if (!key || (key.lastUsedAt && now - key.lastUsedAt < 60_000)) return
    key.lastUsedAt = now
    await this.save().catch(() => undefined)
  }
}

export function publicKey(record: OmiKeyRecord): OmiPublicKey {
  const { hash: _hash, ...rest } = record
  return rest
}
