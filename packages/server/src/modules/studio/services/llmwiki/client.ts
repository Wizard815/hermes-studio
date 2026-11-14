import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * LLMWIKI: the Obsidian vault "LLM-will-remember-this", reached through
 * Obsidian's Local REST API (port 27123) and its /mcp endpoint.
 *
 * The vault has two memory tiers. wiki/ is long-term memory: Studio only reads
 * it (query_wiki, get_wiki). daily/ is short-term memory: Studio appends to
 * today's daily note. Studio never writes to wiki/; promotion stays with the
 * vault's own Rollover/Ingest workflows.
 */
export interface LlmWikiSettings {
  /** e.g. http://192.168.20.5:27123 (LAN) or http://llmwiki:27123 (same Docker network). */
  url: string
  /** The Local REST API key. Never sent to browsers. */
  token: string
  /** Add matching wiki notes to the first message of each chat. */
  recall: boolean
  /** Note each chat worked on in today's daily note. */
  saveChats: boolean
}

export interface LlmWikiPublicSettings {
  url: string
  hasToken: boolean
  recall: boolean
  saveChats: boolean
  /** Set by LLMWIKI_URL / LLMWIKI_TOKEN; the UI shows the address read-only. */
  fromEnv: boolean
}

export class LlmWikiError extends Error {
  constructor(message: string, readonly status = 502) { super(message) }
}

/** The vault's MCP tools Studio may call. Search and read only. */
export const LLMWIKI_TOOLS = new Set(['query_wiki', 'get_wiki', 'wiki_card'])

const DEFAULTS: LlmWikiSettings = { url: '', token: '', recall: true, saveChats: true }
const TIMEOUT_MS = 15_000

function trimSlash(url: string): string {
  return url.trim().replace(/\/+$/, '')
}

/** Today's date as the vault names daily notes (YYYY-MM-DD, Studio's local time). */
export function vaultDate(now = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/** A new daily note, matching schema/templates/DAILY.md. */
export function dailyNoteTemplate(date: string): string {
  return [
    '---',
    `title: "${date}"`,
    'type: daily',
    'tags: [daily]',
    `created: ${date}`,
    'status: open',
    'related: []',
    '---',
    '',
    `# ${date}`,
    '',
    "> [!note] Short-term memory. Not a wiki note — don't cite this file from `wiki/`. Append through the day; it gets rolled into the wiki (or discarded) at end of day, never edited after rollover.",
    '',
    '## Worked on',
    '',
    '',
    '## Decisions / facts worth keeping',
    '',
    '',
    '## Follow-ups',
    '',
    '',
  ].join('\n')
}

/** Daily note sections Studio may add to. */
export const DAILY_SECTIONS = {
  worked: 'Worked on',
  facts: 'Decisions / facts worth keeping',
  followups: 'Follow-ups',
} as const
export type DailySection = keyof typeof DAILY_SECTIONS

/** Never write secrets into the vault (its rule: "never output passwords, keys, or tokens"). */
export function redactSecrets(text: string): string {
  return text
    .replace(/\b(sk|pk|rk|ghp|gho|ghs|github_pat|xox[abprs]|glpat)[-_][A-Za-z0-9_-]{10,}/g, '[redacted]')
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{12,}/gi, '$1 [redacted]')
    .replace(/\b(password|passwd|secret|token|api[_-]?key)\s*[:=]\s*\S+/gi, '$1: [redacted]')
}

/** Parses a JSON or text/event-stream MCP answer and returns the reply for `id`. */
export function parseMcpReply(text: string, id: number): any {
  const trimmed = text.trim()
  if (!trimmed) return null
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const body = JSON.parse(trimmed)
    return Array.isArray(body) ? body.find(item => item?.id === id) ?? body[0] : body
  }
  let found: any = null
  for (const line of trimmed.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue
    try {
      const message = JSON.parse(line.slice(5).trim())
      if (message?.id === id || (found === null && ('result' in (message || {}) || 'error' in (message || {})))) found = message
    } catch { /* keep-alive or partial frame */ }
  }
  return found
}

export class LlmWikiClient {
  private settings: LlmWikiSettings = { ...DEFAULTS }
  private loaded = false
  private mcpSession: string | null = null
  private initialized = false
  private nextId = 1

