import { EventEmitter } from 'node:events'
import WebSocket from 'ws'

/**
 * One raw DevTools connection to a whole Chrome (its browser endpoint), with
 * flattened sessions: every page tab is attached with Target.attachToTarget
 * {flatten: true} and messages are routed by their sessionId.
 */

const COMMAND_TIMEOUT_MS = 60_000

interface Pending {
  resolve: (value: any) => void
  reject: (error: Error) => void
  method: string
  timer: NodeJS.Timeout
}

export interface CdpTargetInfo {
  targetId: string
  type: string
  title: string
  url: string
  attached?: boolean
  openerId?: string
  browserContextId?: string
}

/** The browser's DevTools websocket URL, from /json/version on its DevTools port. */
export async function browserWebSocketUrl(port: number, host = '127.0.0.1'): Promise<string> {
  const response = await fetch(`http://${host}:${port}/json/version`, { signal: AbortSignal.timeout(5_000) })
  if (!response.ok) throw new Error(`Chrome DevTools answered HTTP ${response.status}`)
  const info = await response.json() as { webSocketDebuggerUrl?: string }
  if (!info.webSocketDebuggerUrl) throw new Error('Chrome did not report its DevTools endpoint')
  return info.webSocketDebuggerUrl
}

export class CdpConnection extends EventEmitter {
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  /** Root (page) session id -> tab contents. */
  private readonly roots = new Map<string, CdpContents>()
  /** Child (iframe) session id -> the tab contents that owns it. */
  private readonly children = new Map<string, CdpContents>()
  private closed = false

  private constructor(private readonly socket: WebSocket, readonly port: number) {
    super()
    socket.on('message', data => this.receive(String(data)))
    socket.on('close', () => this.shutdown())
    socket.on('error', () => this.shutdown())
  }

