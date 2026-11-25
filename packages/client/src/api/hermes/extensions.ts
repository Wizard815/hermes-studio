import { hermesAgent } from './agent-api'

/**
 * Hermes Agent's MCP catalog and plugins hub, through Studio's private Hermes
 * API (super administrators). Used by Studio's MCP and Plugins pages.
 */

// ---- MCP catalog ----------------------------------------------------------

export interface McpCatalogEnv { name: string; prompt: string; required: boolean }

export interface McpCatalogEntry {
  name: string
  description: string
  connector_slug?: string | null
  source?: string | null
  transport: string
  auth_type: string
  required_env: McpCatalogEnv[]
  command?: string | null
  args?: string[]
  url?: string | null
  install_url?: string | null
  bootstrap?: string[]
  post_install?: string
  needs_install: boolean
  installed: boolean
  enabled: boolean
}

export interface McpCatalogResponse { entries: McpCatalogEntry[]; diagnostics: Array<{ name: string; kind: string; message: string }> }

export interface McpCatalogInstallResult { ok: boolean; name: string; background: boolean; action?: string }

export type McpOAuthStatus = 'starting' | 'authorization_required' | 'approved' | 'error'

export interface McpOAuthFlow {
  flow_id: string
  server_name: string
  status: McpOAuthStatus
  authorization_url: string | null
  error: string | null
  tools?: unknown
}

export const fetchMcpCatalog = () => hermesAgent<McpCatalogResponse>('mcp/catalog')

export const installMcpCatalogEntry = (name: string, env: Record<string, string> = {}) =>
  hermesAgent<McpCatalogInstallResult>('mcp/catalog/install', { method: 'POST', body: { name, env, enable: true } })

export const startMcpOAuth = (server: string) =>
  hermesAgent<McpOAuthFlow>(`mcp/servers/${encodeURIComponent(server)}/auth`, { method: 'POST', body: {} })

export const getMcpOAuthFlow = (flowId: string) =>
  hermesAgent<McpOAuthFlow>(`mcp/oauth/flows/${encodeURIComponent(flowId)}`)

export const cancelMcpOAuthFlow = (flowId: string) =>
  hermesAgent<{ ok: boolean }>(`mcp/oauth/flows/${encodeURIComponent(flowId)}`, { method: 'DELETE' })

/** Hand the provider's redirect (code + state) to Hermes, as its own callback page would receive it. */
export async function deliverMcpOAuthCallback(server: string, params: OAuthRedirectParams): Promise<void> {
  try {
    await hermesAgent(`mcp/oauth/callback/${encodeURIComponent(server)}`, { query: { ...params } })
  } catch (error) {
    // Hermes answers an accepted callback with a small HTML page, not JSON.
    if (error instanceof SyntaxError) return
    throw error
  }
}

export interface OAuthRedirectParams { code?: string; state: string; error?: string; iss?: string }

/**
 * Reads code/state (or error) from the address the browser landed on after
 * signing in. Hermes's sign-in sends the browser to Hermes's own local port,
 * which a browser on another machine cannot open: the user pastes that address
 * into Studio instead.
 */
