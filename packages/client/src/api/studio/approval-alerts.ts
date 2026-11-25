import { request } from '../client'
import type { ApprovalAlertPrefs, ApprovalDevice } from '../../../../shared/approval-alerts'

/** Where approvals reach you and paired phones (docs/approval-alerts.md). */
const base = '/api/studio/approval-alerts'

export interface ApprovalAlertsStatus {
  prefs: ApprovalAlertPrefs
  devices: ApprovalDevice[]
  /** Agent work's Mattermost channel, and whether its posts get buttons. */
  mattermost: { channel: string; buttons: boolean }
}

export interface PairingCode { code: string; expiresAt: number }

export const fetchApprovalAlerts = () => request<ApprovalAlertsStatus>(base)
export const saveApprovalAlertPrefs = (prefs: Partial<ApprovalAlertPrefs>) =>
  request<{ prefs: ApprovalAlertPrefs }>(`${base}/prefs`, { method: 'PUT', body: JSON.stringify({ prefs }) })
export const startPhonePairing = (name = '') =>
  request<PairingCode>(`${base}/pairing`, { method: 'POST', body: JSON.stringify({ name }) })
export const removePhone = (id: string) =>
  request<{ removed: true; devices: ApprovalDevice[] }>(`${base}/devices/${encodeURIComponent(id)}`, { method: 'DELETE' })
export const sendTestAlert = () => request<{ connected: number }>(`${base}/test`, { method: 'POST', body: '{}' })

/**
 * The link the QR code carries: the phone's camera opens it in Studio Own,
 * which pairs with this server. `server` is this page's address.
 */
export function pairingLink(server: string, code: string): string {
  return `studio-own://pair?server=${encodeURIComponent(server.replace(/\/+$/, ''))}&code=${encodeURIComponent(code)}`
}

/** Studio Own's approval alerts, when this page runs inside the app (packages/android). */
export interface StudioOwnAlertsState {
  paired: boolean
  deviceName: string
  /** live: a stream with a quiet notification; saver: a check every 15 minutes; off. */
  mode: 'live' | 'saver' | 'off'
  /** Android's notification permission for the app. */
  notifications: 'granted' | 'denied'
  /** Battery optimisation is off for the app (the stream survives Doze). */
  unrestricted: boolean
  message?: string
}

export interface StudioOwnAlertsBridge {
  status(): void
  pair(code: string, name: string): void
  setMode(mode: 'live' | 'saver' | 'off'): void
  unpair(): void
  openBatterySettings(): void
}

export function studioOwnAlerts(): StudioOwnAlertsBridge | null {
  const bridge = (window as unknown as { StudioOwn?: { approvalAlerts?: StudioOwnAlertsBridge } }).StudioOwn?.approvalAlerts
  return bridge && typeof bridge.pair === 'function' ? bridge : null
}

export const STUDIO_OWN_ALERTS_EVENT = 'studio-own:alerts'
