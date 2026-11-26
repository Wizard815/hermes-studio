import { request } from '../client'

export type ChatImportKind = 'hermes' | 'claude-code' | 'codex' | 'openclaw'

export interface ChatImportCandidate {
  key: string
  kind: ChatImportKind
  originalId: string
  title: string
  startedAt: number
  lastActive: number
  messageCount: number
  cwd: string | null
  model: string
  sourceProfile?: string
  existingSessionId: string | null
  cwdExists: boolean
  resumable: boolean
  skipReason: 'empty' | 'too_large' | 'unreadable' | null
}

export interface ChatImportScan {
  id: string
  label: string
  upload: boolean
  createdAt: number
  candidates: ChatImportCandidate[]
  truncated: boolean
  counts: Record<ChatImportKind, number>
  skippedFiles: number
  errors: string[]
}

export interface ChatImportResultItem {
  key: string
  title: string
  kind: ChatImportKind
  sessionId?: string
  reason?: string
}

export interface ChatImportJob {
  id: string
  scanId: string
  status: 'running' | 'done' | 'failed'
  total: number
  done: number
  imported: ChatImportResultItem[]
  skipped: ChatImportResultItem[]
  failed: ChatImportResultItem[]
  error?: string
}

export function scanChatImportPath(path: string): Promise<ChatImportScan> {
  return request('/api/studio/chat-import/scan', { method: 'POST', body: JSON.stringify({ path }) })
}

export function uploadChatImportArchive(file: File): Promise<ChatImportScan> {
  return request(`/api/studio/chat-import/upload?name=${encodeURIComponent(file.name)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: file,
  })
}

export function discardChatImportScan(id: string): Promise<{ ok: boolean }> {
  return request(`/api/studio/chat-import/scans/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export function startChatImport(id: string, input: { keys: string[]; profile: string; categoryId: number | null }): Promise<ChatImportJob> {
  return request(`/api/studio/chat-import/scans/${encodeURIComponent(id)}/import`, { method: 'POST', body: JSON.stringify(input) })
}

export function fetchChatImportJob(id: string): Promise<ChatImportJob> {
  return request(`/api/studio/chat-import/jobs/${encodeURIComponent(id)}`)
}