export function parseOAuthRedirect(text: string): OAuthRedirectParams | null {
  const raw = text.trim()
  if (!raw) return null
  let search = ''
  try {
    search = new URL(raw).search
  } catch {
    const at = raw.indexOf('?')
    search = at >= 0 ? raw.slice(at) : raw
  }
  const params = new URLSearchParams(search.replace(/#.*$/, ''))
  const state = params.get('state') || ''
  const code = params.get('code') || undefined
  const error = params.get('error') || undefined
  if (!state || (!code && !error)) return null
  const iss = params.get('iss') || undefined
  return { state, ...(code ? { code } : {}), ...(error ? { error } : {}), ...(iss ? { iss } : {}) }
}

export function filterMcpCatalog(entries: McpCatalogEntry[], query: string, show: 'all' | 'installed' | 'available' = 'all') {
  const q = query.trim().toLowerCase()
  return entries.filter((entry) => {
    if (show === 'installed' && !entry.installed) return false
    if (show === 'available' && entry.installed) return false
    if (!q) return true
    return [entry.name, entry.description, entry.connector_slug, entry.url].some(value => String(value || '').toLowerCase().includes(q))
  })
}

// ---- Studio's own catalog cards ---------------------------------------------

/**
 * Paper (paper.design), a design canvas agents read and write over MCP. A
 * remote server with OAuth: Studio adds it on the MCP page, then Hermes signs
 * in (McpOAuthConnect). Designs go to Paper's servers; it needs a Paper account.
 */
export const PAPER_MCP = {
  name: 'paper',
  title: 'Paper (paper.design)',
  url: 'https://mcp.paper.design',
  host: 'mcp.paper.design',
  docs: 'https://paper.design/docs/mcp',
} as const

/** The config Studio adds for Paper. */
export function paperServerConfig(): { url: string; auth: 'oauth' } {
  return { url: PAPER_MCP.url, auth: 'oauth' }
}

/** Names of servers already pointing at Paper's MCP. */
export function paperServersAdded(servers: Array<{ name: string; url: string }>): string[] {
  return servers.filter(server => {
    try { return new URL(server.url).hostname === PAPER_MCP.host } catch { return false }
  }).map(server => server.name)
}

// ---- Home servers (Home Assistant, Unraid) ---------------------------------

/**
 * A server ready for Studio's MCP add: the config Hermes saves in config.yaml
 * and the secrets Studio puts in the profile's .env. The config only names a
 * secret as `${MCP_X_API_KEY}`, so a token is never shown back.
 */
export interface McpServerDraft {
  name: string
  config: {
    url?: string
    headers?: Record<string, string>
    timeout?: number
    connect_timeout?: number
    tools?: { include?: string[]; exclude?: string[]; resources?: boolean; prompts?: boolean }
  }
  secrets: Record<string, string>
}

/** Why a home server form cannot be saved; each is a hermesExtensions.home.errors key. */
export type HomeServerError = 'name' | 'address' | 'token' | 'connectUrl' | 'sshPort'

export class HomeServerFormError extends Error {
  readonly code: HomeServerError
  constructor(code: HomeServerError) {
    super(code)
    this.code = code
  }
}

/** Hermes's own .env name for a server's key: MCP_HOME_ASSISTANT_API_KEY. */
export function mcpSecretKey(server: string, part = 'API_KEY'): string {
  const suffix = server.toUpperCase().replace(/[^A-Z0-9_]/g, '_').replace(/^_+|_+$/g, '')
  return `MCP_${suffix}_${part}`
}

export function normalizeServerName(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64)
}

/** A typed address as a base URL: adds http:// when missing, drops a trailing slash. */
export function normalizeAddress(address: string): string {
  let value = address.trim()
  if (!value) return ''
  if (!/^https?:\/\//i.test(value)) value = `http://${value}`
  try {
    const url = new URL(value)
    if (!url.hostname) return ''
  } catch {
    return ''
  }
  return value.replace(/\/+$/, '')
}

/** How config.yaml names a .env value: ${MCP_X_API_KEY}. */
export const envRef = (key: string) => '${' + key + '}'

function stripBearer(token: string): string {
  const value = token.trim()
  return /^bearer\s+/i.test(value) ? value.replace(/^bearer\s+/i, '').trim() : value
}

/**
 * Home Assistant's read tools (readOnlyHint) as Hermes include globs: newer
 * Home Assistant prefixes names (homeassistant__GetLiveContext), older ones do
 * not. Everything else (HassTurnOn/Off, call_action, list edits, reload, broadcast)
 * stays out, so Hermes watches but does not control devices through MCP.
 */
export const HOME_ASSISTANT_READ_TOOLS = [
  '*GetLiveContext', '*GetDateTime', '*get_items', '*get_history', '*render_template',
  '*search_actions', '*search_integrations', 'search', '*__search', '*get_config_entries',
  '*get_system_info', '*get_entries', '*get_logs',
] as const

/** Whether a tool name passes a Hermes include list (exact names or fnmatch-style * and ? globs). */
export function toolIncluded(tool: string, include: readonly string[]): boolean {
  const toRegExp = (glob: string) => new RegExp(`^${[...glob].map(ch => ch === '*' ? '.*' : ch === '?' ? '.' : ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')).join('')}$`)
  return include.some(glob => toRegExp(glob).test(tool))
}

export interface HomeAssistantForm { name?: string; address: string; token: string; readOnly?: boolean }

/** Home Assistant's built-in MCP Server: <address>/api/mcp, streamable HTTP, a long-lived token. */
export function buildHomeAssistantServer(form: HomeAssistantForm): McpServerDraft {
  const name = normalizeServerName(form.name || 'home-assistant')
  if (!name) throw new HomeServerFormError('name')
  const base = normalizeAddress(form.address).replace(/\/api\/mcp$/i, '')
  if (!base) throw new HomeServerFormError('address')
  const token = stripBearer(form.token)
  if (!token) throw new HomeServerFormError('token')
  const key = mcpSecretKey(name)
  return {
    name,
    config: {
      url: `${base}/api/mcp`,
      headers: { Authorization: `Bearer ${envRef(key)}` },
      ...(form.readOnly === false ? {} : { tools: { include: [...HOME_ASSISTANT_READ_TOOLS] } }),
    },
    secrets: { [key]: token },
  }
}

export interface HomeAssistantBuilderForm {
  sshHost: string
  sshPort?: string | number
  sshUser?: string
  /** Private key file on the machine Hermes runs on. */
  sshKey?: string
  /** Home Assistant's config folder on the SSH host; empty = the skill finds it (/homeassistant or /config). */
  configDir?: string
}

/**
 * The .env values for the home-assistant-builder skill, which copies a script or
 * automation package over SSH, has Home Assistant check and reload it, and can
 * start a script. Empty when no SSH host is given.
 */
export function homeAssistantBuilderEnv(ha: HomeAssistantForm, form: HomeAssistantBuilderForm): Record<string, string> {
  const host = form.sshHost.trim()
  if (!host) return {}
  const base = normalizeAddress(ha.address).replace(/\/api\/mcp$/i, '')
  if (!base) throw new HomeServerFormError('address')
  const token = stripBearer(ha.token)
  if (!token) throw new HomeServerFormError('token')
  const port = String(form.sshPort || '').trim() || '22'
  if (!/^\d{1,5}$/.test(port)) throw new HomeServerFormError('sshPort')
  return {
    HA_BUILD_URL: base,
    HA_BUILD_TOKEN: token,
    HA_BUILD_SSH_HOST: host,
    HA_BUILD_SSH_PORT: port,
    HA_BUILD_SSH_USER: (form.sshUser || '').trim() || 'root',
    HA_BUILD_SSH_KEY: (form.sshKey || '').trim(),
    // The SSH add-ons mount the config at /homeassistant or /config depending on version: "auto" finds it.
    HA_BUILD_CONFIG_DIR: (form.configDir || '').trim() || 'auto',
  }
}

/** Save one value in the profile's .env through Hermes's own API. */
export const saveHermesEnvValue = (key: string, value: string) =>
  hermesAgent<unknown>('env', { method: 'PUT', body: { key, value } })

/** How Hermes signs in to the Unraid Management Agent's MCP. */
export type UnraidAuth = 'token' | 'connect-url' | 'none'

export interface UnraidForm {
  name?: string
  /** The agent's address, e.g. http://tower.local:8043 (port 8043 by default). */
  address?: string
  auth: UnraidAuth
  /** The agent's API token (sent as Authorization: Bearer). */
  token?: string
  /** The whole Connect URL from the agent's settings: http://tower:8043/mcp/<connect-secret>. */
  connectUrl?: string
}

export const UNRAID_DEFAULT_PORT = 8043

/**
 * The Unraid Management Agent (tinkerologie/unraid-management-agent) serves
 * stateful streamable HTTP MCP at http://<unraid>:8043/mcp, with the API token
 * as a Bearer header, or at /mcp/<connect-secret> with the secret in the path.
 */
export function buildUnraidServer(form: UnraidForm): McpServerDraft {
  const name = normalizeServerName(form.name || 'unraid')
  if (!name) throw new HomeServerFormError('name')
  if (form.auth === 'connect-url') {
    const match = normalizeAddress(form.connectUrl || '').match(/^(https?:\/\/[^/]+)\/mcp\/([A-Za-z0-9_-]{8,256})$/)
    if (!match) throw new HomeServerFormError('connectUrl')
    const key = mcpSecretKey(name, 'CONNECT_SECRET')
    return { name, config: { url: `${match[1]}/mcp/${envRef(key)}` }, secrets: { [key]: match[2] } }
  }
  // A bare host (tower.local) gets the agent's default port; a typed scheme or port is kept.
  const typed = (form.address || '').trim()
  const bare = !!typed && !/^https?:\/\//i.test(typed) && !/:\d+(\/|$)/.test(typed)
  const base = normalizeAddress(bare ? `${typed.replace(/\/.*$/, '')}:${UNRAID_DEFAULT_PORT}` : typed).replace(/\/mcp$/i, '')
  if (!base) throw new HomeServerFormError('address')
  const url = `${base}/mcp`
  if (form.auth === 'none') return { name, config: { url }, secrets: {} }
  const token = stripBearer(form.token || '')
  if (!token) throw new HomeServerFormError('token')
  const key = mcpSecretKey(name)
  return { name, config: { url, headers: { Authorization: `Bearer ${envRef(key)}` } }, secrets: { [key]: token } }
}

export interface OmiForm { name?: string; address: string; key: string }

/** omi-local's backend port (omi-host/docker-compose.yml, BACKEND_PORT). */
export const OMI_DEFAULT_PORT = 8000
/** Omi tools that delete things; Omi's own Hermes recipe leaves them out (omi-host/examples/hermes). */
export const OMI_EXCLUDED_TOOLS = ['delete_action_item', 'delete_memory', 'dismiss_person'] as const

/**
 * Omi (omi-local) serves Streamable HTTP MCP at <omi>/v1/mcp with an
 * `omi_mcp_` key as a Bearer header. Same settings as Omi's Hermes recipe:
 * a long timeout for slow local models, no delete tools, no resources or prompts.
 */
export function buildOmiServer(form: OmiForm): McpServerDraft {
  const name = normalizeServerName(form.name || 'omi')
  if (!name) throw new HomeServerFormError('name')
  const typed = (form.address || '').trim()
  const bare = !!typed && !/^https?:\/\//i.test(typed) && !/:\d+(\/|$)/.test(typed)
  const base = normalizeAddress(bare ? `${typed.replace(/\/.*$/, '')}:${OMI_DEFAULT_PORT}` : typed).replace(/\/v1\/mcp(?:\/sse)?$/i, '')
  if (!base) throw new HomeServerFormError('address')
  const token = stripBearer(form.key || '')
  if (!/^omi_mcp_\S+$/.test(token)) throw new HomeServerFormError('token')
  const key = mcpSecretKey(name)
  return {
    name,
    config: {
      url: `${base}/v1/mcp`,
      headers: { Authorization: `Bearer ${envRef(key)}` },
      timeout: 120,
      connect_timeout: 30,
      tools: { exclude: [...OMI_EXCLUDED_TOOLS], resources: false, prompts: false },
    },
    secrets: { [key]: token },
  }
}

// ---- Plugins hub ----------------------------------------------------------

export interface PluginCatalogEntry {
  name: string
  title?: string
  repo?: string
  description: string
  maintainer?: string
  tier: string
  category: string
  docs_url?: string
  version?: string
  image?: string
  known_issues?: string[]
  platforms?: string[]
  capabilities?: { provides_tools?: string[]; provides_hooks?: string[]; requires_env?: string[] }
  installed: boolean
  installed_sha?: string | null
  update_available: boolean
  runtime_status?: string | null
}

export interface PluginCatalogResponse { entries: PluginCatalogEntry[]; removed?: Array<{ name: string; reason: string }>; generated_at?: string }

export interface PluginHubEntry {
  name: string
  version?: string
  description?: string
  source: string
  runtime_status?: string
  path?: string
  can_remove: boolean
  can_update_git: boolean
  auth_required?: boolean
  auth_command?: string
  removed_reason?: string | null
}

export interface PluginHubResponse { plugins: PluginHubEntry[] }

export interface PluginActionResult {
  ok?: boolean
  error?: string
  plugin_name?: string
  warnings?: string[]
  missing_env?: string[]
  restart_required?: boolean
  known_issues?: string[]
  consent_required?: boolean
  scan_blocked?: boolean
  scan_verdict?: string
  scan_findings?: unknown
  delta?: unknown
}

export interface PluginUpdateAllResult {
  results: Array<{ name: string; status: 'updated' | 'current' | 'failed' | 'needs_review'; detail?: string }>
  skipped: Array<{ name: string; reason: string }>
  current?: number
}

export interface PluginAutoUpdate { auto_apply: boolean; check_hours: number }

const pluginPath = (name: string) => name.split('/').map(encodeURIComponent).join('/')

export const fetchPluginsHub = () => hermesAgent<PluginHubResponse>('dashboard/plugins/hub')
export const fetchPluginsCatalog = () => hermesAgent<PluginCatalogResponse>('dashboard/plugins/catalog')
export const installHubPlugin = (catalogName: string) =>
  hermesAgent<PluginActionResult>('dashboard/agent-plugins/install', { method: 'POST', body: { identifier: '', catalog_name: catalogName, enable: true } })
export const installPluginFromSource = (identifier: string) =>
  hermesAgent<PluginActionResult>('dashboard/agent-plugins/install', { method: 'POST', body: { identifier, enable: true } })
export const updateHubPlugin = (name: string, confirm: { accept_capabilities?: boolean; force?: boolean } = {}) =>
  hermesAgent<PluginActionResult>(`dashboard/agent-plugins/${pluginPath(name)}/update`, { method: 'POST', body: confirm })
export const updateAllHubPlugins = () => hermesAgent<PluginUpdateAllResult>('dashboard/agent-plugins/update-all', { method: 'POST', body: {} })
export const removeHubPlugin = (name: string) => hermesAgent<PluginActionResult>(`dashboard/agent-plugins/${pluginPath(name)}`, { method: 'DELETE' })
export const setHubPluginEnabled = (name: string, enabled: boolean) =>
  hermesAgent<PluginActionResult>(`dashboard/agent-plugins/${pluginPath(name)}/${enabled ? 'enable' : 'disable'}`, { method: 'POST', body: {} })
export const fetchPluginsAutoUpdate = () => hermesAgent<PluginAutoUpdate>('dashboard/plugins/auto-update')
export const setPluginsAutoUpdate = (enabled: boolean) => hermesAgent<PluginAutoUpdate>('dashboard/plugins/auto-update', { method: 'PUT', body: { enabled } })
export const rescanPlugins = () => hermesAgent<{ ok: boolean; count: number }>('dashboard/plugins/rescan')

const TIER_RANK: Record<string, number> = { official: 0, verified: 1, community: 2 }

export interface PluginCatalogFilter { query: string; category?: string | null; tier?: string | null; show?: 'all' | 'installed' | 'updates' }

/** Search and order the plugin catalog: installed first, then official, verified, community. */
export function filterPluginCatalog(entries: PluginCatalogEntry[], filter: PluginCatalogFilter): PluginCatalogEntry[] {
  const q = filter.query.trim().toLowerCase()
  return entries
    .filter((entry) => {
      if (filter.category && entry.category !== filter.category) return false
      if (filter.tier && entry.tier !== filter.tier) return false
      if (filter.show === 'installed' && !entry.installed) return false
      if (filter.show === 'updates' && !entry.update_available) return false
      if (!q) return true
      return [entry.name, entry.title, entry.description, entry.maintainer, entry.category, ...(entry.platforms || [])]
        .some(value => String(value || '').toLowerCase().includes(q))
    })
    .sort((a, b) => Number(b.installed) - Number(a.installed)
      || (TIER_RANK[a.tier] ?? 9) - (TIER_RANK[b.tier] ?? 9)
      || a.name.localeCompare(b.name))
}

/** The plain message for an install/update answer that needs the user's decision or failed. */
export function pluginActionProblem(result: PluginActionResult): string | null {
  if (result.consent_required) return 'consent'
  if (result.scan_blocked) return 'scan'
  if (result.ok === false) return result.error || 'failed'
  return null
}
