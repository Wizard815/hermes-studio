import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * Pondering Orb connection. Orb is a homelab dashboard that owns projects, logs
 * and upkeep checks and fronts CalDAV tasks (plans) and idea boards. Studio
 * reads it for the Mission view and exposes it to agents through Studio's MCP.
 */
export interface OrbSettings {
  /** Orb's base URL, e.g. http://pondering-orb:8080. */
  url: string
  /** An Orb API token (from ORB_API_TOKENS on the Orb side). Never sent to browsers. */
  token: string
}

export interface OrbPublicSettings {
  url: string
  hasToken: boolean
  /** Set by environment: ORB_URL / ORB_TOKEN; the UI shows them as read-only. */
  fromEnv: boolean
}

/** Read-only data kinds Studio may fetch, mapped to Orb's own REST paths. */
export const ORB_DATA_PATHS: Record<string, string> = {
  projects: '/api/c/projects',
  tasks: '/api/c/tasks',
  logs: '/api/c/logs',
  chores: '/api/c/chores',
  ideas: '/api/c/canvas',
  events: '/api/c/events',
  'upkeep-repos': '/api/upstream/repos',
  'upkeep-requests': '/api/upstream/requests',
  uptime: '/api/uptime',
  system: '/api/system',
  config: '/api/config',
}

/** Orb MCP tools Studio forwards. Writes are explicit so nothing else can be reached. */
export const ORB_TOOLS = new Set([
  'orb_list_projects', 'orb_get_project', 'orb_list_logs', 'orb_list_tasks', 'orb_list_chores',
  'orb_add_log', 'orb_move_project', 'orb_add_task', 'orb_set_task_priority', 'orb_start_task', 'orb_complete_task', 'orb_chore_done',
])

export class OrbError extends Error {
  constructor(message: string, readonly status = 502) { super(message) }
}

function trimSlash(url: string): string {
  return url.trim().replace(/\/+$/, '')
}

export class OrbClient {
  private settings: OrbSettings = { url: '', token: '' }
  private loaded = false

  constructor(private readonly file: string, private readonly env: NodeJS.ProcessEnv = process.env, private readonly fetcher: typeof fetch = fetch) {}

  private get fromEnv(): boolean {
    return !!(this.env.ORB_URL && this.env.ORB_TOKEN)
  }

  async load(): Promise<OrbSettings> {
    if (this.fromEnv) return { url: trimSlash(this.env.ORB_URL || ''), token: String(this.env.ORB_TOKEN || '') }
    if (!this.loaded) {
      this.loaded = true
      try {
        const raw = JSON.parse(await readFile(this.file, 'utf8'))
        this.settings = { url: trimSlash(String(raw.url || '')), token: String(raw.token || '') }
      } catch { /* not configured */ }
    }
    return { ...this.settings }
  }

  async publicSettings(): Promise<OrbPublicSettings> {
    const settings = await this.load()
    return { url: settings.url, hasToken: !!settings.token, fromEnv: this.fromEnv }
  }

  async save(input: { url?: unknown; token?: unknown }): Promise<OrbPublicSettings> {
    if (this.fromEnv) throw new OrbError('Orb is configured by ORB_URL and ORB_TOKEN; change those instead.', 409)
    const current = await this.load()
    const url = input.url === undefined ? current.url : trimSlash(String(input.url))
    if (url && !/^https?:\/\/[^\s]+$/i.test(url)) throw new OrbError('Orb URL must start with http:// or https://', 400)
    // An empty token in the form keeps the stored one; the browser never sees it.
    const token = typeof input.token === 'string' && input.token.trim() ? input.token.trim() : current.token
    this.settings = { url, token }
    await mkdir(dirname(this.file), { recursive: true })
    const temp = `${this.file}.${process.pid}.tmp`
    await writeFile(temp, `${JSON.stringify(this.settings, null, 2)}\n`, { mode: 0o600 })
    await rename(temp, this.file)
    return this.publicSettings()
  }

  private async request(path: string, init: RequestInit = {}): Promise<any> {
    const { url, token } = await this.load()
    if (!url) throw new OrbError('Pondering Orb is not connected. Add its address and an API token in herdr settings.', 409)
    const response = await this.fetcher(`${url}${path}`, {
      ...init,
      headers: {
        Accept: 'application/json',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(15000),
    }).catch(error => { throw new OrbError(`Pondering Orb is unreachable: ${error instanceof Error ? error.message : String(error)}`) })
    const text = await response.text()
    let body: any = null
    try { body = text ? JSON.parse(text) : null } catch { body = { error: text.slice(0, 300) } }
    if (!response.ok) throw new OrbError(body?.error || `Pondering Orb answered ${response.status}`, response.status === 401 ? 502 : response.status >= 500 ? 502 : response.status)
    return body
  }

  async status(): Promise<{ connected: boolean; version: string; error: string; settings: OrbPublicSettings }> {
    const settings = await this.publicSettings()
    if (!settings.url) return { connected: false, version: '', error: '', settings }
    try {
      const health = await this.request('/api/health')
      // Health is public; /api/me proves the token is accepted.
      await this.request('/api/me')
      return { connected: true, version: String(health?.version || ''), error: '', settings }
    } catch (error) {
      return { connected: false, version: '', error: error instanceof Error ? error.message : String(error), settings }
    }
  }

  async data(kind: string): Promise<unknown> {
    const path = ORB_DATA_PATHS[kind]
    if (!path) throw new OrbError(`Unknown Orb data: ${kind}`, 404)
    return this.request(path)
  }

  /** Call one of Orb's MCP tools (the same ones its Golem assistant uses). */
  async tool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    if (!ORB_TOOLS.has(name)) throw new OrbError(`Orb tool ${name} is not available through Studio`, 404)
    const body = await this.request('/mcp', {
      method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    })
    if (body?.error) throw new OrbError(body.error.message || 'Orb tool failed', 400)
    const text = body?.result?.content?.[0]?.text ?? ''
    if (body?.result?.isError) throw new OrbError(String(text || 'Orb tool failed'), 400)
    try { return JSON.parse(text) } catch { return text }
  }
}

let shared: OrbClient | null = null

/** Process-wide Orb client; bootstrap sets the settings file under HERMES_WEB_UI_HOME. */
export function configureOrbClient(file: string): OrbClient {
  shared = new OrbClient(file)
  return shared
}

export function getOrbClient(): OrbClient {
  if (!shared) throw new OrbError('Pondering Orb client is not configured', 503)
  return shared
}
