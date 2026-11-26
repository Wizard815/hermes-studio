import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  PHONE_KEY_PREFIX, sanitizeApprovalAlertPrefs,
  type ApprovalAlertPrefs,
} from '../../../../../../shared/approval-alerts'

/**
 * `HERMES_WEB_UI_HOME/approval-alerts.json` (docs/approval-alerts.md): each
 * user's "Where approvals reach you", and the phones paired with Studio. A
 * phone's key is shown to the phone once; only its SHA-256 hash is kept.
 */

export class ApprovalAlertsError extends Error {
  constructor(message: string, readonly status = 400) { super(message) }
}

export interface PhoneKeyRecord {
  id: string
  name: string
  hash: string
  preview: string
  userId: number
  createdAt: number
  lastUsedAt: number | null
}

interface FileShape {
  users: Record<string, ApprovalAlertPrefs>
  devices: PhoneKeyRecord[]
}

const MAX_DEVICES_PER_USER = 10
const KEY_PATTERN = /^sk-studio-phone-[A-Za-z0-9_-]{43}$/

export const hashPhoneKey = (token: string) => createHash('sha256').update(token).digest('hex')

export function cleanDeviceName(value: unknown): string {
  const name = String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60)
  return name || 'Phone'
}

export class ApprovalAlertsFile {
  private value: FileShape | null = null

  constructor(private readonly file: string) {}

  private load(): FileShape {
    if (this.value) return this.value
    let next: FileShape = { users: {}, devices: [] }
    try {
      if (existsSync(this.file)) {
        const raw = JSON.parse(readFileSync(this.file, 'utf8'))
        const users: Record<string, ApprovalAlertPrefs> = {}
        for (const [id, prefs] of Object.entries(raw?.users || {})) if (/^\d+$/.test(id)) users[id] = sanitizeApprovalAlertPrefs(prefs)
        const devices = Array.isArray(raw?.devices)
          ? raw.devices.filter((d: PhoneKeyRecord) => d && typeof d.id === 'string' && typeof d.hash === 'string' && d.hash.length === 64 && Number.isInteger(d.userId))
          : []
        next = { users, devices }
      }
    } catch { /* a broken file starts empty; the next save replaces it */ }
    this.value = next
    return next
  }

  private save(): void {
    const value = this.load()
    mkdirSync(dirname(this.file), { recursive: true })
    const temp = `${this.file}.${process.pid}.${randomUUID()}.tmp`
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
    renameSync(temp, this.file)
  }

  /** The user's saved choice, or null when they never picked. */
  savedPrefs(userId: number): ApprovalAlertPrefs | null {
    return this.load().users[String(userId)] || null
  }

  allSaved(): Array<{ userId: number; prefs: ApprovalAlertPrefs }> {
    return Object.entries(this.load().users).map(([id, prefs]) => ({ userId: Number(id), prefs }))
  }

  savePrefs(userId: number, input: unknown, base: ApprovalAlertPrefs): ApprovalAlertPrefs {
    const prefs = sanitizeApprovalAlertPrefs(input, base)
    this.load().users[String(userId)] = prefs
    this.save()
    return prefs
  }

  devices(userId?: number): PhoneKeyRecord[] {
    const all = this.load().devices
    return userId === undefined ? [...all] : all.filter(d => d.userId === userId)
  }

  /** A new phone key: the plain key is returned once and never stored. */
  createDevice(userId: number, name: unknown, now = Date.now()): { device: PhoneKeyRecord; key: string } {
    const current = this.load()
    if (current.devices.filter(d => d.userId === userId).length >= MAX_DEVICES_PER_USER) {
      throw new ApprovalAlertsError(`Remove a phone first (at most ${MAX_DEVICES_PER_USER}).`)
    }
    const key = `${PHONE_KEY_PREFIX}${randomBytes(32).toString('base64url')}`
    const device: PhoneKeyRecord = {
      id: randomUUID(), name: cleanDeviceName(name), hash: hashPhoneKey(key), preview: `${PHONE_KEY_PREFIX}…${key.slice(-4)}`,
      userId, createdAt: now, lastUsedAt: null,
    }
    current.devices.push(device)
    this.save()
    return { device, key }
  }

  removeDevice(id: string, userId?: number): boolean {
    const current = this.load()
    const before = current.devices.length
    current.devices = current.devices.filter(d => !(d.id === id && (userId === undefined || d.userId === userId)))
    if (current.devices.length === before) return false
    this.save()
    return true
  }

  findDevice(token: string): PhoneKeyRecord | null {
    if (!KEY_PATTERN.test(token)) return null
    const hash = hashPhoneKey(token)
    return this.load().devices.find(d => d.hash === hash) || null
  }

  /** Last use, saved at most once a minute per phone. */
  touchDevice(id: string, now = Date.now()): void {
    const device = this.load().devices.find(d => d.id === id)
    if (!device || (device.lastUsedAt && now - device.lastUsedAt < 60_000)) return
    device.lastUsedAt = now
    try { this.save() } catch { /* next time */ }
  }
}

/** Pairing codes: short, one use, ten minutes, kept only in memory. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
export const PAIRING_TTL_MS = 10 * 60_000

export function newPairingCode(): string {
  let code = ''
  for (let i = 0; i < 8; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]
  return `${code.slice(0, 4)}-${code.slice(4)}`
}

/** What a person typed or the QR link carried: `abcd efgh`, `ABCD-EFGH` → `ABCD-EFGH`. */
export function normalizePairingCode(value: unknown): string {
  const raw = String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
  return raw.length === 8 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : ''
}
