/**
 * API client for the Headless Browser Service
 * 
 * All methods call REST endpoints exposed by the server-side browser controller.
 * Screenshot events arrive via Socket.IO broadcast 'browser.screenshot'.
 */

import { getApiKey, getBaseUrlValue } from '@/api/client'

// ─── State & Types ──────────────────────────────────────────────

export interface BrowserTabInfo {
  id: string
  title: string
  url: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  crashed: boolean
  agentControl: 'idle' | 'active' | 'waiting-for-user'
}

export interface BrowserState {
  activeTabId?: string
  maxTabs: number
  tabs: BrowserTabInfo[]
}

export interface BrowserScreenshotResult {
  data: string          // base64 JPEG
  mimeType: string
  tabId: string
}

export interface SnapshotNode {
  ref: string
  role: string
  name: string
  value?: string
  description?: string
  disabled?: boolean
  focused?: boolean
}

export interface SnapshotResult {
  tabId: string
  snapshotId: string
  url: string
  title: string
  nodes: SnapshotNode[]
  text: string
}

// ─── Helpers ────────────────────────────────────────────────────

function authHeaders(): Record<string, string> {
  const token = getApiKey()
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token) headers['Authorization'] = `Bearer ${token}`
  return headers
}

async function fetchJson(url: string, options?: RequestInit): Promise<any> {
  const resp = await fetch(url, {
    ...options,
    headers: { ...authHeaders(), ...(options?.headers as Record<string, string> || {}) },
  })
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({}))
    throw new Error(body.error || `HTTP ${resp.status}`)
  }
  return resp.json()
}

// ─── Status ─────────────────────────────────────────────────────

let _headlessAvailable: boolean | null = null

export async function fetchHeadlessBrowserStatus(): Promise<{ available: boolean; stats?: any }> {
  if (_headlessAvailable !== null) return { available: _headlessAvailable }
  
  try {
    const body = await fetchJson(`${getBaseUrlValue()}/api/studio/browser/status`)
    _headlessAvailable = !!body.available
    return { available: _headlessAvailable, stats: body.stats }
  } catch {
    _headlessAvailable = false
    return { available: false }
  }
}

/** Check if headless browser service is available */
export async function isHeadlessBrowserAvailable(): Promise<boolean> {
  const result = await fetchHeadlessBrowserStatus()
  return result.available
}

// ─── Tabs ───────────────────────────────────────────────────────

export async function fetchBrowserState(): Promise<BrowserState> {
  const body = await fetchJson(`${getBaseUrlValue()}/api/studio/browser/state`)
  return { ...body, tabs: body.tabs || [] }
}

export async function createBrowserTab(options?: { url?: string; activate?: boolean }): Promise<BrowserTabInfo> {
  return fetchJson(`${getBaseUrlValue()}/api/studio/browser/tabs/create`, {
    method: 'POST',
    body: JSON.stringify({ url: options?.url, activate: options?.activate ?? true }),
  })
}

export async function activateBrowserTab(tabId: string): Promise<void> {
  await fetchJson(`${getBaseUrlValue()}/api/studio/browser/tabs/activate`, {
    method: 'POST',
    body: JSON.stringify({ tab_id: tabId }),
  })
}

export async function closeBrowserTab(tabId: string): Promise<void> {
  await fetchJson(`${getBaseUrlValue()}/api/studio/browser/tabs/close`, {
    method: 'POST',
    body: JSON.stringify({ tab_id: tabId }),
  })
}

// ─── Navigation ─────────────────────────────────────────────────

export async function navigateToUrl(tabId: string, url: string): Promise<BrowserTabInfo> {
  return fetchJson(`${getBaseUrlValue()}/api/studio/browser/navigate`, {
    method: 'POST',
    body: JSON.stringify({ tab_id: tabId, url }),
  })
}

export async function performNavigationAction(tabId: string, action: 'back' | 'forward' | 'reload' | 'stop'): Promise<BrowserTabInfo> {
  return fetchJson(`${getBaseUrlValue()}/api/studio/browser/navigation-action`, {
    method: 'POST',
    body: JSON.stringify({ tab_id: tabId, action }),
  })
}

// ─── Content Reading ────────────────────────────────────────────

export async function takeSnapshot(tabId: string): Promise<SnapshotResult> {
  return fetchJson(`${getBaseUrlValue()}/api/studio/browser/snapshot`, {
    method: 'POST',
    body: JSON.stringify({ tab_id: tabId }),
  })
}

