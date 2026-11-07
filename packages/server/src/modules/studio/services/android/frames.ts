import { createHash } from 'node:crypto'
import { discoverGrpc, streamEmulatorScreen } from './emulator-grpc'

export interface AndroidFrame {
  serial: string
  mime: 'image/png' | 'image/jpeg'
  data: Buffer
  width: number
  height: number
  source: FrameSourceKind
}

export type FrameSourceKind = 'emulator' | 'screencap'
export type FrameListener = (frame: AndroidFrame) => void
export type EndListener = (reason: string) => void

export interface FrameHubDeps {
  /** One `adb exec-out screencap -p` PNG. */
  screencap(serial: string): Promise<Buffer>
  /** Shrinks a screencap for the wire; returns the input when it cannot. */
  compress(png: Buffer, width: number): Promise<{ data: Buffer; mime: 'image/png' | 'image/jpeg'; width: number; height: number }>
  streamWidth(): number
  log(message: string): void
}

/** Width and height from a PNG's IHDR chunk. */
export function pngSize(png: Buffer): { width: number; height: number } | null {
  if (png.length < 24 || png.readUInt32BE(12) !== 0x49484452) return null
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }
}

const SCREENCAP_MIN_INTERVAL_MS = 120
const SCREENCAP_ERROR_BACKOFF_MS = 1500
const MAX_SCREENCAP_FAILURES = 5

interface Feed {
  listeners: Set<FrameListener>
  endListeners: Set<EndListener>
  last: AndroidFrame | null
  source: FrameSourceKind
  stop: () => void
}

/**
 * One screen feed per device, shared by every viewer and stopped when the last
 * one leaves. Emulators on this host use their gRPC stream; everything else
 * (phones, BlueStacks, emulators in another container) polls screencap.
 */
export class FrameHub {
  private feeds = new Map<string, Feed>()

  constructor(private readonly deps: FrameHubDeps) {}

  lastFrame(serial: string): AndroidFrame | null {
    return this.feeds.get(serial)?.last ?? null
  }

  watch(serial: string, onFrame: FrameListener, onEnd: EndListener): () => void {
    let feed = this.feeds.get(serial)
    if (!feed) {
      feed = { listeners: new Set(), endListeners: new Set(), last: null, source: 'screencap', stop: () => {} }
      this.feeds.set(serial, feed)
      this.start(serial, feed)
    }
    feed.listeners.add(onFrame)
    feed.endListeners.add(onEnd)
    if (feed.last) onFrame(feed.last)
    const current = feed
    return () => {
      current.listeners.delete(onFrame)
      current.endListeners.delete(onEnd)
      if (!current.listeners.size && this.feeds.get(serial) === current) {
        this.feeds.delete(serial)
        current.stop()
      }
    }
  }

  close(): void {
    // Forget the feeds first: a stopping emulator stream must not fall back to screencap.
    const feeds = [...this.feeds.values()]
    this.feeds.clear()
    for (const feed of feeds) feed.stop()
  }

  private publish(serial: string, feed: Feed, frame: AndroidFrame) {
    feed.last = frame
    for (const listener of feed.listeners) listener(frame)
  }

  private end(serial: string, feed: Feed, reason: string) {
    if (this.feeds.get(serial) !== feed) return
    this.feeds.delete(serial)
    feed.stop()
    for (const listener of feed.endListeners) listener(reason)
  }

  private start(serial: string, feed: Feed) {
    const consolePort = /^emulator-(\d+)$/.exec(serial)?.[1]
    const endpoint = consolePort ? discoverGrpc(consolePort) : null
    if (endpoint) {
      feed.source = 'emulator'
      const stream = streamEmulatorScreen(endpoint, this.deps.streamWidth(), png => {
        const size = pngSize(png)
        if (size) this.publish(serial, feed, { serial, mime: 'image/png', data: png, ...size, source: 'emulator' })
      }, reason => {
        if (this.feeds.get(serial) !== feed) return
        // The emulator refused or dropped the stream: keep the viewers on screencap.
        this.deps.log(`[android] emulator stream for ${serial} ended (${reason}); using screencap`)
        this.startScreencap(serial, feed)
      })
      feed.stop = stream.stop
      return
    }
    this.startScreencap(serial, feed)
  }

  private startScreencap(serial: string, feed: Feed) {
    feed.source = 'screencap'
    let stopped = false
    let timer: NodeJS.Timeout | null = null
    let lastHash = ''
    let failures = 0
    feed.stop = () => {
      stopped = true
      if (timer) clearTimeout(timer)
    }
    const tick = async () => {
      if (stopped) return
      const started = Date.now()
      let delay = SCREENCAP_MIN_INTERVAL_MS
      try {
        const png = await this.deps.screencap(serial)
        failures = 0
        const hash = createHash('sha1').update(png).digest('hex')
        if (!stopped && hash !== lastHash) {
          lastHash = hash
          const frame = await this.deps.compress(png, this.deps.streamWidth())
          if (!stopped) this.publish(serial, feed, { serial, ...frame, source: 'screencap' })
        }
        delay = Math.max(0, SCREENCAP_MIN_INTERVAL_MS - (Date.now() - started))
      } catch (error) {
        failures += 1
        if (failures >= MAX_SCREENCAP_FAILURES) {
          this.end(serial, feed, (error as Error).message || 'screencap failed')
          return
        }
        delay = SCREENCAP_ERROR_BACKOFF_MS
      }
      if (!stopped) timer = setTimeout(() => { void tick() }, delay)
    }
    void tick()
  }
}
