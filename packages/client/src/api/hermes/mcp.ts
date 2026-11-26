import { request } from '../client'

export interface McpServerInfo {
  name: string
  transport: 'stdio' | 'http' | 'sse'
  connected: boolean
  tools: number
  tools_registered: number
  tool_names: string[]
  tool_names_registered: string[]
  tool_details: Array<{ name: string; description?: string }>
  error?: string | null
  raw_config: McpServerConfig
}

export interface McpServersResponse {
  ok: boolean
  servers: McpServerInfo[]
  total_tools: number
  error?: string
}

export interface McpToolsResponse {
  ok: boolean
  results: Array<{
    server: string
    tools: Array<{
      name: string
      description: string
      input_schema: Record<string, unknown>
    }>
  }>
  error?: string
}

export interface McpServerConfig {
  command?: string
  args?: string[]
  url?: string
  env?: Record<string, string>
  headers?: Record<string, string>
  timeout?: number
  connect_timeout?: number
  enabled?: boolean
  transport?: 'stdio' | 'http' | 'sse'
  /** Hermes signs in to this server with OAuth (MCP page: Sign in). */
  auth?: 'oauth'
  tools?: { include?: string[]; exclude?: string[] }
  prompts?: boolean
  resources?: boolean
}

export async function fetchMcpServers(): Promise<McpServersResponse> {
  return request<McpServersResponse>('/api/hermes/mcp/servers')
}

export async function fetchMcpTools(server?: string, raw?: boolean): Promise<McpToolsResponse> {
  const params = new URLSearchParams()
  if (server) params.set('server', server)
  if (raw) params.set('raw', '1')
  const query = params.toString() ? `?${params.toString()}` : ''
  return request<McpToolsResponse>(`/api/hermes/mcp/tools${query}`)
}

export async function mcpServerAdd(name: string, config: McpServerConfig): Promise<{ ok: boolean; name?: string; error?: string }> {
  return request('/api/hermes/mcp/servers', {
    method: 'POST',
    body: JSON.stringify({ name, config }),
  })
}

export async function mcpServerRemove(name: string): Promise<{ ok: boolean; error?: string }> {
  return request(`/api/hermes/mcp/servers/${encodeURIComponent(name)}`, {
    method: 'DELETE',
  })
}

export async function mcpServerUpdate(name: string, config: McpServerConfig): Promise<{ ok: boolean; error?: string }> {
  return request(`/api/hermes/mcp/servers/${encodeURIComponent(name)}`, {
    method: 'PATCH',
    body: JSON.stringify({ config }),
  })
}

export async function mcpReload(name?: string): Promise<{ ok: boolean; message?: string; error?: string }> {
  const query = name ? `?server=${encodeURIComponent(name)}` : ''
  return request(`/api/hermes/mcp/reload${query}`, { method: 'POST' })
}

export async function mcpServerTest(name: string): Promise<{ ok: boolean; tools?: string[]; error?: string }> {
  return request(`/api/hermes/mcp/servers/${encodeURIComponent(name)}/test`, { method: 'POST' })
}

/** Studio's SSH key for Home Assistant's SSH add-on (made once): the private key file and its public line. */
export async function homeAssistantSshKey(): Promise<{ keyPath: string; publicKey: string; created: boolean }> {
  return request('/api/hermes/mcp/home-assistant/ssh-key', { method: 'POST' })
}

/**
 * Add a server whose token or API key must stay secret: Studio writes each
 * secret to the profile's .env and the config only refers to it as ${KEY}.
 */
export async function mcpServerAddWithSecrets(name: string, config: McpServerConfig, secrets: Record<string, string>): Promise<{ ok: boolean; name?: string; error?: string }> {
  return request('/api/hermes/mcp/servers', {
    method: 'POST',
    body: JSON.stringify({ name, config, ...(Object.keys(secrets).length ? { secrets } : {}) }),
  })
}