export async function readTextFromRef(tabId: string, ref: string, options?: { mode?: string; offset?: number; limit?: number }): Promise<any> {
  return fetchJson(`${getBaseUrlValue()}/api/studio/browser/text-read`, {
    method: 'POST',
    body: JSON.stringify({ tab_id: tabId, ref, ...options }),
  })
}

// ─── Interaction ────────────────────────────────────────────────

export async function interactWithElement(
  tabId: string,
  action: { type: string; [key: string]: any }
): Promise<any> {
  return fetchJson(`${getBaseUrlValue()}/api/studio/browser/interact`, {
    method: 'POST',
    body: JSON.stringify({ tab_id: tabId, action }),
  })
}

// ─── Screenshot ─────────────────────────────────────────────────

export async function captureScreenshot(tabId: string, fullPage?: boolean): Promise<BrowserScreenshotResult> {
  return fetchJson(`${getBaseUrlValue()}/api/studio/browser/screenshot`, {
    method: 'POST',
    body: JSON.stringify({ tab_id: tabId, full_page: !!fullPage }),
  })
}

// ─── Manual Input (coordinate-based live view control) ──────────

export interface ViewportInfo {
  width: number
  height: number
  scrollX: number
  scrollY: number
  scrollWidth: number
  scrollHeight: number
}

export interface ManualInputResult {
  tab: BrowserTabInfo
  viewport: ViewportInfo
}

export async function sendManualInput(
  tabId: string,
  action: { type: string; [key: string]: any },
): Promise<ManualInputResult> {
  return fetchJson(`${getBaseUrlValue()}/api/studio/browser/input`, {
    method: 'POST',
    body: JSON.stringify({ tab_id: tabId, action }),
  })
}

export async function fetchViewportInfo(tabId: string): Promise<ViewportInfo> {
  return fetchJson(`${getBaseUrlValue()}/api/studio/browser/viewport`, {
    method: 'POST',
    body: JSON.stringify({ tab_id: tabId }),
  })
}

// ─── Persistent Screenshot Store (server-side, per chat session) ─

export interface StoredScreenshot {
  id: string
  sessionId: string
  tabId: string
  timestamp: number
  mimeType: string
  url?: string
  title?: string
}

export async function listStoredScreenshots(sessionId: string): Promise<StoredScreenshot[]> {
  const body = await fetchJson(
    `${getBaseUrlValue()}/api/studio/browser/screenshots?session_id=${encodeURIComponent(sessionId)}`,
  )
  return Array.isArray(body?.screenshots) ? body.screenshots : []
}

export async function storeScreenshot(
  sessionId: string,
  data: string,
  options?: { tabId?: string; url?: string; title?: string; mimeType?: string },
): Promise<StoredScreenshot | null> {
  const body = await fetchJson(`${getBaseUrlValue()}/api/studio/browser/screenshots`, {
    method: 'POST',
    body: JSON.stringify({
      session_id: sessionId,
      data,
      tab_id: options?.tabId,
      url: options?.url,
      title: options?.title,
      mime_type: options?.mimeType,
    }),
  })
  return body?.screenshot || null
}

export function storedScreenshotUrl(sessionId: string, id: string): string {
  // <img> tags cannot send an Authorization header, so authenticate the image
  // request with the query token the auth middleware already accepts.
  const token = getApiKey()
  const params = new URLSearchParams({ session_id: sessionId })
  if (token) params.set('token', token)
  return `${getBaseUrlValue()}/api/studio/browser/screenshots/${encodeURIComponent(id)}?${params.toString()}`
}

export async function deleteStoredScreenshot(sessionId: string, id: string): Promise<void> {
  await fetchJson(
    `${getBaseUrlValue()}/api/studio/browser/screenshots/${encodeURIComponent(id)}?session_id=${encodeURIComponent(sessionId)}`,
    { method: 'DELETE' },
  )
}

// ─── Console ────────────────────────────────────────────────────

export async function readConsoleLogs(tabId: string): Promise<Array<{ message: string; source: string; timestamp: number }>> {
  return fetchJson(`${getBaseUrlValue()}/api/studio/browser/console-read`, {
    method: 'POST',
    body: JSON.stringify({ tab_id: tabId }),
  })
}

export async function clearConsoleLogs(tabId: string): Promise<void> {
  await fetchJson(`${getBaseUrlValue()}/api/studio/browser/console-clear`, {
    method: 'POST',
    body: JSON.stringify({ tab_id: tabId }),
  })
}

// ─── Lease Management ───────────────────────────────────────────

export async function releaseLease(tabId: string): Promise<void> {
  await fetchJson(`${getBaseUrlValue()}/api/studio/browser/lease/release`, {
    method: 'POST',
    body: JSON.stringify({ tab_id: tabId }),
  })
}
