import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type { Server, Socket } from 'socket.io'
import { authenticateUserToken } from '../../studio/public/auth'
import { killOwnedProcessTree } from '../../studio/public/process-tree'
import { logger } from '../../studio/public/logging'
import { herdrManager } from '../services/herdr/manager'
import { herdrArgs } from '../services/herdr/runtime'
import { NdjsonReader } from '../services/herdr/socket-client'

/**
 * `/herdr` namespace: live herdr state for the Studio panel, plus terminal
 * streams. Three stream modes:
 *  - observe: read-only view of one pane (any number of viewers)
 *  - control: writable view of one pane (one controller; `takeover` replaces it)
 *  - client: herdr's full UI, i.e. the "swap to herdr" view
 */
type Mode = 'observe' | 'control' | 'client'

interface Stream {
  mode: Mode
  write(data: string): void
  resize(cols: number, rows: number): void
  close(): void
}

const TARGET = /^[A-Za-z0-9:_-]{1,64}$/
const MAX_STREAMS_PER_SOCKET = 6

let pty: any = null
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  pty = require('node-pty')
} catch {
  pty = null
}

function clampSize(value: unknown, fallback: number, max: number): number {
  const number = Math.floor(Number(value))
  return Number.isFinite(number) && number > 0 ? Math.min(number, max) : fallback
}

function paneStream(binary: string, mode: 'observe' | 'control', target: string, cols: number, rows: number, takeover: boolean,
  onData: (bytes: string) => void, onClose: (reason: string) => void): Stream {
  const settings = herdrManager.getSettings()
  const args = herdrArgs(settings, ['terminal', 'session', mode, target, '--cols', String(cols), '--rows', String(rows), ...(mode === 'control' && takeover ? ['--takeover'] : [])])
  const child: ChildProcessWithoutNullStreams = spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'], env: process.env })
  const reader = new NdjsonReader()
  let closed = false
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    for (const record of reader.push(chunk) as any[]) {
      if (record?.type === 'terminal.frame' && typeof record.bytes === 'string') onData(record.bytes)
      else if (record?.type === 'terminal.closed') finish(String(record.reason || 'closed'))
    }
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-2000) })
  child.on('error', error => finish(error.message))
  child.on('exit', () => finish(stderr.trim() || 'closed'))
  const send = (command: Record<string, unknown>) => {
    if (mode !== 'control' || closed || !child.stdin.writable) return
    child.stdin.write(`${JSON.stringify(command)}\n`)
  }
  function finish(reason: string) {
    if (closed) return
    closed = true
    try { child.stdin.end() } catch { /* ignore */ }
    if (child.exitCode === null) child.kill()
    onClose(reason)
  }
  return {
    mode,
    write: data => send({ type: 'terminal.input', text: data }),
    resize: (c, r) => send({ type: 'terminal.resize', cols: c, rows: r }),
    close: () => {
      send({ type: 'terminal.release' })
      finish('closed_by_client')
    },
  }
}

function clientStream(binary: string, cols: number, rows: number, onData: (bytes: string) => void, onClose: (reason: string) => void): Stream {
  if (!pty) throw new Error('Terminal support (node-pty) is unavailable on this server')
  const settings = herdrManager.getSettings()
  const proc = pty.spawn(binary, herdrArgs(settings, []), {
    name: 'xterm-256color', cols, rows, cwd: process.env.HOME || process.cwd(),
    env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
  })
  let closed = false
  proc.onData((data: string) => onData(Buffer.from(data, 'utf8').toString('base64')))
  proc.onExit(() => { if (!closed) { closed = true; onClose('exited') } })
  return {
    mode: 'client',
    write: data => { if (!closed) proc.write(data) },
    resize: (c, r) => { if (!closed) proc.resize(c, r) },
    close: () => {
      if (closed) return
      closed = true
      // Closing the client only detaches; herdr keeps every pane running.
      killOwnedProcessTree(proc.pid, () => proc.kill())
      onClose('closed_by_client')
    },
  }
}

export function setupHerdrSocket(io: Server) {
  const nsp = io.of('/herdr')
  nsp.use((socket, next) => {
    void (async () => {
      const user = await authenticateUserToken(String(socket.handshake.auth?.token || ''))
      if (user?.role !== 'super_admin') return next(new Error('Super administrator privileges are required'))
      socket.data.user = user
      next()
    })().catch(() => next(new Error('Unauthorized')))
  })

  const stopState = herdrManager.onState(state => nsp.emit('herdr.state', state))

  nsp.on('connection', (socket: Socket) => {
    const streams = new Map<string, Stream>()
    socket.emit('herdr.state', herdrManager.getBridge()?.getState() ?? null)

    socket.on('terminal.open', (data: any, ack?: (result: { ok: boolean; streamId?: string; error?: string }) => void) => {
      const reply = typeof ack === 'function' ? ack : () => {}
      try {
        const mode: Mode = data?.mode === 'control' || data?.mode === 'client' ? data.mode : 'observe'
        const streamId = String(data?.streamId || '')
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(streamId)) throw new Error('Invalid stream id')
        if (streams.size >= MAX_STREAMS_PER_SOCKET) throw new Error('Too many open herdr terminals')
        if (!herdrManager.getSettings().enabled) throw new Error('herdr integration is turned off')
        const binary = herdrManager.requireBinary()
        const cols = clampSize(data?.cols, 100, 500)
        const rows = clampSize(data?.rows, 30, 200)
        streams.get(streamId)?.close()
        const onData = (bytes: string) => socket.emit('terminal.data', { streamId, bytes })
        const onClose = (reason: string) => {
          if (streams.get(streamId) !== stream) return
          streams.delete(streamId)
          socket.emit('terminal.closed', { streamId, reason })
        }
        let stream: Stream
        if (mode === 'client') {
          stream = clientStream(binary, cols, rows, onData, onClose)
        } else {
          const target = String(data?.target || '')
          if (!TARGET.test(target)) throw new Error('Invalid pane target')
          stream = paneStream(binary, mode, target, cols, rows, data?.takeover === true, onData, onClose)
        }
        streams.set(streamId, stream)
        reply({ ok: true, streamId })
      } catch (error) {
        reply({ ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    })

    socket.on('terminal.input', (data: any) => {
      const stream = streams.get(String(data?.streamId || ''))
      if (stream && typeof data?.data === 'string' && data.data.length <= 64 * 1024) stream.write(data.data)
    })
    socket.on('terminal.resize', (data: any) => {
      const stream = streams.get(String(data?.streamId || ''))
      if (stream) stream.resize(clampSize(data?.cols, 100, 500), clampSize(data?.rows, 30, 200))
    })
    socket.on('terminal.close', (data: any) => {
      const stream = streams.get(String(data?.streamId || ''))
      stream?.close()
    })
    socket.on('disconnect', () => {
      for (const stream of streams.values()) {
        try { stream.close() } catch (error) { logger.warn(error, '[herdr] stream close failed') }
      }
      streams.clear()
    })
  })

  return {
    close: () => {
      stopState()
      nsp.disconnectSockets(true)
    },
  }
}
