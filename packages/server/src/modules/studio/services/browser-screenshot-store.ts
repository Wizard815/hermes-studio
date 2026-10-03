/**
 * Browser Screenshot Store
 *
 * Persists browser-tool screenshots on disk, keyed by chat session id, so the
 * live browser panel survives page reloads and is shared across devices.
 *
 * Layout: <appHome>/browser-screenshots/<sessionId>/<timestamp>-<id>.jpg
 * Metadata: <appHome>/browser-screenshots/<sessionId>/index.json
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { config } from '../public/config'

export interface BrowserScreenshotMeta {
  id: string
  sessionId: string
  tabId: string
  timestamp: number
  mimeType: string
  /** Relative file name within the session directory. */
  file: string
  /** URL of the page when the screenshot was taken, if known. */
  url?: string
  title?: string
}

const ROOT = join(config.appHome, 'browser-screenshots')
const MAX_PER_SESSION = 100
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/

function safeSessionId(sessionId: string): string | null {
  const trimmed = String(sessionId || '').trim()
  if (!SESSION_ID_RE.test(trimmed)) return null
  return trimmed
}

function sessionDir(sessionId: string): string {
  return join(ROOT, sessionId)
}

function indexFile(sessionId: string): string {
  return join(sessionDir(sessionId), 'index.json')
}

function readIndex(sessionId: string): BrowserScreenshotMeta[] {
  try {
    const raw = readFileSync(indexFile(sessionId), 'utf-8')
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function writeIndex(sessionId: string, entries: BrowserScreenshotMeta[]): void {
  const dir = sessionDir(sessionId)
  mkdirSync(dir, { recursive: true })
  const tmp = join(dir, `index.json.${randomUUID()}.tmp`)
  writeFileSync(tmp, JSON.stringify(entries, null, 2))
  renameSync(tmp, indexFile(sessionId))
}

export function listScreenshots(sessionId: string): BrowserScreenshotMeta[] {
  const id = safeSessionId(sessionId)
  if (!id) return []
  return readIndex(id).sort((a, b) => b.timestamp - a.timestamp)
}

export function readScreenshotFile(sessionId: string, meta: BrowserScreenshotMeta): Buffer | null {
  const id = safeSessionId(sessionId)
  if (!id) return null
  // Guard against path traversal in stored metadata.
  const file = String(meta.file || '')
  if (!file || file.includes('/') || file.includes('\\') || file.includes('..')) return null
  try {
    return readFileSync(join(sessionDir(id), file))
  } catch {
    return null
  }
}

export function addScreenshot(
  sessionId: string,
  data: string,
  options?: { tabId?: string; url?: string; title?: string; mimeType?: string },
): BrowserScreenshotMeta | null {
  const id = safeSessionId(sessionId)
  if (!id || !data) return null

  const timestamp = Date.now()
  const screenshotId = randomUUID()
  const mimeType = options?.mimeType || 'image/jpeg'
  const ext = mimeType === 'image/png' ? 'png' : 'jpg'
  const file = `${timestamp}-${screenshotId}.${ext}`

  const dir = sessionDir(id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, file), Buffer.from(data, 'base64'))

  const meta: BrowserScreenshotMeta = {
    id: screenshotId,
    sessionId: id,
    tabId: options?.tabId || '',
    timestamp,
    mimeType,
    file,
    ...(options?.url ? { url: options.url } : {}),
    ...(options?.title ? { title: options.title } : {}),
  }

  const entries = readIndex(id)
  entries.push(meta)

  // Enforce a per-session cap, deleting the oldest files.
  const sorted = entries.sort((a, b) => a.timestamp - b.timestamp)
  while (sorted.length > MAX_PER_SESSION) {
    const oldest = sorted.shift()
    if (oldest) {
      try { unlinkSync(join(dir, oldest.file)) } catch { /* ignore */ }
    }
  }
  writeIndex(id, sorted)

  return meta
}

export function deleteScreenshot(sessionId: string, screenshotId: string): boolean {
  const id = safeSessionId(sessionId)
  if (!id || !screenshotId) return false
  const entries = readIndex(id)
  const idx = entries.findIndex(entry => entry.id === screenshotId)
  if (idx < 0) return false
  const [removed] = entries.splice(idx, 1)
  try { unlinkSync(join(sessionDir(id), removed.file)) } catch { /* ignore */ }
  writeIndex(id, entries)
  return true
}

export function clearScreenshots(sessionId: string): void {
  const id = safeSessionId(sessionId)
  if (!id) return
  const entries = readIndex(id)
  for (const entry of entries) {
    try { unlinkSync(join(sessionDir(id), entry.file)) } catch { /* ignore */ }
  }
  writeIndex(id, [])
}

export function existsScreenshotStore(): boolean {
  try {
    return existsSync(ROOT)
  } catch {
    return false
  }
}
