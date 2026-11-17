import { hermesApi } from '../services/hermes-api'
import type { Context } from 'koa'
import { bridgeMcpAction } from '../services/mcp/bridge-actions'

function getProfile(ctx: Context): string | undefined {
  return (ctx.state as any)?.profile?.name || undefined
}

/** Validate server name: non-empty, no control chars, no path separators */
function isValidServerName(name: string): boolean {
  if (!name || name.trim().length === 0) return false
  if (name.length > 128) return false
  // Reject path separators and control characters
  if (/[/\\\x00-\x1f]/.test(name)) return false
  return true
}

export async function listServers(ctx: Context) {
  try {
    ctx.body = await bridgeMcpAction('mcp_list', {}, getProfile(ctx))
  } catch (err: any) {
    ctx.status = 503
    ctx.body = { error: err.message || 'MCP bridge not available' }
  }
}

export async function addServer(ctx: Context) {
  try {
    const { name, config } = (ctx.request.body || {}) as Record<string, unknown>
    if (typeof name !== 'string' || !isValidServerName(name)) {
      ctx.status = 400
      ctx.body = { error: 'Valid server name is required' }
      return
    }
    if (!config || typeof config !== 'object') {
      ctx.status = 400
      ctx.body = { error: 'config object is required' }
      return
    }
    ctx.body = await bridgeMcpAction('mcp_server_add', { name: name.trim(), config }, getProfile(ctx))
  } catch (err: any) {
    ctx.status = 503
    ctx.body = { error: err.message || 'Failed to add MCP server' }
  }
}

export async function updateServer(ctx: Context) {
  try {
    const name = ctx.params.name as string
    const { config } = (ctx.request.body || {}) as Record<string, unknown>
    if (!name || !isValidServerName(name)) {
      ctx.status = 400
      ctx.body = { error: 'Valid server name is required' }
      return
    }
    if (!config || typeof config !== 'object') {
      ctx.status = 400
      ctx.body = { error: 'config object is required' }
      return
    }
    ctx.body = await bridgeMcpAction('mcp_server_update', { name, config }, getProfile(ctx))
  } catch (err: any) {
    ctx.status = 503
    ctx.body = { error: err.message || 'Failed to update MCP server' }
  }
}

export async function removeServer(ctx: Context) {
  try {
    const name = ctx.params.name as string
    if (!name || !isValidServerName(name)) {
      ctx.status = 400
      ctx.body = { error: 'Valid server name is required' }
      return
    }
    ctx.body = await bridgeMcpAction('mcp_server_remove', { name }, getProfile(ctx))
  } catch (err: any) {
    ctx.status = 503
    ctx.body = { error: err.message || 'Failed to remove MCP server' }
  }
}

/**
 * A real connection test: Hermes connects to the server and lists its tools.
 * The bridge's own check only reads a connection it already holds, so a server
 * that never connected would look fine with no tools; it is the fallback when
 * Hermes's API cannot be reached.
 */
export async function testMcpServerLive(name: string, profile: string | undefined, deps = {
  hermes: (path: string, prof?: string) => hermesApi.request('POST', path, new URLSearchParams(), {}, prof),
  bridge: (prof?: string) => bridgeMcpAction('mcp_server_test', { name }, prof),
}): Promise<{ ok: boolean; tools: string[]; error?: string }> {
  try {
    const result = await deps.hermes(`mcp/servers/${encodeURIComponent(name)}/test`, profile)
    const body = JSON.parse(result.body.toString('utf8') || '{}')
    if (result.status < 400 && typeof body.ok === 'boolean') {
      const tools = Array.isArray(body.tools) ? body.tools.map((tool: any) => typeof tool === 'string' ? tool : String(tool?.name || '')).filter(Boolean) : []
      return body.ok ? { ok: true, tools } : { ok: false, tools, error: String(body.error || 'The server did not answer') }
    }
  } catch { /* Hermes's API unavailable: use the bridge's check */ }
  const fallback = await deps.bridge(profile) as { ok?: boolean; tools?: string[]; error?: string }
  if (fallback?.ok && (!fallback.tools || fallback.tools.length === 0)) {
    return { ok: false, tools: [], error: 'Connected, but the server offered no tools' }
  }
  return { ok: !!fallback?.ok, tools: fallback?.tools || [], ...(fallback?.error ? { error: fallback.error } : {}) }
}

export async function testServer(ctx: Context) {
  try {
    const name = ctx.params.name as string
    if (!name || !isValidServerName(name)) {
      ctx.status = 400
      ctx.body = { error: 'Valid server name is required' }
      return
    }
    ctx.body = await testMcpServerLive(name, getProfile(ctx))
  } catch (err: any) {
    ctx.status = 503
    ctx.body = { error: err.message || 'Failed to test MCP server' }
  }
}

export async function listTools(ctx: Context) {
  try {
    const server = ctx.query.server as string | undefined
    const raw = ctx.query.raw === '1' || ctx.query.raw === 'true'
    const payload: Record<string, any> = {}
    if (server) payload.server = server
    if (raw) payload.raw = true
    ctx.body = await bridgeMcpAction('mcp_tools_list', payload, getProfile(ctx))
  } catch (err: any) {
    ctx.status = 503
    ctx.body = { error: err.message || 'MCP bridge not available' }
  }
}

export async function reloadMcp(ctx: Context) {
  try {
    const server = ctx.query.server as string | undefined
    const payload = server ? { server } : {}
    ctx.body = await bridgeMcpAction('mcp_reload', payload, getProfile(ctx))
  } catch (err: any) {
    ctx.status = 503
    ctx.body = { error: err.message || 'Failed to reload MCP' }
  }
}
