import { request } from '../client'

/** Sandboxes (docs/sandbox.md): throwaway containers agents make on the Studio machine. */

export interface SandboxSummary {
  id: string
  image: string
  imageId: string
  network: 'internet' | 'none'
  purpose: string
  createdAt: number
  expiresAt: number
  /** Docker's state: running, exited… or gone when the container no longer exists. */
  state: string
  repos: string[]
  /** Sites this sandbox may reach besides the allowlist. */
  allow: string[]
}

const base = '/api/studio/sandbox'

export const fetchSandboxes = () => request<{ sandboxes: SandboxSummary[] }>(base)
export const removeSandbox = (id: string) => request<{ sandbox: string; removed: boolean }>(`${base}/${encodeURIComponent(id)}`, { method: 'DELETE' })

/** What sandboxes with internet may reach through Studio's proxy (docs/sandbox.md). */
export interface EgressRules {
  mode: 'allowlist' | 'blocklist' | 'log'
  allow: string[]
  block: string[]
}

export interface EgressCall {
  time: number
  sandbox: string
  ip: string
  method: string
  host: string
  port: number
  allowed: boolean
  result: string
  bytesOut: number
  bytesIn: number
}

export const fetchEgressRules = () => request<{ rules: EgressRules }>(`${base}/egress`)
export const saveEgressRules = (rules: Partial<EgressRules> & { reset?: boolean }) => request<{ rules: EgressRules }>(`${base}/egress`, { method: 'PUT', body: JSON.stringify(rules) })
export const fetchNetworkLog = (opts: { sandbox?: string; blocked?: boolean; limit?: number } = {}) => {
  const q = new URLSearchParams()
  if (opts.sandbox) q.set('sandbox', opts.sandbox)
  if (opts.blocked) q.set('blocked', '1')
  if (opts.limit) q.set('limit', String(opts.limit))
  const qs = q.toString()
  return request<{ rules: EgressRules; calls: EgressCall[] }>(`${base}/network-log${qs ? `?${qs}` : ''}`)
}