  constructor(private readonly file: string, private readonly env: NodeJS.ProcessEnv = process.env, private readonly fetcher: typeof fetch = fetch) {}

  private get fromEnv(): boolean {
    return !!this.env.LLMWIKI_URL
  }

  async load(): Promise<LlmWikiSettings> {
    if (!this.loaded) {
      this.loaded = true
      try {
        const raw = JSON.parse(await readFile(this.file, 'utf8'))
        this.settings = {
          url: trimSlash(String(raw.url || '')),
          token: String(raw.token || ''),
          recall: raw.recall !== false,
          saveChats: raw.saveChats !== false,
        }
      } catch { /* not configured */ }
    }
    if (this.fromEnv) {
      return { ...this.settings, url: trimSlash(String(this.env.LLMWIKI_URL)), token: String(this.env.LLMWIKI_TOKEN || this.settings.token || '') }
    }
    return { ...this.settings }
  }

  async publicSettings(): Promise<LlmWikiPublicSettings> {
    const settings = await this.load()
    return { url: settings.url, hasToken: !!settings.token, recall: settings.recall, saveChats: settings.saveChats, fromEnv: this.fromEnv }
  }

  async connected(): Promise<boolean> {
    return !!(await this.load()).url
  }

  async save(input: { url?: unknown; token?: unknown; recall?: unknown; saveChats?: unknown }): Promise<LlmWikiPublicSettings> {
    const current = await this.load()
    let url = this.settings.url
    if (input.url !== undefined) {
      if (this.fromEnv) throw new LlmWikiError('The LLMWIKI address is set by LLMWIKI_URL; change that instead.', 409)
      url = trimSlash(String(input.url))
      if (url && !/^https?:\/\/[^\s]+$/i.test(url)) throw new LlmWikiError('The LLMWIKI address must start with http:// or https://', 400)
    }
    // An empty key in the form keeps the stored one; the browser never sees it.
    const token = typeof input.token === 'string' && input.token.trim() ? input.token.trim() : this.settings.token
    this.settings = {
      url,
      token,
      recall: typeof input.recall === 'boolean' ? input.recall : current.recall,
      saveChats: typeof input.saveChats === 'boolean' ? input.saveChats : current.saveChats,
    }
    this.mcpSession = null
    this.initialized = false
    await mkdir(dirname(this.file), { recursive: true })
    const temp = `${this.file}.${process.pid}.tmp`
    await writeFile(temp, `${JSON.stringify(this.settings, null, 2)}\n`, { mode: 0o600 })
    await rename(temp, this.file)
    return this.publicSettings()
  }

