/**
 * Headless Browser Service
 *
 * Manages a Playwright Chromium instance for AI agent browser automation
 * and live UI viewing. Exposes a REST API (via controllers/browser.ts) used
 * by the Studio chat tool panel and MCP-style snapshot/interact flows.
 */

import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { mkdirSync, writeFileSync, renameSync as fsRenameSync } from 'node:fs'
import { join } from 'node:path'
import type { Browser, BrowserContext, chromium as ChromiumType, Page } from 'playwright'

type PlaywrightChromium = typeof ChromiumType

// Loaded lazily: playwright is an optional runtime dependency and its internal
// dynamic requires must not be pulled into the esbuild server bundle.
function requirePlaywrightChromium(): PlaywrightChromium {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return (require('playwright') as { chromium: PlaywrightChromium }).chromium
}

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
  pid: number
}

export interface BrowserSnapshotNode {
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

export interface SnapshotResult {
  tabId: string
  snapshotId: string
  url: string
  title: string
  nodes: BrowserSnapshotNode[]
  text: string
}

// ---------------------------------------------------------------------------
// Constants & Helpers
// ---------------------------------------------------------------------------

const MAX_TABS = 8
const LEASE_TTL_MS = 60_000
const CLIENT_INACTIVE_THRESHOLD_MS = 24 * 60 * 60 * 1000
const MAX_SNAPSHOT_NODES = 300
const MAX_SNAPSHOT_TEXT = 24_000
const MAX_CONCURRENT_OPS = 4

/** Selector for elements exposed as actionable nodes in snapshots. */
const INTERACTIVE_SELECTOR = [
  'a[href]', 'button', 'input', 'select', 'textarea', 'summary',
  '[role=button]', '[role=link]', '[role=textbox]', '[role=checkbox]',
  '[role=radio]', '[role=tab]', '[role=menuitem]', '[role=combobox]',
  '[role=slider]', '[role=searchbox]', '[role=switch]', '[role=option]',
  '[contenteditable=true]', '[onclick]', '[onchange]',
].join(',')

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
    // External URLs - redact query params for privacy
    return `${parsed.protocol}//${parsed.hostname}${parsed.pathname}${parsed.search ? '?[redacted]' : ''}`
  } catch {
    return url.slice(0, 500)
  }
}

function sanitizeString(value: string, maxLength: number): string {
  if (!value) return ''
  return value.replace(/\s+/g, ' ').trim().slice(0, maxLength)
}

async function refreshTabMeta(tab: BrowserTab): Promise<void> {
  tab.url = tab.page.url()
  tab.title = sanitizeString(await tab.page.title(), 500)
  tab.loading = false
  try {
    const historyLength = await tab.page.evaluate(() => history.length)
    tab.canGoBack = historyLength > 1
  } catch {
    tab.canGoBack = false
  }
  tab.canGoForward = false
  tab.tabGeneration++
}

// ---------------------------------------------------------------------------
// Snapshot / click helpers (DOM-based; Playwright has no page.accessibility)
// ---------------------------------------------------------------------------

interface RawSnapshotElement {
  role: string
  name: string
  value?: string
  disabled?: boolean
  focused?: boolean
}

