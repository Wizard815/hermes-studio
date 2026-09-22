/**
 * Headless Browser Service
 * 
 * Manages a Playwright Chromium instance for AI agent browser automation
 * and live UI viewing. Provides the same API contract as the Electron Desktop
 * BrowserBroker so existing MCP tools work without modification.
 */

import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { mkdirSync, writeFileSync, renameSync as fsRenameSync, unlinkSync as fsUnlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { BrowserContext, Page } from 'playwright'
import { chromium } from 'playwright'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BrowserTab {
  id: string
  page: Page
  title: string
  url: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  crashed: boolean
  tabGeneration: number
}

interface Lease {
  clientId: string
  expiresAt: number
}

interface BrokerClient {
  token: string
  lastSeenAt: number
}

interface SessionSnapshot {
  tabId: string
  snapshotId: string
  url: string
  title: string
  nodes: BrowserSnapshotNode[]
  text: string
}

interface BrowserSnapshotNode {
  ref: string
  role: string
  name: string
  value?: string
  description?: string
  disabled?: boolean
  focused?: boolean
}

export interface PublicState {
  activeTabId?: string
  maxTabs: number
  tabs: Array<{
    id: string
    title: string
    url: string
    loading: boolean
    canGoBack: boolean
    canGoForward: boolean
    crashed: boolean
    agentControl: 'idle' | 'active' | 'waiting-for-user'
  }>
}

interface SnapshotResult {
  tabId: string
  snapshotId: string
  url: string
  title: string
  nodes: BrowserSnapshotNode[]
  text: string
}

type InteractAction =
  | { action: 'click'; ref: string; snapshotId: string }
  | { action: 'type'; ref: string; snapshotId: string; text: string }
  | { action: 'press'; key: string }
  | { action: 'scroll'; direction: 'up' | 'down' | 'left' | 'right'; pixels?: number }

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MAX_TABS = 8
const BODY_LIMIT = 1024 * 1024
const LEASE_TTL_MS = 60_000
const CLIENT_INACTIVE_THRESHOLD_MS = 24 * 60 * 60 * 1000
const MAX_SNAPSHOT_NODES = 300
const MAX_SNAPSHOT_TEXT = 24_000

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function publicBrowserUrl(url: string): string {
  try {
    const parsed = new URL(url)
    if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') {
      const host = parsed.hostname === 'localhost' ? '127.0.0.1' : parsed.hostname
      return `${parsed.protocol}//${host}${parsed.port !== '' ? ':' + parsed.port : ''}${parsed.pathname}${parsed.search}`
    }
    // External URLs — redact query params for privacy
    return `${parsed.protocol}//${parsed.hostname}${parsed.pathname}${parsed.search ? '?[redacted]' : ''}`
  } catch {
    return url.slice(0, 500)
  }
}

function sanitizeString(value: string, maxLength: number): string {
  if (!value) return ''
  return value.replace(/\s+/g, ' ').trim().slice(0, maxLength)
}

