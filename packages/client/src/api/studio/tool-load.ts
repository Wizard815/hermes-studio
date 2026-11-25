import { request } from '../client'
import { toToolSearchSetting, type ToolLoadNotice, type ToolLoadSettings, type ToolSearchSetting } from '../../../../shared/tool-load'

/** Too many tools for a small model (docs/hermes-tool-load.md). */
const base = '/api/studio/tool-load'
const chat = (id: string) => `${base}/chats/${encodeURIComponent(id)}`

export const fetchToolLoadSettings = () => request<{ settings: ToolLoadSettings }>(base)
export const saveToolLoadSettings = (settings: Partial<ToolLoadSettings>) =>
  request<{ settings: ToolLoadSettings }>(base, { method: 'PUT', body: JSON.stringify({ settings }) })
export const fetchChatToolLoad = (sessionId: string) => request<{ notice: ToolLoadNotice | null }>(chat(sessionId))
export const dismissChatToolLoad = (sessionId: string) =>
  request<{ notice: ToolLoadNotice | null }>(`${chat(sessionId)}/dismiss`, { method: 'POST', body: '{}' })

const profileHeaders = (profile?: string) => profile ? { 'X-Hermes-Profile': profile } : undefined

/** Hermes's tool search for a profile: config.yaml `tools.tool_search.enabled`. */
export async function fetchHermesToolSearch(profile?: string): Promise<ToolSearchSetting> {
  const result = await request<{ tools?: { tool_search?: unknown } }>('/api/hermes/config?section=tools', { headers: profileHeaders(profile) })
  const raw = result?.tools?.tool_search
  return toToolSearchSetting(raw && typeof raw === 'object' ? (raw as Record<string, unknown>).enabled : raw)
}

export async function saveHermesToolSearch(enabled: ToolSearchSetting, profile?: string): Promise<void> {
  await request('/api/hermes/config', {
    method: 'PUT',
    headers: profileHeaders(profile),
    body: JSON.stringify({ section: 'tools', values: { tool_search: { enabled } } }),
  })
}
