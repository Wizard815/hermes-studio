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