async function collectInteractiveElements(page: Page): Promise<RawSnapshotElement[]> {
  return page.evaluate((selector: string) => {
    const implicitRole = (el: HTMLElement): string => {
      const explicit = el.getAttribute('role')
      if (explicit) return explicit
      const tag = el.tagName.toLowerCase()
      if (tag === 'a') return el.hasAttribute('href') ? 'link' : 'generic'
      if (tag === 'button') return 'button'
      if (tag === 'summary') return 'button'
      if (tag === 'select') return 'combobox'
      if (tag === 'textarea') return 'textbox'
      if (tag === 'input') {
        const type = (el.getAttribute('type') || 'text').toLowerCase()
        if (type === 'checkbox') return 'checkbox'
        if (type === 'radio') return 'radio'
        if (type === 'button' || type === 'submit' || type === 'reset') return 'button'
        if (type === 'range') return 'slider'
        if (type === 'hidden') return 'none'
        return 'textbox'
      }
      if (el.isContentEditable) return 'textbox'
      return 'generic'
    }
    const accessibleName = (el: HTMLElement): string => {
      const labelled = el.getAttribute('aria-label')
        || (el.getAttribute('aria-labelledby')
          ? Array.from(document.querySelectorAll('#' + el.getAttribute('aria-labelledby')!.split(' ').join(', #')))
            .map(n => n.textContent || '').join(' ')
          : '')
      if (labelled) return labelled
      const text = (el.textContent || '').trim()
      if (text) return text
      const value = (el as HTMLInputElement).value
      if (typeof value === 'string' && value) return value
      return el.getAttribute('placeholder') || el.getAttribute('alt') || el.getAttribute('title') || el.getAttribute('name') || ''
    }
    const isVisible = (el: HTMLElement): boolean => {
      if (el.tagName.toLowerCase() === 'input' && (el as HTMLInputElement).type === 'hidden') return true
      const style = window.getComputedStyle(el)
      if (style.display === 'none' || style.visibility === 'hidden') return false
      const rect = el.getBoundingClientRect()
      return rect.width > 0 || rect.height > 0
    }

    const out: Array<{ role: string; name: string; value?: string; disabled?: boolean; focused?: boolean }> = []
    const active = document.activeElement
    for (const raw of Array.from(document.querySelectorAll(selector))) {
      if (out.length >= 400) break
      const el = raw as HTMLElement
      if (!isVisible(el)) continue
      const role = implicitRole(el)
      if (role === 'none') continue
      const name = accessibleName(el)
      const tag = el.tagName.toLowerCase()
      const isInput = tag === 'input' || tag === 'textarea' || tag === 'select'
      let value: string | undefined
      if (isInput) {
        const input = el as HTMLInputElement
        if (input.type === 'password') value = '[protected]'
        else if (typeof input.value === 'string') value = input.value
      }
      out.push({
        role,
        name,
        ...(value != null ? { value } : {}),
        ...(el.hasAttribute('disabled') ? { disabled: true } : {}),
        ...(el === active ? { focused: true } : {}),
      })
    }
    return out
  }, INTERACTIVE_SELECTOR)
}

/** Transform the page's interactive element tree to Hermes snapshot format. */
export async function buildSnapshot(page: Page, tabId: string): Promise<SnapshotResult> {
  try {
    const rawElements = await collectInteractiveElements(page)

    const nodes: BrowserSnapshotNode[] = rawElements.slice(0, MAX_SNAPSHOT_NODES).map((n, i) => ({
      ref: `@e${i + 1}`,
      role: sanitizeString(n.role || 'generic', 80),
      name: sanitizeString(n.name, 500),
      ...(n.value != null ? { value: sanitizeString(n.value, 500) } : {}),
      ...(n.disabled ? { disabled: true } : {}),
      ...(n.focused ? { focused: true } : {}),
    }))

    const textLines = nodes.map(n => {
      let line = `${n.ref} ${n.role}`
      if (n.name) line += ` name="${n.name}"`
      if (n.value) line += ` value="${n.value}"`
      return line
    }).join('\n')

    return {
      tabId,
      snapshotId: randomUUID(),
      url: publicBrowserUrl(page.url()),
      title: sanitizeString(await page.title(), 500),
      nodes,
      text: textLines.slice(0, MAX_SNAPSHOT_TEXT),
    }
  } catch {
    return { tabId, snapshotId: '', url: '', title: '', nodes: [], text: '' }
  }
}

/** Best-effort alias kept for the REST controller. */
export async function buildSnapshotFromPage(page: Page, tabId: string): Promise<SnapshotResult> {
  return buildSnapshot(page, tabId)
}

// ---------------------------------------------------------------------------
// HeadlessBrowserService
// ---------------------------------------------------------------------------

export class HeadlessBrowserService {
  private browser: Browser | null = null
  private context: BrowserContext | null = null
  tabs = new Map<string, BrowserTab>()
  activeTabId: string | null = null

  masterToken = ''
  descriptor: any = null
  leases = new Map<string, Lease>()
  instanceId = ''
  consoleEntries = new Map<string, Array<{ text: string; source: string; timestamp: number }>>()

  private leaseTimers = new Map<string, NodeJS.Timeout>()
  private clients = new Map<string, BrokerClient>()
  private concurrentOps = 0
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

    const chromium = requirePlaywrightChromium()
    this.masterToken = randomBytes(32).toString('base64url')
    this.instanceId = randomUUID()

