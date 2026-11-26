import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { getWebUiHome } from '../../public/config'

/**
 * What agents did in the browser: one line per action (navigate, click,
 * type, batch, upload, download, dialog, approvals), newest last. Kept in
 * memory for the Screen view and appended to a file per day
 * (<Studio data>/screen/activity/YYYY-MM-DD.jsonl, 14 days kept). Typed text
 * is never stored: only that something was typed and where.
 */
export interface BrowserActivity {
  at: number
  /** navigate, click, type, batch, upload, download, dialog, approval, ... */
  kind: string
  summary: string
  url?: string
  outcome: 'done' | 'failed' | 'asked' | 'allowed' | 'refused' | 'stopped'
  sessionId?: string
  agentId?: string
  error?: string
}

const KEEP_IN_MEMORY = 500
const KEEP_DAYS = 14

export function cleanActivity(input: Record<string, unknown>, from: { sessionId?: string; agentId?: string } = {}): BrowserActivity | null {
  const kind = String(input.kind || '').replace(/[^a-z_.-]/gi, '').slice(0, 40)
  const summary = String(input.summary || '').replace(/\s+/g, ' ').trim().slice(0, 300)
  const outcomes = ['done', 'failed', 'asked', 'allowed', 'refused', 'stopped'] as const
  const outcome = outcomes.find(item => item === input.outcome) || 'done'
  if (!kind || !summary) return null
  let url: string | undefined
  if (typeof input.url === 'string' && input.url) {
    // Addresses without query strings (they can hold tokens).
    try { const parsed = new URL(input.url); url = `${parsed.protocol}//${parsed.host}${parsed.pathname}`.slice(0, 300) } catch { url = undefined }
  }
  return {
    at: Date.now(),
    kind,
    summary,
    outcome,
    ...(url ? { url } : {}),
    ...(from.sessionId ? { sessionId: from.sessionId } : {}),
    ...(from.agentId ? { agentId: from.agentId } : {}),
    ...(typeof input.error === 'string' && input.error ? { error: input.error.replace(/\s+/g, ' ').slice(0, 300) } : {}),
  }
}

export class BrowserActivityLog {
  private entries: BrowserActivity[] = []
  private loaded = false

  constructor(private readonly dir = join(getWebUiHome(), 'screen', 'activity')) {}

  private day(at: number): string {
    const date = new Date(at)
    const pad = (value: number) => String(value).padStart(2, '0')
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  }

  private load() {
    if (this.loaded) return
    this.loaded = true
    try {
      const files = existsSync(this.dir) ? readdirSync(this.dir).filter(name => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)).sort() : []
      for (const name of files.slice(0, Math.max(0, files.length - KEEP_DAYS))) rmSync(join(this.dir, name), { force: true })
      for (const name of files.slice(-2)) {
        for (const line of readFileSync(join(this.dir, name), 'utf8').split('\n')) {
          if (!line.trim()) continue
          try { this.entries.push(JSON.parse(line)) } catch { /* torn line */ }
        }
      }
      this.entries = this.entries.slice(-KEEP_IN_MEMORY)
    } catch { /* fresh log */ }
  }

  add(entry: BrowserActivity) {
    this.load()
    this.entries.push(entry)
    if (this.entries.length > KEEP_IN_MEMORY) this.entries.splice(0, this.entries.length - KEEP_IN_MEMORY)
    try {
      mkdirSync(this.dir, { recursive: true })
      appendFileSync(join(this.dir, `${this.day(entry.at)}.jsonl`), `${JSON.stringify(entry)}\n`)
    } catch { /* memory only */ }
  }

  list(options: { limit?: number; sessionId?: string } = {}): BrowserActivity[] {
    this.load()
    const items = options.sessionId ? this.entries.filter(entry => entry.sessionId === options.sessionId) : this.entries
    return items.slice(-Math.min(Math.max(options.limit || 100, 1), KEEP_IN_MEMORY))
  }
}

export const browserActivity = new BrowserActivityLog()
