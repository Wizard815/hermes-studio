import { request } from '../client'

/**
 * Hermes Agent's own API, through Studio (super administrators). `path` is the
 * Hermes API path after /api/ (e.g. 'memory', 'messaging/platforms'). Studio
 * adds the active profile and starts Hermes's API on first use.
 */
export function hermesAgent<T = any>(path: string, init: { method?: string; body?: unknown; query?: Record<string, string | number | boolean | undefined> } = {}): Promise<T> {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(init.query || {})) if (value !== undefined) params.set(key, String(value))
  const search = params.toString()
  return request<T>(`/api/hermes-agent/${path.replace(/^\/+/, '')}${search ? `?${search}` : ''}`, {
    method: init.method || 'GET',
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  })
}

export interface HermesAgentBridgeStatus { available: boolean; running: boolean; starting: boolean; error: string | null; version: string | null; log: string[] }
export const getHermesAgentBridge = () => request<HermesAgentBridgeStatus>('/api/hermes-agent-bridge')
export const startHermesAgentBridge = () => request<HermesAgentBridgeStatus>('/api/hermes-agent-bridge/start', { method: 'POST' })