    this.browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ],
    })

    this.context = await this.browser.newContext({
      viewport: { width: 1280, height: 720 },
    })

    // Auto-create first empty tab
    const firstTab = await this._createTab(null, true)
    await refreshTabMeta(firstTab)

    await this._writeDescriptor()

    return this.descriptor
  }

  async stop(): Promise<void> {
    for (const timer of this.leaseTimers.values()) {
      clearTimeout(timer)
    }
    this.leaseTimers.clear()
    this.leases.clear()
    this.clients.clear()

    for (const tab of this.tabs.values()) {
      await tab.page.close().catch(() => {})
    }
    this.tabs.clear()
    this.activeTabId = null

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

  getTab(tabId: string): BrowserTab | null {
    return this.tabs.get(tabId) ?? null
  }

  getAllTabs(): BrowserTab[] {
    return Array.from(this.tabs.values())
  }

  getTabFor(params: any): { tab: BrowserTab | null; error?: string } {
    const targetId = (typeof params?.tab_id === 'string' && params.tab_id) || this.activeTabId
    if (!targetId) return { tab: null, error: 'tab_id is required' }
    const tab = this.tabs.get(targetId)
    if (!tab) return { tab: null, error: 'Tab not found' }
    return { tab }
  }

  async getState(): Promise<PublicState> {
    const tabs = Array.from(this.tabs.values()).map(t => this.toPublicTab(t))
    return {
      activeTabId: this.activeTabId ?? undefined,
      maxTabs: MAX_TABS,
      tabs,
    }
  }

  toPublicTab(tab: BrowserTab): PublicState['tabs'][number] {
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

  // ── Session / operation auth (MCP broker contract) ─────────────

  async handleSessionRequest(body: any, authorizationHeader: string): Promise<{ status: number; body: any }> {
    const expected = `Bearer ${this.masterToken}`
    if (!authorizationHeader || authorizationHeader !== expected) {
      return { status: 401, body: { error: 'Unauthorized' } }
    }

    const pid = typeof body.client_pid === 'number' ? body.client_pid : 0
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      return { status: 400, body: { error: 'client_pid is required' } }
    }

    const clientId = randomUUID()
    const sessionToken = randomBytes(32).toString('base64url')

    this.clients.set(clientId, { token: sessionToken, lastSeenAt: Date.now(), pid })

    return { status: 200, body: { client_id: clientId, session_token: sessionToken } }
  }

  async handleOperation(
    method: string,
    params: any,
    headers: Record<string, string>,
    authorizationHeader: string,
  ): Promise<{ status: number; body: any }> {
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

    client.lastSeenAt = Date.now()
    this.cleanupExpiredClients()

    if (this.concurrentOps >= MAX_CONCURRENT_OPS) {
      return this.statusError(429, 'Too many concurrent browser operations')
    }

    const lease = await this.claimLeaseFor(params, clientId)
    if (!lease.ok) {
      return this.statusError(409, lease.error || 'Browser tab is busy')
    }

    this.concurrentOps++
    try {
      return await this.executeMethod(method, params || {})
    } finally {
      this.concurrentOps--
    }
  }

  // ── Leases ─────────────────────────────────────────────────────

  hasLease(tabId: string): boolean {
    const lease = this.leases.get(tabId)
    if (!lease) return false
    if (Date.now() > lease.expiresAt) {
      this.leases.delete(tabId)
      this.clearLeaseTimer(tabId)
      return false
    }
    return true
  }

  private async claimLeaseFor(params: any, clientId: string): Promise<{ ok: boolean; error?: string }> {
    const tabId = (typeof params?.tab_id === 'string' && params.tab_id) || this.activeTabId
    if (!tabId) return { ok: true }

    const existing = this.leases.get(tabId)
    if (!existing) {
      this.leases.set(tabId, { clientId, expiresAt: Date.now() + LEASE_TTL_MS })
      this.scheduleLeaseExpiry(tabId)
      return { ok: true }
    }

    if (existing.clientId === clientId) {
      existing.expiresAt = Date.now() + LEASE_TTL_MS
      return { ok: true }
    }

    const otherClient = this.clients.get(existing.clientId)
    if (!otherClient || !processAlive(otherClient.pid)) {
      this.leases.delete(tabId)
      this.leases.set(tabId, { clientId, expiresAt: Date.now() + LEASE_TTL_MS })
      this.scheduleLeaseExpiry(tabId)
      return { ok: true }
    }

    return {
      ok: false,
      error: 'Browser tab is controlled by another MCP client; user takeover is required before this operation',
    }
  }

  private scheduleLeaseExpiry(tabId: string): void {
    this.clearLeaseTimer(tabId)
    const timer = setTimeout(() => {
      this.leases.delete(tabId)
      this.leaseTimers.delete(tabId)
    }, LEASE_TTL_MS + 25)
    this.leaseTimers.set(tabId, timer)
  }

  clearLeaseTimer(tabId: string): void {
    const timer = this.leaseTimers.get(tabId)
    if (timer) {
      clearTimeout(timer)
      this.leaseTimers.delete(tabId)
    }
  }

  releaseLease(tabId: string): void {
    this.leases.delete(tabId)
    this.clearLeaseTimer(tabId)
  }

  cleanupExpiredClients(): void {
    const now = Date.now()
    for (const [clientId, client] of this.clients) {
      if (now - client.lastSeenAt > CLIENT_INACTIVE_THRESHOLD_MS) {
        this.clients.delete(clientId)
      }
    }
  }

  private statusError(status: number, message: string): { status: number; body: { error: string } } {
    return { status, body: { error: message } }
  }

  // ── Broker-style method dispatch (used by MCP/JSON-RPC flow) ──

  async executeMethod(method: string, params: any): Promise<{ status: number; body: any }> {
    const operationId = typeof params?.operationId === 'string' ? params.operationId : randomUUID()

    try {
      let result: any

      switch (method) {
        case 'state':
        case 'tabs.list': {
          result = { operationId, result: await this.getState() }
          break
        }

        case 'tabs.create': {
          const url = typeof params.url === 'string' && params.url ? params.url : null
          const activate = params.activate !== false
          const tab = await this._createTab(url, activate)
          await refreshTabMeta(tab)
          result = { operationId, result: this.toPublicTab(tab) }
          break
        }

        case 'tabs.activate': {
          const targetId = params.tab_id
          if (!targetId || !this.tabs.has(targetId)) {
            return { status: 400, body: { error: 'tab_id is required', operationId } }
          }
          this.activeTabId = targetId
          result = { operationId, result: await this.getState() }
          break
        }

        case 'tabs.close': {
          const targetId = params.tab_id
          if (!targetId || !this.tabs.has(targetId)) {
            return { status: 400, body: { error: 'tab_id not found', operationId } }
          }
          await this._closeTab(targetId)
          result = { operationId, result: await this.getState() }
          break
        }

        case 'navigate': {
          const { tab, error } = this.getTabFor(params)
          if (!tab) return { status: 400, body: { error: error || 'tab not found', operationId } }
          const url = params.url
          if (!url) return { status: 400, body: { error: 'url is required', operationId } }
          await tab.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {})
          await refreshTabMeta(tab)
          result = { operationId, result: this.toPublicTab(tab) }
          break
        }

        case 'navigation.action': {
          const { tab, error } = this.getTabFor(params)
          if (!tab) return { status: 400, body: { error: error || 'tab not found', operationId } }
          switch (params.action) {
            case 'back':
              await tab.page.goBack({ waitUntil: 'domcontentloaded', timeout: 15_000 }).catch(() => {})
              break
            case 'forward':
              await tab.page.goForward({ waitUntil: 'domcontentloaded', timeout: 15_000 }).catch(() => {})
              break
            case 'reload':
              await tab.page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {})
              break
            case 'stop':
              await tab.page.evaluate(() => window.stop()).catch(() => {})
              break
            default:
              return { status: 400, body: { error: `Unknown navigation action: ${params.action}`, operationId } }
          }
          await refreshTabMeta(tab)
          result = { operationId, result: this.toPublicTab(tab) }
          break
        }

        case 'snapshot': {
          const { tab, error } = this.getTabFor(params)
          if (!tab) return { status: 400, body: { error: error || 'tab not found', operationId } }
          const snap = await buildSnapshot(tab.page, tab.id)
          result = { operationId, result: snap }
          break
        }

        case 'text.read': {
          const { tab, error } = this.getTabFor(params)
          if (!tab) return { status: 400, body: { error: error || 'tab not found', operationId } }
          const snapshot = await buildSnapshot(tab.page, tab.id)
          const node = snapshot.nodes.find(n => n.ref === params.ref)
          if (!node) {
            return { status: 400, body: { error: `Node ${params.ref} not found`, operationId } }
          }
          const mode = params.mode || 'innerText'
          const offset = typeof params.offset === 'number' ? params.offset : 0
          const limit = typeof params.limit === 'number' ? params.limit : 4000
          const fullText = node.value || node.name || ''
          const sliced = fullText.slice(offset, offset + limit)
          result = {
            operationId,
            result: {
              tabId: tab.id,
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
          const { tab, error } = this.getTabFor(params)
          if (!tab) return { status: 400, body: { error: error || 'tab not found', operationId } }
          const action = params.action || {}
          switch (action.type || action.action) {
            case 'click': {
              const clicked = await this._performClick(tab, action.ref)
              if (!clicked) {
                result = { operationId, result: { success: false, error: 'Could not click element' } }
              } else {
                await refreshTabMeta(tab)
                result = { operationId, result: this.toPublicTab(tab) }
              }
              break
            }
            case 'type': {
              if (!action.text) {
                return { status: 400, body: { error: 'text is required for type', operationId } }
              }
              if (action.ref) {
                const focused = await this._focusRef(tab, action.ref)
                if (!focused) {
                  result = { operationId, result: { success: false, error: 'Could not focus element' } }
                  break
                }
              }
              await tab.page.keyboard.type(String(action.text), { delay: 20 })
              await refreshTabMeta(tab)
              result = { operationId, result: this.toPublicTab(tab) }
              break
            }
            case 'press': {
              await tab.page.keyboard.press(action.key || 'Enter')
              await refreshTabMeta(tab)
              result = { operationId, result: this.toPublicTab(tab) }
              break
            }
            case 'scroll': {
              const pixels = typeof action.pixels === 'number' ? action.pixels : 300
              const dy = action.direction === 'up' ? -pixels : action.direction === 'down' ? pixels : 0
              const dx = action.direction === 'left' ? -pixels : action.direction === 'right' ? pixels : 0
              await tab.page.evaluate(({ x, y }: { x: number; y: number }) => window.scrollBy(x, y), { x: dx, y: dy })
              result = { operationId, result: this.toPublicTab(tab) }
              break
            }
            default:
              return { status: 400, body: { error: `Unknown interact action: ${action.type || action.action}`, operationId } }
          }
          break
        }

        case 'screenshot': {
          const { tab, error } = this.getTabFor(params)
          if (!tab) return { status: 400, body: { error: error || 'tab not found', operationId } }
          const base64 = await this.captureScreenshot(tab.id, !!params.full_page)
          result = {
            operationId,
            result: { data: base64, mimeType: 'image/jpeg', tabId: tab.id },
          }
          break
        }

        case 'console.read': {
          const entries: any[] = []
          if (this.activeTabId && this.tabs.has(this.activeTabId)) {
            for (const msg of this.consoleEntries.get(this.activeTabId) || []) {
              entries.push({
                message: (msg.text || '').slice(0, 2000),
                source: msg.source || 'browser',
                timestamp: msg.timestamp,
              })
            }
          }
          result = { operationId, result: entries }
          break
        }

        case 'console.clear': {
          if (this.activeTabId && this.consoleEntries.has(this.activeTabId)) {
            this.consoleEntries.delete(this.activeTabId)
          }
          result = { operationId, result: { ok: true } }
          break
        }

        case 'lease.release': {
          const targetId = params.tab_id || this.activeTabId
          if (!targetId) return { status: 400, body: { error: 'tab_id is required', operationId } }
          this.releaseLease(targetId)
          result = { operationId, result: { ok: true } }
          break
        }

        default:
          return { status: 400, body: { error: `Unknown Browser Broker method: ${method}`, operationId } }
      }

      return result
    } catch (error: any) {
      return {
        status: 500,
        body: { error: error?.message || 'Browser operation failed', operationId },
      }
    }
  }

  // ── Tabs ───────────────────────────────────────────────────────

  async _createTab(url: string | null, activate: boolean): Promise<BrowserTab> {
    if (!this.context) throw new Error('Browser not started')

    if (this.tabs.size >= MAX_TABS) {
      for (const [id] of this.tabs) {
        if (!this.leases.has(id)) {
          await this._closeTab(id)
          break
        }
      }
      if (this.tabs.size >= MAX_TABS) {
        throw new Error(`Maximum ${MAX_TABS} tabs reached`)
      }
    }

    const tabId = randomUUID()
    const page = await this.context.newPage()

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
      if (entries.length > 100) entries.shift()
    })

    page.on('crash', () => {
      const tab = this.tabs.get(tabId)
      if (tab) tab.crashed = true
    })

    const tab: BrowserTab = {
      id: tabId,
      page,
      title: '',
      url: 'about:blank',
      loading: false,
      canGoBack: false,
      canGoForward: false,
      crashed: false,
      tabGeneration: 0,
    }

    this.tabs.set(tabId, tab)
    if (activate) {
      this.activeTabId = tabId
    }

    if (url) {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {})
    }
    await refreshTabMeta(tab)

    return tab
  }

  async _closeTab(tabId: string): Promise<void> {
    const tab = this.tabs.get(tabId)
    if (!tab) return
    await tab.page.close().catch(() => {})
    this.tabs.delete(tabId)
    this.consoleEntries.delete(tabId)
    this.clearLeaseTimer(tabId)
    this.leases.delete(tabId)
    if (this.activeTabId === tabId) {
      const remaining = Array.from(this.tabs.values())
      this.activeTabId = remaining.length > 0 ? remaining[remaining.length - 1].id : null
    }
  }

  // ── Interaction primitives (shared with controller) ────────────

  /** Click the nth interactive element referenced by @e<index>. */
  async _performClick(tab: BrowserTab, ref: string): Promise<boolean> {
    const index = this.refToIndex(ref)
    if (index == null) return false
    return await this._withInteractiveElement(tab.page, index, 'click').catch(() => false)
  }

  /** Focus the nth interactive element referenced by @e<index>. */
  async _focusRef(tab: BrowserTab, ref: string): Promise<boolean> {
    const index = this.refToIndex(ref)
    if (index == null) return false
    return await this._withInteractiveElement(tab.page, index, 'focus').catch(() => false)
  }

  private refToIndex(ref: string): number | null {
    if (typeof ref !== 'string') return null
    const match = ref.match(/^@e(\d+)$/)
    if (!match) return null
    const idx = parseInt(match[1], 10) - 1
    return Number.isFinite(idx) && idx >= 0 ? idx : null
  }

  // Recompute the interactive element list inside the page using the same
  // visibility filter as collectInteractiveElements, then act on the nth one.
  private async _withInteractiveElement(
    page: Page,
    index: number,
    action: 'click' | 'focus',
  ): Promise<boolean> {
    return page.evaluate(({ selector, idx, act }: { selector: string; idx: number; act: 'click' | 'focus' }) => {
      const isVisible = (el: HTMLElement): boolean => {
        if (el.tagName.toLowerCase() === 'input' && (el as HTMLInputElement).type === 'hidden') return true
        const style = window.getComputedStyle(el)
        if (style.display === 'none' || style.visibility === 'hidden') return false
        const rect = el.getBoundingClientRect()
        return rect.width > 0 || rect.height > 0
      }
      const nodes = (Array.from(document.querySelectorAll(selector)) as HTMLElement[])
        .filter(el => el.tagName.toLowerCase() !== 'input' || (el as HTMLInputElement).type !== 'hidden')
        .filter(isVisible)
      const el = nodes[idx]
      if (!el) return false
      el.scrollIntoView({ block: 'center' })
      if (act === 'focus') {
        el.focus()
      } else {
        el.click()
      }
      return true
    }, { selector: INTERACTIVE_SELECTOR, idx: index, act: action })
  }

  // ── Coordinate input primitives (manual browser control) ───────
  //
  // The live preview is a screenshot, so manual clicks arrive as normalized
  // viewport coordinates (0..1) rather than element refs.

  /** Click at a normalized point in the current viewport. */
  async clickAt(tabId: string, x: number, y: number, options?: { button?: 'left' | 'right' | 'middle'; double?: boolean }): Promise<BrowserTab> {
    const tab = this.tabs.get(tabId)
    if (!tab) throw new Error('Tab not found')
    const viewport = tab.page.viewportSize() || { width: 1280, height: 720 }
    const px = Math.round(x * viewport.width)
    const py = Math.round(y * viewport.height)
    if (options?.double) {
      await tab.page.mouse.dblclick(px, py, { button: options?.button || 'left' }).catch(() => {})
    } else {
      await tab.page.mouse.click(px, py, { button: options?.button || 'left' }).catch(() => {})
    }
    await refreshTabMeta(tab)
    return tab
  }

  /** Move the pointer and scroll the page by wheel delta. */
  async scrollAt(tabId: string, x: number, y: number, deltaX: number, deltaY: number): Promise<BrowserTab> {
    const tab = this.tabs.get(tabId)
    if (!tab) throw new Error('Tab not found')
    const viewport = tab.page.viewportSize() || { width: 1280, height: 720 }
    const px = Math.round(x * viewport.width)
    const py = Math.round(y * viewport.height)
    await tab.page.mouse.move(px, py).catch(() => {})
    await tab.page.mouse.wheel(deltaX, deltaY).catch(() => {})
    return tab
  }

  /** Type text into the currently focused element. */
  async typeText(tabId: string, text: string): Promise<BrowserTab> {
    const tab = this.tabs.get(tabId)
    if (!tab) throw new Error('Tab not found')
    await tab.page.keyboard.type(text, { delay: 15 })
    await refreshTabMeta(tab)
    return tab
  }

  /** Press a named key (Enter, Backspace, ArrowDown, …). */
  async pressKey(tabId: string, key: string): Promise<BrowserTab> {
    const tab = this.tabs.get(tabId)
    if (!tab) throw new Error('Tab not found')
    await tab.page.keyboard.press(key as any)
    await refreshTabMeta(tab)
    return tab
  }

  /** Read the current scroll offset and page metrics for the manual view. */
  async getViewportInfo(tabId: string): Promise<{ width: number; height: number; scrollX: number; scrollY: number; scrollWidth: number; scrollHeight: number }> {
    const tab = this.tabs.get(tabId)
    if (!tab) throw new Error('Tab not found')
    const viewport = tab.page.viewportSize() || { width: 1280, height: 720 }
    const metrics = await tab.page.evaluate(() => ({
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      scrollWidth: document.documentElement.scrollWidth,
      scrollHeight: document.documentElement.scrollHeight,
    })).catch(() => ({ scrollX: 0, scrollY: 0, scrollWidth: viewport.width, scrollHeight: viewport.height }))
    return { width: viewport.width, height: viewport.height, ...metrics }
  }

  // ── Screenshot ─────────────────────────────────────────────────

  async captureScreenshot(tabId: string, fullPage = false, options?: { broadcast?: boolean }): Promise<string> {
    const tab = this.tabs.get(tabId)
    if (!tab) throw new Error('Tab not found')
    const buffer = await tab.page.screenshot({
      fullPage,
      type: 'jpeg',
      quality: 70,
    })
    const base64 = buffer.toString('base64')
    // Preview refreshes pass broadcast:false so they do not enter the gallery.
    if (options?.broadcast !== false && this.onScreenshotCapture) {
      this.onScreenshotCapture(base64, tabId)
    }
    return base64
  }

  // ── Descriptor for MCP broker discovery ────────────────────────

  _ephemeralPort = 0

  private async _writeDescriptor(): Promise<void> {
    try {
      mkdirSync(this.brokerRoot, { recursive: true })

      const descriptor = {
        schema: 1,
        desktopPid: process.pid,
        endpoint: this._ephemeralPort > 0 ? `http://127.0.0.1:${this._ephemeralPort}/v1` : '',
        token: this.masterToken,
        instanceId: this.instanceId,
        createdAt: new Date().toISOString(),
      }

      if (!descriptor.endpoint) {
        this.descriptor = descriptor
        return
      }

      this.descriptor = descriptor

      const tmpPath = join(this.brokerRoot, 'broker.json.tmp')
      const finalPath = join(this.brokerRoot, 'broker.json')
      writeFileSync(tmpPath, JSON.stringify(descriptor, null, 2), { mode: 0o600 })
      fsRenameSync(tmpPath, finalPath)
    } catch {
      // Non-fatal: broker directory may be unwritable
    }
  }

  getStats(): { tabCount: number; clientCount: number; leaseCount: number } {
    return {
      tabCount: this.tabs.size,
      clientCount: this.clients.size,
      leaseCount: this.leases.size,
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton - shared across controllers & routes
// ---------------------------------------------------------------------------

let _headlessBrowserService: HeadlessBrowserService | null = null

/** Get the singleton instance */
export function getHeadlessBrowserService(): HeadlessBrowserService | null {
  return _headlessBrowserService
}

/** Set the singleton instance during server bootstrap */
export function setHeadlessBrowserService(service: HeadlessBrowserService): void {
  _headlessBrowserService = service
}
