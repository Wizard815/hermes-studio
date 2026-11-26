import { connect, type Socket } from 'node:net'
import { randomUUID } from 'node:crypto'
import type { HerdrEvent, HerdrResponse } from './protocol'

export class HerdrRequestError extends Error {
  constructor(message: string, readonly code: string) {
    super(message)
    this.name = 'HerdrRequestError'
  }
}

/** Split a newline-delimited JSON stream into parsed records, keeping partial lines. */
export class NdjsonReader {
  private buffer = ''
  push(chunk: string): unknown[] {
    this.buffer += chunk
    const records: unknown[] = []
    let index = this.buffer.indexOf('\n')
    while (index >= 0) {
      const line = this.buffer.slice(0, index).trim()
      this.buffer = this.buffer.slice(index + 1)
      if (line) {
        try { records.push(JSON.parse(line)) } catch { /* skip malformed line */ }
      }
      index = this.buffer.indexOf('\n')
    }
    return records
  }
}

/**
 * Minimal herdr socket API client: one connection per request, plus long-lived
 * subscription connections. Herdr closes a subscription connection on
 * `events_lost`, so callers must treat close as "resync required".
 */
export class HerdrSocketClient {
  constructor(private readonly socketPath: string, private readonly timeoutMs = 5000) {}

  get path(): string { return this.socketPath }

  request<T = any>(method: string, params: Record<string, unknown> = {}, timeoutMs = this.timeoutMs): Promise<T> {
    return new Promise((resolve, reject) => {
      const id = `studio_${randomUUID()}`
      const reader = new NdjsonReader()
      let settled = false
      const socket = connect(this.socketPath)
      const finish = (error: Error | null, value?: T) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        socket.destroy()
        if (error) reject(error)
        else resolve(value as T)
      }
      const timer = setTimeout(() => finish(new HerdrRequestError(`herdr ${method} timed out`, 'timeout')), timeoutMs)
      socket.setEncoding('utf8')
      socket.on('connect', () => socket.write(`${JSON.stringify({ id, method, params })}\n`))
      socket.on('data', (chunk: string) => {
        for (const record of reader.push(chunk) as HerdrResponse<T>[]) {
          if (record?.id !== id && record?.id !== '') continue
          if (record.error) finish(new HerdrRequestError(record.error.message || record.error.code || 'herdr error', record.error.code || 'error'))
          else finish(null, record.result as T)
        }
      })
      socket.on('error', error => finish(new HerdrRequestError(error.message, (error as NodeJS.ErrnoException).code || 'socket_error')))
      socket.on('close', () => finish(new HerdrRequestError(`herdr closed the connection during ${method}`, 'closed')))
    })
  }

  /**
   * Open a subscription. `onEvent` receives pushed events; `onClose` fires once
   * when the connection ends for any reason (including events_lost).
   */
  subscribe(
    subscriptions: Array<Record<string, unknown>>,
    onEvent: (event: HerdrEvent) => void,
    onClose: (reason: string) => void,
    readyTimeoutMs = this.timeoutMs,
  ): { close: () => void; ready: Promise<void> } {
    const id = `studio_sub_${randomUUID()}`
    const reader = new NdjsonReader()
    let closed = false
    let readyResolve!: () => void
    let readyReject!: (error: Error) => void
    const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject })
    ready.catch(() => {})
    const socket: Socket = connect(this.socketPath)
    socket.setEncoding('utf8')
    // A herdr that accepts the connection but never answers must not leave the
    // subscriber waiting forever: the subscription ends and the caller retries.
    let readyTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => { readyTimer = null; end('subscribe_timeout') }, readyTimeoutMs)
    readyTimer.unref?.()
    const settleReady = () => { if (readyTimer) { clearTimeout(readyTimer); readyTimer = null } }
    const end = (reason: string) => {
      if (closed) return
      closed = true
      settleReady()
      socket.destroy()
      readyReject(new HerdrRequestError(reason, 'closed'))
      onClose(reason)
    }
    socket.on('connect', () => {
      socket.write(`${JSON.stringify({ id, method: 'events.subscribe', params: { subscriptions } })}\n`)
    })
    socket.on('data', (chunk: string) => {
      for (const record of reader.push(chunk) as any[]) {
        if (record?.id === id || record?.id === '') {
          if (record.error) { end(record.error.code || 'subscription_error'); return }
          settleReady()
          readyResolve()
          continue
        }
        if (typeof record?.event === 'string') onEvent(record as HerdrEvent)
      }
    })
    socket.on('error', error => end((error as NodeJS.ErrnoException).code || error.message))
    socket.on('close', () => end('closed'))
    return { close: () => end('closed_by_client'), ready }
  }
}