// Transform Playwright accessibility tree to Hermes snapshot format
function buildSnapshot(page: Page, tabId: string): Promise<SnapshotResult> {
  return new Promise((resolve, reject) => {
    page.accessibility
      .snapshot({ interesting_only: false })
      .then((axSnapshot: any) => {
        if (!axSnapshot) {
          resolve({ tabId, snapshotId: '', url: '', title: '', nodes: [], text: '' })
          return
        }
        const nodes: BrowserSnapshotNode[] = []
        function walk(node: any, index: number): number {
          if (!node || node.role === 'none' && !node.name && !node.value) return index
          if (index >= MAX_SNAPSHOT_NODES) return index

          const sanitizedRole = sanitizeString(node.role || 'generic', 80)
          if (sanitizedRole === 'none' && !node.name) return index

          const n: BrowserSnapshotNode = {
            ref: `@e${index}`,
            role: sanitizedRole,
            name: sanitizeString(node.name || node.textContent || '', 500),
            ...(node.value != null ? { value: sanitizeString(String(node.value), 500) } : {}),
            ...(node.description ? { description: sanitizeString(node.description, 200) } : {}),
            ...(node.disabled ? { disabled: true } : {}),
            ...(node.focused ? { focused: true } : {}),
          }

          if (node.properties?.find((p: any) => p.name === 'protected')) {
            n.value = '[protected]'
          }

          nodes.push(n)
          index++

          if (node.children) {
            for (const child of node.children) {
              index = walk(child, index)
            }
          }
          return index
        }

        let idx = 0
        idx = walk(axSnapshot, idx)

        // Deduplicate by ref
        const seenRefs = new Set<string>()
        const uniqueNodes: BrowserSnapshotNode[] = []
        for (const n of nodes) {
          if (!seenRefs.has(n.ref)) {
            seenRefs.add(n.ref)
            uniqueNodes.push(n)
          }
        }

        const textLines = uniqueNodes.map(n => {
          let line = `${n.ref} ${n.role}`
          if (n.name) line += ` name="${n.name}"`
          if (n.value) line += ` value="${n.value}"`
          return line
        }).join('\n')

        resolve({
          tabId,
          snapshotId: randomUUID(),
          url: publicBrowserUrl(page.url()),
          title: sanitizeString(page.title() || '', 500),
          nodes: uniqueNodes.slice(0, MAX_SNAPSHOT_NODES),
          text: textLines.slice(0, MAX_SNAPSHOT_TEXT),
        })
      })
      .catch(reject)
  })
}

// Find element by @ref in accessibility tree and click/type on it
async function findElementByRef(page: Page, ref: string): Promise<any> {
  const axSnapshot = await page.accessibility.snapshot({ interesting_only: false })
  const prefix = ref.replace(/^@/, '')
  
  function find(node: any): any {
    if (!node) return null
    const numStr = ref.replace(/^@e/, '')
    const idx = parseInt(prefix) - 1
    // Walk the tree to find the nth accessible node
    return walkFind(node, 0, idx)
  }
  
  function walkFind(node: any, current: number, target: number): any {
    if (!node) return null
    if (current === target) return node
    
    let count = 0
    for (const child of (node.children || [])) {
      const found = walkFind(child, current + 1 + count, target)
      if (found) return found
      count += countChildren(child)
    }
    return null
  }
  
  function countChildren(node: any): number {
    if (!node) return 0
    if (!node.children) return 0
    let total = 0
    for (const c of node.children) {
      total += 1 + countChildren(c)
    }
    return total
  }
  
  return find(axSnapshot)
}

// ---------------------------------------------------------------------------
// HeadlessBrowserService
// ---------------------------------------------------------------------------

export class HeadlessBrowserService {
  private browser: ReturnType<typeof chromium> | null = null
  private context: BrowserContext | null = null
  private tabs: Map<string, BrowserTab> = new Map()
  private activeTabId: string | null = null
  
  private masterToken = ''
  private descriptor: any = null
  private leases = new Map<string, Lease>()
  private leaseTimers = new Map<string, NodeJS.Timeout>()
  private clients = new Map<string, BrokerClient>()
  private readonly queuedOps = new Map<string, Promise<void>>()
  private concurrentOps = 0
  private capacityWaiters: Array<() => void> = []
  
  private brokerRoot: string
  private onScreenshotCapture?: (base64: string, tabId: string) => void

  constructor(options?: { brokerRoot?: string }) {
    this.brokerRoot = options?.brokerRoot || join(process.env.HOME || '/home/codebox', '.hermes-web-ui', 'desktop-browser')
  }

  setOnScreenshotCapture(fn: (base64: string, tabId: string) => void): void {
    this.onScreenshotCapture = fn
  }

