/**
 * API client for the Headless Browser Service
 * 
 * All methods call REST endpoints exposed by the server-side browser controller.
 * Screenshot events arrive via Socket.IO broadcast 'browser.screenshot'.
 */

import { getBaseUrlValue } from '@/api/client'

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

// ─── Status ─────────────────────────────────────────────────────

let _headlessAvailable: boolean | null = null

export async function fetchHeadlessBrowserStatus(): Promise<{ available: boolean; stats?: any }> {
  if (_headlessAvailable !== null) return { available: _headlessAvailable }
  
  try {
    const resp = await fetch(`${getBaseUrlValue()}/api/studio/browser/status`)
    const body = await resp.json()
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
  const resp = await fetch(`${getBaseUrlValue()}/api/studio/browser/state`)
  const body = await resp.json()
  return { ...body, tabs: body.tabs || [] }
}

export async function createBrowserTab(options?: { url?: string; activate?: boolean }): Promise<BrowserTabInfo> {
  const resp = await fetch(`${getBaseUrlValue()}/api/studio/browser/tabs/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: options?.url, activate: options?.activate ?? true }),
  })
  return await resp.json()
}

export async function activateBrowserTab(tabId: string): Promise<void> {
  await fetch(`${getBaseUrlValue()}/api/studio/browser/tabs/activate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tab_id: tabId }),
  })
}

export async function closeBrowserTab(tabId: string): Promise<void> {
  await fetch(`${getBaseUrlValue()}/api/studio/browser/tabs/close`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tab_id: tabId }),
  })
}

// ─── Navigation ─────────────────────────────────────────────────

export async function navigateToUrl(tabId: string, url: string): Promise<BrowserTabInfo> {
  const resp = await fetch(`${getBaseUrlValue()}/api/studio/browser/navigate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tab_id: tabId, url }),
  })
  return await resp.json()
}

export async function performNavigationAction(tabId: string, action: 'back' | 'forward' | 'reload' | 'stop'): Promise<BrowserTabInfo> {
  const resp = await fetch(`${getBaseUrlValue()}/api/studio/browser/navigation-action`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tab_id: tabId, action }),
  })
  return await resp.json()
}

// ─── Content Reading ────────────────────────────────────────────

export async function takeSnapshot(tabId: string): Promise<SnapshotResult> {
  const resp = await fetch(`${getBaseUrlValue()}/api/studio/browser/snapshot`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tab_id: tabId }),
  })
  return await resp.json()
}

export async function readTextFromRef(tabId: string, ref: string, options?: { mode?: string; offset?: number; limit?: number }): Promise<any> {
  const resp = await fetch(`${getBaseUrlValue()}/api/studio/browser/text-read`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tab_id: tabId, ref, ...options }),
  })
  return await resp.json()
}

// ─── Interaction ────────────────────────────────────────────────

export async function interactWithElement(
  tabId: string,
  action: { type: string; [key: string]: any }
): Promise<any> {
  const resp = await fetch(`${getBaseUrlValue()}/api/studio/browser/interact`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tab_id: tabId, action }),
  })
  return await resp.json()
}

// ─── Screenshot ─────────────────────────────────────────────────

export async function captureScreenshot(tabId: string, fullPage?: boolean): Promise<BrowserScreenshotResult> {
  const resp = await fetch(`${getBaseUrlValue()}/api/studio/browser/screenshot`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tab_id: tabId, full_page: !!fullPage }),
  })
  return await resp.json()
}

// ─── Console ────────────────────────────────────────────────────

export async function readConsoleLogs(tabId: string): Promise<Array<{ message: string; source: string; timestamp: number }>> {
  const resp = await fetch(`${getBaseUrlValue()}/api/studio/browser/console-read`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tab_id: tabId }),
  })
  return await resp.json()
}

export async function clearConsoleLogs(tabId: string): Promise<void> {
  await fetch(`${getBaseUrlValue()}/api/studio/browser/console-clear`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tab_id: tabId }),
  })
}

// ─── Lease Management ───────────────────────────────────────────

export async function releaseLease(tabId: string): Promise<void> {
  await fetch(`${getBaseUrlValue()}/api/studio/browser/lease/release`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tab_id: tabId }),
  })
}
