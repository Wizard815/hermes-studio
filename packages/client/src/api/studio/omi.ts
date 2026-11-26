import { request } from '../client'
import type { OrbWork } from './orb'

/** A Studio key made for Omi; the key itself is only in createOmiKey's answer. */
export interface OmiKey {
  id: string
  name: string
  preview: string
  userId: number
  createdAt: number
  lastUsedAt: number | null
}

export interface OmiStatus {
  settings: { url: string; webUrl: string; profile: string }
  keys: OmiKey[]
  webhook: {
    registered: boolean
    url: string
    enabled: boolean
    runtime: { state: string; delivered: number; failed: number; last_error: string | null; last_success_at: number | null } | null
  }
  mcpUrl: string
}

const base = '/api/studio/omi'

export const fetchOmiStatus = () => request<OmiStatus>(base)

export const saveOmiSettings = (input: { url?: string; webUrl?: string; profile?: string }) =>
  request<OmiStatus>(`${base}/settings`, { method: 'PUT', body: JSON.stringify(input) })

export const testOmi = () => request<{ ok: boolean; detail: string; error: string }>(`${base}/test`, { method: 'POST' })

export const createOmiKey = (name: string) =>
  request<{ key: OmiKey; apiKey: string }>(`${base}/keys`, { method: 'POST', body: JSON.stringify({ name }) })

export const revokeOmiKey = (id: string) => request<{ revoked: true }>(`${base}/keys/${encodeURIComponent(id)}`, { method: 'DELETE' })

export const registerOmiWebhook = () => request<{ status: OmiStatus; secret: string }>(`${base}/webhook`, { method: 'POST' })

export const removeOmiWebhook = () => request<OmiStatus>(`${base}/webhook`, { method: 'DELETE' })

export const installOmiSkill = (profile: string) =>
  request<{ profile: string; path: string }>(`${base}/hermes-skill`, { method: 'POST', body: JSON.stringify({ profile }) })

export const fetchOmiWork = () => request<{ work: OrbWork[] }>(`${base}/work`)
