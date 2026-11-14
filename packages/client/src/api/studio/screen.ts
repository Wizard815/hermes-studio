import { getBaseUrl, request } from '../client'

export interface ScreenLease { holder: 'agent' | 'human'; reason: string; since: number; epoch: number; viewer_hash: string | null }
export interface ScreenStatus {
  available: boolean
  supported?: boolean
  installed?: boolean
  running?: boolean
  installing: boolean
  starting: boolean
  missing?: string[]
  blocker?: string | null
  geometry?: string | null
  memory_available_mb?: number | null
  lease?: ScreenLease
  youHaveControl?: boolean
  error: string | null
  log: string[]
}

/** This browser tab's viewer id (control belongs to one tab). */
export function screenClientId(): string {
  try {
    let id = sessionStorage.getItem('studio_screen_viewer')
    if (!id) { id = Math.random().toString(36).slice(2) + Date.now().toString(36); sessionStorage.setItem('studio_screen_viewer', id) }
    return id
  } catch { return 'viewer' }
}

const base = '/api/studio/screen'
const post = <T>(path: string, body: Record<string, unknown> = {}) =>
  request<T>(`${base}${path}`, { method: 'POST', body: JSON.stringify({ clientId: screenClientId(), ...body }) })

export interface BrowserActivity {
  at: number
  kind: string
  summary: string
  url?: string
  outcome: 'done' | 'failed' | 'asked' | 'allowed' | 'refused' | 'stopped'
  sessionId?: string
  agentId?: string
  error?: string
}

export const getBrowserActivity = (limit = 100) => request<{ activity: BrowserActivity[] }>(`${base}/activity?limit=${limit}`)
export const getScreenStatus = () => request<ScreenStatus>(`${base}?clientId=${encodeURIComponent(screenClientId())}`)
export const installScreen = () => post<ScreenStatus>('/install')
export const startScreen = () => post<ScreenStatus>('/start')
export const stopScreen = (force = false) => post<ScreenStatus>('/stop', { force })
export const screenControl = (action: 'take' | 'release' | 'force') => post<{ lease: ScreenLease; youHaveControl: boolean }>('/control', { action })

/** The live view's websocket address, with a fresh single-use ticket. */
export async function screenSocketUrl(): Promise<string> {
  const { ticket } = await post<{ ticket: string }>('/ticket')
  const httpBase = (getBaseUrl() || window.location.origin).replace(/\/+$/, '')
  const url = new URL(`${httpBase}${base}/ws`, window.location.href)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.searchParams.set('ticket', ticket)
  return url.toString()
}