  async start(): Promise<any> {
    if (this.browser) return this.descriptor
    if (this.tabs.size > 0) return this.descriptor // already started

    this.masterToken = randomBytes(32).toString('base64url')
    this.instanceId = randomUUID()

    // Launch browser
    this.browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ],
    })

    this.context = await this.browser.createBrowserContext({
      viewport: { width: 1280, height: 720 },
    })

    // Auto-create first empty tab
    await this._createTab(null, false)

    // Write broker.json so existing MCP client can discover us
    await this._writeDescriptor()

    return this.descriptor
  }

  instanceId: string = ''

  async stop(): Promise<void> {
    // Clear all lease timers
    for (const timer of this.leaseTimers.values()) {
      clearTimeout(timer)
    }
    this.leaseTimers.clear()
    this.leases.clear()
    this.clients.clear()
    this.queuedOps.clear()
    
    // Close all tabs
    for (const tab of this.tabs.values()) {
      await tab.page.close().catch(() => {})
    }
    this.tabs.clear()
    this.activeTabId = null

    // Close context and browser
    if (this.context) {
      await this.context.close().catch(() => {})
      this.context = null
    }
    if (this.browser) {
      await this.browser.close().catch(() => {})
      this.browser = null
    }
  }

  getDescriptor(): any {
    return this.descriptor
  }

  getActiveTab(): BrowserTab | null {
    return this.activeTabId ? this.tabs.get(this.activeTabId) ?? null : null
  }

  getAllTabs(): BrowserTab[] {
    return Array.from(this.tabs.values())
  }

  async handleSessionRequest(body: any, authorizationHeader: string): Promise<{ status: number; body: any }> {
    // Layer 1 auth: master token check
    const expected = `Bearer ${this.masterToken}`
    if (!authorizationHeader || authorizationHeader !== expected) {
      return { status: 401, body: { error: 'Unauthorized' } }
    }

    // Validate client_pid
    const pid = typeof body.client_pid === 'number' ? body.client_pid : 0
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      return { status: 400, body: { error: 'client_pid is required' } }
    }

    const clientId = randomUUID()
    const sessionToken = randomBytes(32).toString('base64url')

    this.clients.set(clientId, { token: sessionToken, lastSeenAt: Date.now(), pid })

    return { status: 200, body: { client_id: clientId, session_token: sessionToken } }
  }

  async handleOperation(method: string, params: any, headers: Record<string, string>, authorizationHeader: string): Promise<{ status: number; body: any }> {
    // Layer 2 auth: session token + client ID
    const clientId = headers['x-hermes-browser-client']
    if (typeof clientId !== 'string' || !clientId.trim() || clientId.length > 200) {
      return { status: 400, body: { error: 'X-Hermes-Browser-Client header is required' } }
    }

    const client = this.clients.get(clientId)
    if (!client) return { status: 401, body: { error: 'Unauthorized' } }

    const expected = `Bearer ${client.token}`
    if (!authorizationHeader || !safeEqual(authorizationHeader, expected)) {
      return { status: 401, body: { error: 'Unauthorized' } }
    }

    // Heartbeat
    client.lastSeenAt = Date.now()

    // Cleanup inactive clients
    this.cleanupExpiredClients()

    // Enforce per-tab serialization
    const tabId = params?.tab_id || this.activeTabId || null
    if (tabId && this.queuedOps.has(tabId)) {
      return this.statusError(await this.queuedOps.get(tabId)!?.result, 409, 'Concurrent operation queued')
    }

    // Global concurrency cap
    if (this.concurrentOps >= 4) {
      return this.waitForCapacity()
    }

    this.concurrentOps++
    try {
      return await this.executeMethod(method, params || {}, tabId)
    } finally {
      this.concurrentOps--
      this.drainCapacityWaiters()
    }
  }

  async getState(): Promise<PublicState> {
    const tabs = Array.from(this.tabs.values()).map(t => this.toPublicTab(t))
    return {
      activeTabId: this.activeTabId ?? undefined,
      maxTabs: MAX_TABS,
      tabs,
    }
  }

  private toPublicTab(tab: BrowserTab): PublicState['tabs'][number] {
    return {
      id: tab.id,
      title: sanitizeString(tab.title, 500),
      url: publicBrowserUrl(tab.url),
      loading: tab.loading,
      canGoBack: tab.canGoBack,
      canGoForward: tab.canGoForward,
      crashed: tab.crashed,
      agentControl: this.hasLease(tab.id) ? 'active' : 'idle',
    }
  }

  private hasLease(tabId: string): boolean {
    const lease = this.leases.get(tabId)
    if (!lease) return false
    if (Date.now() > lease.expiresAt) {
      this.leases.delete(tabId)
      this.leaseTimers.get(tabId)?.refresh()
      this.leaseTimers.delete(tabId)
      return false
    }
    return true
  }

  private async claimLease(tabId: string, clientId: string): Promise<{ ok: boolean; error?: string }> {
    // If no lease exists, claim immediately
    if (!this.leases.has(tabId)) {
      this.leases.set(tabId, { clientId, expiresAt: Date.now() + LEASE_TTL_MS })
      this.scheduleLeaseExpiry(tabId)
      return { ok: true }
    }

    const existing = this.leases.get(tabId)!
    
    // Own lease — renew
    if (existing.clientId === clientId) {
      existing.expiresAt = Date.now() + LEASE_TTL_MS
      return { ok: true }
    }

    // Another client holds it — check if their process is alive
    const otherClient = this.clients.get(existing.clientId)
    if (!otherClient || !processAlive(otherClient.pid || 0)) {
      // Stale — reclaim
      this.leases.delete(tabId)
      this.leases.set(tabId, { clientId, expiresAt: Date.now() + LEASE_TTL_MS })
      return { ok: true }
    }

    return {
      ok: false,
      error: `Browser tab is controlled by another MCP client; user takeover is required before ${this.extractMethodName(arguments[0] as any)}`,
    }
  }

  private extractMethodName(method: string): string {
    return method || 'operation'
  }

  private scheduleLeaseExpiry(tabId: string): void {
    this.clearLeaseTimer(tabId)
    const timer = setTimeout(() => {
      this.leases.delete(tabId)
      this.tabGenerations.set(tabId, (this.tabGenerations.get(tabId) ?? 0) + 1)
      this.clearLeaseTimer(tabId)
    }, LEASE_TTL_MS + 25)
    this.leaseTimers.set(tabId, timer)
  }

  private clearLeaseTimer(tabId: string): void {
    const timer = this.leaseTimers.get(tabId)
    if (timer) {
      clearTimeout(timer)
      this.leaseTimers.delete(tabId)
    }
  }

  private leaseTimersCleanup = new Map<string, NodeJS.Timeout>()
  private tabGenerations = new Map<string, number>()

  cleanupExpiredLeases(): void {
    for (const [tabId, lease] of this.leases) {
      if (Date.now() > lease.expiresAt) {
        this.leases.delete(tabId)
        this.tabGenerations.set(tabId, (this.tabGenerations.get(tabId) ?? 0) + 1)
        this.clearLeaseTimer(tabId)
      }
    }
    this.cleanupExpiredClients()
  }

  cleanupExpiredClients(): void {
    const now = Date.now()
    for (const [clientId, client] of this.clients) {
      if (now - client.lastSeenAt > CLIENT_INACTIVE_THRESHOLD_MS) {
        this.clients.delete(clientId)
      }
    }
  }

  private waitForCapacity(): Promise<{ status: number; body: any }> {
    return new Promise(resolve => {
      this.capacityWaiters.push(() => {
        resolve(this.handleOperation(
          // Re-queue with latest state
          arguments[0] as string,
          arguments[1] as any,
          arguments[2] as Record<string, string>,
          arguments[3] as string,
        ))
      })
    })
  }

  drainCapacityWaiters(): void {
    while (this.concurrentOps < 4 && this.capacityWaiters.length > 0) {
      const waiter = this.capacityWaiters.shift()!
      waiter()
    }
  }

  private statusError(status: number, message: string): { status: number; body: { error: string } } {
    return { status, body: { error: message } }
  }

  // -----------------------------------------------------------------------
  // Core methods mapped to Playwright
  // -----------------------------------------------------------------------

  async executeMethod(method: string, params: any, tabIdOverride?: string): Promise<{ status: number; body: any }> {
    const tabId = tabIdOverride || params?.tab_id || this.activeTabId
    const operationId = params?.operation_id || randomUUID()

    try {
      let result: any
      
      switch (method) {
        case 'state':
        case 'tabs.list': {
          const state = await this.getState()
          result = { operation_id: operationId, result: state }
          break
        }

        case 'tabs.create': {
          const url = typeof params.url === 'string' && params.url ? params.url : 'about:blank'
          const activate = params.activate !== false
          const tab = await this._createTab(url, activate)
          result = { operation_id: operationId, result: this.toPublicTab(tab) }
          break
        }

        case 'tabs.activate': {
          const targetId = params.tab_id
          if (!targetId || !this.tabs.has(targetId)) {
            return { status: 400, body: { error: 'tab_id is required', operation_id } }
          }
          this.activeTabId = targetId
          const state = await this.getState()
          result = { operation_id: operationId, result: state }
          break
        }

        case 'tabs.close': {
          const targetId = params.tab_id
          if (!targetId || !this.tabs.has(targetId)) {
            return { status: 400, body: { error: 'tab_id not found', operation_id } }
          }

          const tab = this.tabs.get(targetId)!
          await tab.page.close().catch(() => {})
          this.tabs.delete(targetId)
          this.clearLeaseTimer(targetId)

          // Reactivate if closed was the active tab
          if (this.activeTabId === targetId) {
            const remaining = Array.from(this.tabs.values())
            this.activeTabId = remaining.length > 0 ? remaining[remaining.length - 1].id : null
          }

          const state = await this.getState()
          result = { operation_id: operationId, result: state }
          break
        }

        case 'navigate': {
          const targetId = params.tab_id || tabId
          if (!targetId) return { status: 400, body: { error: 'tab_id is required', operation_id } }
          const url = params.url
          if (!url) return { status: 400, body: { error: 'url is required', operation_id } }
          
          const tab = this.tabs.get(targetId)
          if (!tab) return { status: 400, body: { error: 'tab not found', operation_id } }

          await tab.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {})
          tab.url = tab.page.url()
          tab.title = tab.page.title()
          tab.loading = false
          tab.tabGeneration++

          if (this.activeTabId === targetId) this.activeTabId = targetId // stay on it
          result = { operation_id: operationId, result: this.toPublicTab(tab) }
          break
        }

        case 'navigation.action': {
          const targetId = params.tab_id || tabId
          if (!targetId || !this.tabs.has(targetId)) {
            return { status: 400, body: { error: 'tab_id is required', operation_id } }
          }
          const action = params.action
          const tab = this.tabs.get(targetId)!

          switch (action) {
            case 'back': await tab.page.goBack({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {})
          break
            case 'forward': await tab.page.goForward({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {})
          break
            case 'reload': await tab.page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {})
          break
            case 'stop': await tab.page.evaluate(() => { document.execCommand('stop') }).catch(() => {})
          break
          default:
            return { status: 400, body: { error: `Unknown navigation action: ${action}`, operation_id } }
          }

          tab.url = tab.page.url()
          tab.title = tab.page.title()
          tab.loading = false
          tab.tabGeneration++
          result = { operation_id: operationId, result: this.toPublicTab(tab) }
          break
        }

        case 'snapshot': {
          const targetId = params.tab_id || tabId
          if (!targetId || !this.tabs.has(targetId)) {
            return { status: 400, body: { error: 'tab_id is required', operation_id } }
          }
          const tab = this.tabs.get(targetId)!
          tab.tabGeneration++
          const snap = await buildSnapshot(tab.page, targetId)
          result = { operation_id: operationId, result: snap }
          break
        }

        case 'text.read': {
          const targetId = params.tab_id || tabId
          if (!targetId || !this.tabs.has(targetId)) {
            return { status: 400, body: { error: 'tab_id is required', operation_id } }
          }
          const tab = this.tabs.get(targetId)!
          const snapshot = await buildSnapshot(tab.page, targetId)
          const node = snapshot.nodes.find(n => n.ref === params.ref)
          if (!node) {
            return { status: 400, body: { error: `Node ${params.ref} not found`, operation_id } }
          }
          const mode = params.mode || 'innerText'
          const offset = typeof params.offset === 'number' ? params.offset : 0
          const limit = typeof params.limit === 'number' ? params.limit : 4000
          const fullText = node.value || node.name || ''
          const sliced = fullText.slice(offset, offset + limit)

          result = {
            operation_id: operationId,
            result: {
              tabId: targetId,
              snapshotId: snapshot.snapshotId,
              ref: params.ref,
              mode,
              offset,
              limit,
              text: sliced,
              totalLength: fullText.length,
              returnedLength: sliced.length,
              hasMore: offset + limit < fullText.length,
              nextOffset: Math.min(offset + limit, fullText.length),
            },
          }
          break
        }

        case 'interact': {
          const targetId = params.tab_id || tabId
          if (!targetId || !this.tabs.has(targetId)) {
            return { status: 400, body: { error: 'tab_id is required', operation_id } }
          }
          const action = params.action
          const tab = this.tabs.get(targetId)!
          tab.tabGeneration++

          switch (action.type || action.action) {
            case 'click': {
              const clicked = await this._performClick(tab, action.ref)
              if (!clicked) {
                result = { operation_id: operationId, result: { success: false, error: 'Could not click element' } }
              } else {
                tab.url = tab.page.url()
                tab.title = tab.page.title()
                result = { operation_id: operationId, result: this.toPublicTab(tab) }
              }
              break
            }
            case 'type': {
              if (!action.text) {
                return { status: 400, body: { error: 'text is required for type', operation_id } }
              }
              await tab.page.keyboard.type(action.text, { delay: Math.random() * 30 })
              result = { operation_id: operationId, result: this.toPublicTab(tab) }
              break
            }
            case 'press': {
              await tab.page.keyboard.press(action.key)
              result = { operation_id: operationId, result: this.toPublicTab(tab) }
              break
            }
            case 'scroll': {
              const pixels = action.pixels || 300
              const dy = ['up'].includes(action.direction) ? -pixels : ['down'].includes(action.direction) ? pixels : 0
              const dx = ['left'].includes(action.direction) ? -pixels : ['right'].includes(action.direction) ? pixels : 0
              await tab.page.mouse.move(dx, dy)
              await tab.page.evaluate(({ y }: any) => window.scrollBy(0, y), { y: dy })
              result = { operation_id: operationId, result: this.toPublicTab(tab) }
              break
            }
            default:
              return { status: 400, body: { error: `Unknown interact action: ${(action as any).type}`, operation_id } }
          }
          break
        }

        case 'screenshot': {
          const targetId = params.tab_id || tabId
          if (!targetId || !this.tabs.has(targetId)) {
            return { status: 400, body: { error: 'tab_id is required', operation_id } }
          }
          const tab = this.tabs.get(targetId)!
          const screenshotBuffer = await tab.page.screenshot({
            fullPage: !!params.full_page,
            type: 'jpeg',
            quality: 70,
          })
          const base64 = screenshotBuffer.toString('base64')
          
          // Notify screenshot capture listeners (for WebSocket streaming)
          if (this.onScreenshotCapture) {
            this.onScreenshotCapture(base64, targetId)
          }

          result = {
            operation_id: operationId,
            result: {
              data: base64,
              mimeType: 'image/jpeg',
              tabId: targetId,
            },
          }
          break
        }

        case 'console.read': {
          const entries: any[] = []
          if (tabId && this.tabs.has(tabId)) {
            const page = this.tabs.get(tabId)!.page
            // We need to listen to console events
            const messages = this.consoleEntries.get(tabId) || []
            for (const msg of messages) {
              entries.push({
                message: (msg.text || '').slice(0, 2000),
                source: msg.source || 'browser',
                timestamp: msg.timestamp,
              })
            }
          }
          result = { operation_id: operationId, result: entries }
          break
        }

        case 'console.clear': {
          if (tabId && this.consoleEntries.has(tabId)) {
            this.consoleEntries.delete(tabId)
          }
          result = { operation_id: operationId, result: { ok: true } }
          break
        }

        case 'lease.release': {
          if (!tabId) return { status: 400, body: { error: 'tab_id is required', operation_id } }
          this.leases.delete(tabId)
          this.clearLeaseTimer(tabId)
          result = { operation_id: operationId, result: { ok: true } }
          break
        }

        default:
          return { status: 400, body: { error: `Unknown Browser Broker method: ${method}`, operation_id } }
      }

      return result

    } catch (error: any) {
      return {
        status: 500,
        body: { error: error.message || 'Browser operation failed', operation_id },
      }
    }
  }

  consoleEntries = new Map<string, Array<{ text: string; source: string; timestamp: number }>>()

  async _createTab(url: string | null, activate: boolean): Promise<BrowserTab> {
    if (!this.context) throw new Error('Browser not started')

    // Enforce max tabs
    if (this.tabs.size >= MAX_TABS) {
      // Close oldest tab that isn't being leased
      for (const [id, tab] of this.tabs) {
        if (!this.leases.has(id)) {
          await tab.page.close().catch(() => {})
          this.tabs.delete(id)
          this.clearLeaseTimer(id)
          break
        }
      }
      if (this.tabs.size >= MAX_TABS) {
        throw new Error(`Maximum ${MAX_TABS} tabs reached`)
      }
    }

    const tabId = randomUUID()
    const page = await this.context.newPage()
    
    // Set up console logging listener
    page.on('console', msg => {
      if (!this.consoleEntries.has(tabId)) {
        this.consoleEntries.set(tabId, [])
      }
      const entries = this.consoleEntries.get(tabId)!
      entries.push({
        text: msg.text(),
        source: msg.type() || 'log',
        timestamp: Date.now(),
      })
      // Keep only last 100 entries
      if (entries.length > 100) entries.shift()
    })

    if (url) {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {})
    }

    const tab: BrowserTab = {
      id: tabId,
      page,
      title: sanitizeString(page.title() || '', 500),
      url: page.url(),
      loading: false,
      canGoBack: page.canGoBack(),
      canGoForward: page.canGoForward(),
      crashed: false,
      tabGeneration: 0,
    }

    this.tabs.set(tabId, tab)
    if (activate) {
      this.activeTabId = tabId
    }

    return tab
  }

  private _performClick(tab: BrowserTab, ref: string): Promise<boolean> {
    return new Promise(async (resolve) => {
      try {
        const axSnapshot = await tab.page.accessibility.snapshot({ interesting_only: false })
        const prefix = ref.replace(/^@/, '')
        const targetIdx = parseInt(prefix) - 1
        
        // Flatten to find the nth node
        const flat: any[] = []
        function flatten(node: any) {
          flat.push(node)
          for (const child of (node.children || [])) {
            flatten(child)
          }
        }
        flatten(axSnapshot)
        
        if (flat[targetIdx]) {
          const target = flat[targetIdx]
          // Use boundingBox from CDP or best-effort fallback
          try {
            const box = await tab.page.evaluateHandle(() => {
              return new Promise((res) => {
                const walker = document.createTreeWalker(
                  document.body,
                  NodeFilter.SHOW_ELEMENT
                )
                let count = 0
                let el: Element | null = null
                while (walker.nextNode()) {
                  const node = walker.currentNode as HTMLElement
                  if (count === targetIdx) {
                    el = node
                    break
                  }
                  count++
                }
                res(el?.getBoundingClientRect() || null)
              })
            })
            
            const rect: any = await box.jsonValue()
            await box.dispose()
            
            if (rect && rect.x !== undefined && rect.y !== undefined) {
              await tab.page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2)
              resolve(true)
            } else {
              // Fallback: scroll to element and click center of viewport
              await tab.page.evaluate(() => {
                const walk = (root: Node, index: number): Element | null => {
                  if (root.nodeType === 1) {
                    if (index === 0) return root as Element
                    index--
                  }
                  for (const child of root.childNodes) {
                    const found = walk(child, index)
                    if (found) return found
                  }
                  return null
                }
                const el = walk(document.documentElement, targetIdx)
                if (el) {
                  el.scrollIntoView({ behavior: 'smooth' })
                  ;(el as HTMLElement).click()
                }
              })
              resolve(true)
            }
          } catch {
            // Last resort: use accessibility action
            await tab.page.keyboard.press('Enter')
            resolve(true)
          }
        } else {
          resolve(false)
        }
      } catch {
        resolve(false)
      }
    })
  }

  private async _writeDescriptor(): Promise<void> {
    try {
      mkdirSync(this.brokerRoot, { recursive: true })
      
      const descriptor = {
        schema: 1,
        desktopPid: process.pid,
        endpoint: `http://127.0.0.1:${this._ephemeralPort}/v1`,
        token: this.masterToken,
        instanceId: this.instanceId,
        createdAt: new Date().toISOString(),
      }
      
      this.descriptor = descriptor
      
      // Write atomically via temp file + rename
      const tmpPath = join(this.brokerRoot, 'broker.json.tmp')
      const finalPath = join(this.brokerRoot, 'broker.json')
      writeFileSync(tmpPath, JSON.stringify(descriptor, null, 2), { mode: 0o600 })
      fsRenameSync(tmpPath, finalPath)
    } catch (error: unknown) {
      // Non-fatal: broker directory may be unwritable
    }
  }

  _ephemeralPort: number = 0

  // Expose internal state for route integration
  getStats(): { tabCount: number; clientCount: number; leaseCount: number } {
    return {
      tabCount: this.tabs.size,
      clientCount: this.clients.size,
      leaseCount: this.leases.size,
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton — shared across controllers & routes
// ---------------------------------------------------------------------------

let _headlessBrowserService: HeadlessBrowserService | null = null

/** Get or create the singleton headless browser service */
export function getHeadlessBrowserService(): HeadlessBrowserService | null {
  return _headlessBrowserService
}

/** Set the singleton instance during server bootstrap */
export function setHeadlessBrowserService(service: HeadlessBrowserService): void {
  _headlessBrowserService = service
}

/** Helper used by the controller to build accessibility snapshots */
export async function buildSnapshotFromPage(page: Page, tabId: string): Promise<any> {
  const axSnapshot = await page.accessibility.snapshot({ interesting_only: false })
  
  if (!axSnapshot) {
    return { tabId, snapshotId: '', url: '', title: '', nodes: [], text: '' }
  }
  
  const nodes: Array<{ref: string; role: string; name: string; value?: string; description?: string; disabled?: boolean; focused?: boolean}> = []
  const MAX_SNAPSHOT_NODES = 300
  
  let idx = 0
  function flatten(node: any, prefix: number): number {
    if (!node || prefix >= MAX_SNAPSHOT_NODES) return prefix
    
    const sanitizedRole = (node.role || 'generic').replace(/\s+/g, ' ').trim().slice(0, 80)
    if (sanitizedRole === 'none' && !node.name && !node.value) return prefix
    
    const n: any = {
      ref: `@e${prefix}`,
      role: sanitizedRole,
      name: (node.name || '').replace(/\s+/g, ' ').trim().slice(0, 500),
    }
    
    if (node.value != null) {
      const protectedProp = (node.properties || []).find((p: any) => p.name === 'protected')
      n.value = protectedProp ? '[protected]' : String(node.value).replace(/\s+/g, ' ').trim().slice(0, 500)
    }
    if (node.description) n.description = node.description.replace(/\s+/g, ' ').trim().slice(0, 200)
    if (node.disabled) n.disabled = true
    if (node.focused) n.focused = true
    
    nodes.push(n)
    
    if (node.children) {
      for (const child of node.children) {
        prefix = flatten(child, prefix + 1)
      }
    }
    
    return prefix
  }
  
  idx = flatten(axSnapshot, 1)
  
  // Deduplicate refs
  const seen = new Set<string>()
  const uniqueNodes = nodes.filter(n => {
    if (seen.has(n.ref)) return false
    seen.add(n.ref)
    return true
  })
  
  const crypto = require('crypto')
  
  // Build text representation
  const textLines = uniqueNodes.slice(0, MAX_SNAPSHOT_NODES).map(n => {
    let line = `${n.ref} ${n.role}`
    if (n.name) line += ` name="${n.name}"`
    if (n.value) line += ` value="${n.value}"`
    return line
  }).join('\n')
  
  return {
    tabId,
    snapshotId: crypto.randomUUID(),
    url: page.url().replace(/\/\/localhost(?::\d+)?/, 'http://127.0.0.1').replace(/^https?:\/\/[^?]+/, m => m.slice(0, 500)),
    title: (page.title() || '').replace(/\s+/g, ' ').trim().slice(0, 500),
    nodes: uniqueNodes,
    text: textLines.slice(0, 24_000),
  }
}