  static async connect(port: number, host = '127.0.0.1'): Promise<CdpConnection> {
    const url = await browserWebSocketUrl(port, host)
    const socket = new WebSocket(url, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 })
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { socket.terminate(); reject(new Error('Chrome DevTools connection timed out')) }, 10_000)
      socket.once('open', () => { clearTimeout(timer); resolve() })
      socket.once('error', error => { clearTimeout(timer); reject(error) })
    })
    return new CdpConnection(socket, port)
  }

  get isOpen(): boolean {
    return !this.closed && this.socket.readyState === WebSocket.OPEN
  }

  send<T = any>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    if (!this.isOpen) return Promise.reject(new Error('Chrome DevTools connection is closed'))
    const id = this.nextId++
    const message: Record<string, unknown> = { id, method, params }
    if (sessionId) message.sessionId = sessionId
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Chrome DevTools command timed out: ${method}`))
      }, COMMAND_TIMEOUT_MS)
      timer.unref?.()
      this.pending.set(id, { resolve, reject, method, timer })
      this.socket.send(JSON.stringify(message), error => {
        if (!error) return
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error)
      })
    })
  }

  registerRoot(sessionId: string, contents: CdpContents): void {
    this.roots.set(sessionId, contents)
  }

  unregisterRoot(sessionId: string): void {
    const contents = this.roots.get(sessionId)
    this.roots.delete(sessionId)
    for (const [child, owner] of this.children) if (owner === contents) this.children.delete(child)
  }

  close(): void {
    try { this.socket.close() } catch { /* already closed */ }
    this.shutdown()
  }

  private shutdown(): void {
    if (this.closed) return
    this.closed = true
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(new Error('Chrome DevTools connection closed'))
      this.pending.delete(id)
    }
    const tabs = new Set(this.roots.values())
    this.roots.clear()
    this.children.clear()
    for (const contents of tabs) contents.handleDetached('target_closed')
    this.emit('disconnected')
  }

  private receive(text: string): void {
    let message: { id?: number; method?: string; params?: any; result?: any; error?: { message?: string; data?: string }; sessionId?: string }
    try { message = JSON.parse(text) } catch { return }
    if (typeof message.id === 'number') {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      clearTimeout(pending.timer)
      if (message.error) {
        const detail = [message.error.message, message.error.data].filter(Boolean).join(': ')
        pending.reject(new Error(detail || `Chrome DevTools command failed: ${pending.method}`))
      } else pending.resolve(message.result ?? {})
      return
    }
    const method = message.method
    if (!method) return
    const params = message.params || {}
    const sessionId = message.sessionId
    if (!sessionId) {
      // Browser-level events: targets come and go; a root page session can end.
      if (method === 'Target.detachedFromTarget') {
        const contents = this.roots.get(params.sessionId)
        if (contents) {
          this.unregisterRoot(params.sessionId)
          contents.handleDetached('target_closed')
        }
      }
      this.emit('event', method, params)
      return
    }
    const root = this.roots.get(sessionId)
    const owner = root || this.children.get(sessionId)
    if (!owner) return
    // An iframe attached under one of the tab's sessions belongs to that tab, so its
    // events are routed before the tab hears about it.
    if (method === 'Target.attachedToTarget' && params.sessionId) this.children.set(params.sessionId, owner)
    // Electron delivers the attached root session's events without a session id and
    // child-session events with theirs; browser-cdp.ts relies on exactly that.
    owner.dispatch(method, params, root ? undefined : sessionId)
    if (method === 'Target.detachedFromTarget' && params.sessionId) this.children.delete(params.sessionId)
  }
}

/**
 * A minimal stand-in for Electron's WebContents for one page target, with just what
 * the Desktop app's BrowserAutomation / CdpTabState use: `debugger.{attach, isAttached,
 * detach, sendCommand, on, removeListener}`, `getURL()`, `getTitle()`, `isDestroyed()`
 * and `isLoading()`.
 */
export class CdpContents {
  private readonly events = new EventEmitter()
  private attaching: Promise<string> | null = null
  sessionId: string | undefined
  url: string
  title: string
  loading = false
  private destroyed = false
  /** Called after every (re)attach of the root session, before queued commands run. */
  onAttached?: (sessionId: string) => Promise<void>

  readonly debugger: {
    attach: (protocolVersion?: string) => void
    isAttached: () => boolean
    detach: () => void
    sendCommand: (method: string, params?: Record<string, unknown>, sessionId?: string) => Promise<any>
    on: (event: string, listener: (...args: any[]) => void) => unknown
    removeListener: (event: string, listener: (...args: any[]) => void) => unknown
  }

  constructor(private readonly connection: CdpConnection, readonly targetId: string, info?: Partial<CdpTargetInfo>) {
    this.url = info?.url || 'about:blank'
    this.title = info?.title || ''
    this.events.setMaxListeners(50)
    this.debugger = {
      attach: () => { void this.attach().catch(() => undefined) },
      isAttached: () => !!this.attaching && !this.destroyed,
      detach: () => this.detach(),
      sendCommand: (method, params = {}, sessionId) => this.sendCommand(method, params, sessionId),
      on: (event, listener) => this.events.on(event, listener),
      removeListener: (event, listener) => this.events.removeListener(event, listener),
    }
  }

  /** Attach the tab's root session (flattened); idempotent while attached. */
  attach(): Promise<string> {
    if (this.destroyed) return Promise.reject(new Error('Browser tab is closed'))
    if (this.attaching) return this.attaching
    const attaching = (async () => {
      const response = await this.connection.send<{ sessionId: string }>('Target.attachToTarget', { targetId: this.targetId, flatten: true })
      this.sessionId = response.sessionId
      this.connection.registerRoot(response.sessionId, this)
      if (this.onAttached) await this.onAttached(response.sessionId).catch(() => undefined)
      return response.sessionId
    })()
    this.attaching = attaching
    attaching.catch(() => { if (this.attaching === attaching) this.attaching = null })
    return attaching
  }

  private async sendCommand(method: string, params: Record<string, unknown>, sessionId?: string): Promise<any> {
    if (this.destroyed) throw new Error('Browser tab is closed')
    if (!this.attaching) throw new Error('Browser tab debugger is not attached')
    const root = await this.attaching
    return this.connection.send(method, params, sessionId || root)
  }

  /** Commands on the root session before automation has attached (the manager's own bookkeeping). */
  async send<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const root = await this.attach()
    return this.connection.send<T>(method, params, root)
  }

  /** A command on an explicit session (used while the root session is still attaching). */
  sendTo<T = any>(sessionId: string, method: string, params: Record<string, unknown> = {}): Promise<T> {
    return this.connection.send<T>(method, params, sessionId)
  }

  private detach(): void {
    const sessionId = this.sessionId
    if (!this.attaching) return
    this.attaching = null
    this.sessionId = undefined
    if (sessionId) {
      this.connection.unregisterRoot(sessionId)
      void this.connection.send('Target.detachFromTarget', { sessionId }).catch(() => undefined)
    }
    this.events.emit('detach', {}, 'canceled_by_client')
  }

  /** The root session ended (tab closed, Chrome gone or another detach). */
  handleDetached(reason: string): void {
    if (!this.attaching && !this.sessionId) return
    this.attaching = null
    this.sessionId = undefined
    this.events.emit('detach', {}, reason)
  }

  dispatch(method: string, params: any, sessionId?: string): void {
    this.events.emit('message', {}, method, params, sessionId)
  }

  markDestroyed(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.handleDetached('target_closed')
  }

  getURL(): string { return this.url }
  getTitle(): string { return this.title }
  isDestroyed(): boolean { return this.destroyed }
  isLoading(): boolean { return this.loading }
}
