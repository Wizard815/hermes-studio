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
}

const base = '/api/studio/sandbox'

export const fetchSandboxes = () => request<{ sandboxes: SandboxSummary[] }>(base)
export const removeSandbox = (id: string) => request<{ sandbox: string; removed: boolean }>(`${base}/${encodeURIComponent(id)}`, { method: 'DELETE' })
