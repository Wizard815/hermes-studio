import type { CDPSession, Page } from 'playwright'

/**
 * The browser panel's live view: Chrome's own screencast of a tab
 * (Page.startScreencast), shared by every panel watching that tab.
 *
 * Chrome sends a frame only when the page changes, and waits for each frame's
 * ack before sending the next, so a still page costs nothing and acking late
 * caps the frame rate. Before this the panel showed a screenshot taken
 * 350-500 ms after each click or key, and nothing while the chat's model
 * drove the page.
 */
export interface LiveFrame {
  tabId: string
  /** JPEG bytes. */
  data: Buffer
  /** The page's CSS size the frame shows, and where it was scrolled. */
  width: number
  height: number
  scrollX: number
  scrollY: number
}

export type FrameListener = (frame: LiveFrame) => void

export interface ScreencastOptions {
  /** At most this many frames a second (default 15). */
  maxFps?: number
  /** JPEG quality, 0-100 (default 60). */
  quality?: number
  /** The frame's largest size in pixels (default 1600 x 1600). */
  maxWidth?: number
  maxHeight?: number
}

interface Cast {
  page: Page
  session: CDPSession | null
  ready: Promise<void>
  listeners: Set<FrameListener>
  lastFrame: LiveFrame | null
  lastAckAt: number
  ackTimer: NodeJS.Timeout | null
  closed: boolean
}

type PageLookup = (tabId: string) => Page | null

export class BrowserScreencast {
  private casts = new Map<string, Cast>()
  private readonly minFrameMs: number
  private readonly quality: number
  private readonly maxWidth: number
  private readonly maxHeight: number

  constructor(private readonly pageFor: PageLookup, options: ScreencastOptions = {}) {
    this.minFrameMs = Math.round(1000 / Math.max(1, options.maxFps ?? 15))
    this.quality = Math.min(100, Math.max(10, options.quality ?? 60))
    this.maxWidth = options.maxWidth ?? 1600
    this.maxHeight = options.maxHeight ?? 1600
  }

  /** Tabs with someone watching (tests and stats). */
  watchedTabs(): string[] {
    return [...this.casts.keys()]
  }

  /**
   * Start receiving a tab's frames. The last frame (if any) arrives at once.
   * Returns the function that stops watching; the screencast stops with the
   * last watcher.
   */
  async watch(tabId: string, listener: FrameListener): Promise<() => void> {
    const page = this.pageFor(tabId)
    if (!page || page.isClosed()) throw new Error('Tab not found')
    let cast = this.casts.get(tabId)
    if (cast && cast.page !== page) {
      await this.stopCast(tabId, cast)
      cast = undefined
    }
    if (!cast) cast = this.startCast(tabId, page)
    cast.listeners.add(listener)
    const current = cast
    try {
      await current.ready
    } catch (error) {
      current.listeners.delete(listener)
      throw error
    }
    if (current.lastFrame && current.listeners.has(listener)) listener(current.lastFrame)
    let stopped = false
    return () => {
      if (stopped) return
      stopped = true
      current.listeners.delete(listener)
      if (!current.listeners.size && this.casts.get(tabId) === current) void this.stopCast(tabId, current)
    }
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.casts.entries()].map(([tabId, cast]) => this.stopCast(tabId, cast)))
  }

  private startCast(tabId: string, page: Page): Cast {
    const cast: Cast = {
      page,
      session: null,
      ready: Promise.resolve(),
      listeners: new Set(),
      lastFrame: null,
      lastAckAt: 0,
      ackTimer: null,
      closed: false,
    }
    this.casts.set(tabId, cast)
    page.once('close', () => { if (this.casts.get(tabId) === cast) void this.stopCast(tabId, cast) })
    cast.ready = (async () => {
      const session = await page.context().newCDPSession(page)
      if (cast.closed) {
        await session.detach().catch(() => {})
        return
      }
      cast.session = session
      session.on('Page.screencastFrame', event => this.onFrame(tabId, cast, event))
      await session.send('Page.startScreencast', {
        format: 'jpeg',
        quality: this.quality,
        maxWidth: this.maxWidth,
        maxHeight: this.maxHeight,
        everyNthFrame: 1,
      })
    })().catch(error => {
      if (this.casts.get(tabId) === cast) void this.stopCast(tabId, cast)
      throw error
    })
    return cast
  }

  private onFrame(tabId: string, cast: Cast, event: { data: string; sessionId: number; metadata: { deviceWidth?: number; deviceHeight?: number; scrollOffsetX?: number; scrollOffsetY?: number } }) {
    if (cast.closed) return
    const frame: LiveFrame = {
      tabId,
      data: Buffer.from(event.data, 'base64'),
      width: Math.round(event.metadata.deviceWidth || 0),
      height: Math.round(event.metadata.deviceHeight || 0),
      scrollX: Math.round(event.metadata.scrollOffsetX || 0),
      scrollY: Math.round(event.metadata.scrollOffsetY || 0),
    }
    cast.lastFrame = frame
    for (const listener of cast.listeners) {
      try { listener(frame) } catch { /* one broken watcher must not stop the others */ }
    }
    // Chrome sends the next frame only after this ack: acking late caps the rate.
    const wait = Math.max(0, cast.lastAckAt + this.minFrameMs - Date.now())
    const ack = () => {
      cast.ackTimer = null
      cast.lastAckAt = Date.now()
      if (!cast.closed) cast.session?.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {})
    }
    if (wait) cast.ackTimer = setTimeout(ack, wait)
    else ack()
  }

  private async stopCast(tabId: string, cast: Cast): Promise<void> {
    if (this.casts.get(tabId) === cast) this.casts.delete(tabId)
    if (cast.closed) return
    cast.closed = true
    cast.listeners.clear()
    if (cast.ackTimer) clearTimeout(cast.ackTimer)
    await cast.ready.catch(() => {})
    const session = cast.session
    cast.session = null
    if (!session) return
    await session.send('Page.stopScreencast').catch(() => {})
    await session.detach().catch(() => {})
  }
}