  private async http(path: string, init: RequestInit & { headers?: Record<string, string> } = {}): Promise<Response> {
    const { url, token } = await this.load()
    if (!url) throw new LlmWikiError('LLMWIKI is not connected. Add its address and API key in Connections → LLMWIKI.', 409)
    return this.fetcher(`${url}${path}`, {
      ...init,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(init.headers || {}) },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }).catch((error) => {
      throw new LlmWikiError(`LLMWIKI is unreachable: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  private async rpc(method: string, params: unknown, notification = false): Promise<any> {
    const id = this.nextId++
    const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }
    if (this.mcpSession) headers['Mcp-Session-Id'] = this.mcpSession
    const response = await this.http('/mcp/', {
      method: 'POST',
      headers,
      body: JSON.stringify(notification ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id, method, params }),
    })
    const session = response.headers.get('mcp-session-id')
    if (session) this.mcpSession = session
    const text = await response.text()
    if (response.status === 401 || response.status === 403) throw new LlmWikiError('LLMWIKI refused the API key', 502)
    if (notification) return null
    if (!response.ok) {
      const error = new LlmWikiError(`LLMWIKI answered ${response.status}${text ? `: ${text.slice(0, 200)}` : ''}`, response.status === 404 ? 404 : 502)
      throw error
    }
    let reply: any
    try { reply = parseMcpReply(text, id) } catch { throw new LlmWikiError('LLMWIKI sent an unreadable answer') }
    if (reply?.error) throw new LlmWikiError(reply.error.message || 'LLMWIKI tool failed', 400)
    return reply?.result
  }

  private async ensureMcp() {
    if (this.initialized) return
    await this.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'hermes-studio', version: '1' } })
    await this.rpc('notifications/initialized', {}, true).catch(() => undefined)
    this.initialized = true
  }

  /** Calls one of the vault's MCP tools and returns its text. */
  async tool(name: string, args: Record<string, unknown> = {}): Promise<string> {
    if (!LLMWIKI_TOOLS.has(name)) throw new LlmWikiError(`LLMWIKI tool ${name} is not available through Studio`, 404)
    const call = async () => {
      await this.ensureMcp()
      return this.rpc('tools/call', { name, arguments: args })
    }
    let result: any
    try {
      result = await call()
    } catch (error) {
      // An expired MCP session: start a new one once.
      if (!(error instanceof LlmWikiError) || ![400, 404].includes(error.status) || !this.initialized) throw error
      this.initialized = false
      this.mcpSession = null
      result = await call()
    }
    const text = Array.isArray(result?.content) ? result.content.map((item: any) => item?.text || '').join('\n').trim() : ''
    if (result?.isError) throw new LlmWikiError(text || 'LLMWIKI tool failed', 400)
    return text
  }

  async search(query: string): Promise<string> {
    return this.tool('query_wiki', { query: String(query || '').slice(0, 1000) })
  }

  async read(path: string): Promise<string> {
    return this.tool('get_wiki', { path: String(path || '') })
  }

  async status(): Promise<{ connected: boolean; error: string; card: string; settings: LlmWikiPublicSettings }> {
    const settings = await this.publicSettings()
    if (!settings.url) return { connected: false, error: '', card: '', settings }
    try {
      this.initialized = false
      this.mcpSession = null
      const card = await this.tool('wiki_card')
      return { connected: true, error: '', card: card.slice(0, 2000), settings }
    } catch (error) {
      return { connected: false, error: error instanceof Error ? error.message : String(error), card: '', settings }
    }
  }

  private dailyPath(date: string): string {
    return `/vault/daily/${encodeURIComponent(`${date}.md`)}`
  }

  /**
   * Adds lines to a section of today's daily note (creating the note from the
   * vault's template if there is none yet). Short-term memory only.
   */
  async addToDaily(section: DailySection, lines: string[], now = new Date()): Promise<{ path: string }> {
    const clean = lines.map(line => redactSecrets(String(line)).replace(/\s+/g, ' ').trim()).filter(Boolean).map(line => `- ${line.replace(/^[-*]\s+/, '')}`)
    if (!clean.length) throw new LlmWikiError('Nothing to write', 400)
    const date = vaultDate(now)
    const path = this.dailyPath(date)
    const existing = await this.http(path, { headers: { Accept: 'text/markdown' } })
    if (existing.status === 404) {
      await existing.text()
      const created = await this.http(path, { method: 'PUT', headers: { 'Content-Type': 'text/markdown' }, body: dailyNoteTemplate(date) })
      if (!created.ok) throw new LlmWikiError(`LLMWIKI did not create today's note (${created.status})`)
      await created.text()
    } else if (!existing.ok) {
      throw new LlmWikiError(existing.status === 401 || existing.status === 403 ? 'LLMWIKI refused the API key' : `LLMWIKI answered ${existing.status}`)
    } else {
      await existing.text()
    }
    const body = `${clean.join('\n')}\n`
    const patched = await this.http(path, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'text/markdown',
        Operation: 'append',
        'Target-Type': 'heading',
        Target: `${date}::${DAILY_SECTIONS[section]}`,
        'Target-Delimiter': '::',
      },
      body,
    })
    if (patched.ok) { await patched.text(); return { path: `daily/${date}.md` } }
    await patched.text()
    // The section is missing (a hand-edited note): add it at the end.
    const appended = await this.http(path, { method: 'POST', headers: { 'Content-Type': 'text/markdown' }, body: `\n## ${DAILY_SECTIONS[section]}\n\n${body}` })
    if (!appended.ok) throw new LlmWikiError(`LLMWIKI did not save the note (${appended.status})`)
    await appended.text()
    return { path: `daily/${date}.md` }
  }
}

let shared: LlmWikiClient | null = null

export function configureLlmWikiClient(file: string): LlmWikiClient {
  shared = new LlmWikiClient(file)
  return shared
}

export function getLlmWikiClient(): LlmWikiClient {
  if (!shared) throw new LlmWikiError('LLMWIKI client is not configured', 503)
  return shared
}

export function getLlmWikiClientIfConfigured(): LlmWikiClient | null {
  return shared
}
