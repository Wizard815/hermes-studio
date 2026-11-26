import { getBaseUrl, request } from '../client'

export interface VsCodeStatus {
  available: boolean
  source: 'studio' | 'env' | 'path' | null
  version: string | null
  running: boolean
  installing: boolean
  problem: string | null
  error: string | null
  log: string[]
}

export function getVsCodeStatus() { return request<VsCodeStatus>('/api/vscode') }
export function installVsCode() { return request<VsCodeStatus>('/api/vscode/install', { method: 'POST' }) }
export function openVsCodeSession() { return request<{ id: string; path: string }>('/api/vscode/session', { method: 'POST' }) }
export function closeVsCodeSession(id: string) { return request<void>(`/api/vscode/session/${encodeURIComponent(id)}`, { method: 'DELETE' }) }

/** The address of VS Code on a folder, for a session path from openVsCodeSession. */
export function vscodeUrl(path: string, folder?: string | null): string {
  return `${getBaseUrl()}${path}${folder ? `?folder=${encodeURIComponent(folder)}` : ''}`
}
