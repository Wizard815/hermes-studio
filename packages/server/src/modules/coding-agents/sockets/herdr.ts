import type { Server, Socket } from 'socket.io'
import { authenticateUserToken } from '../../studio/public/auth'
import { killOwnedProcessTree } from '../../studio/public/process-tree'
import { logger } from '../../studio/public/logging'
import { herdrManager } from '../services/herdr/manager'
import { herdrArgs, readHerdrServerStatus } from '../services/herdr/runtime'
import { studioClientView, type ClientSidebar, type ClientViewLaunch } from '../services/herdr/client-view'
import { paneStream } from '../services/herdr/pane-stream'
import { createStateFeed, type EncodedState } from '../services/herdr/client-state'

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
  /** Pane streams: herdr scrolls the pane's history (its frames are the screen, not a scrollback). */
  scroll?(direction: 'up' | 'down', lines: number): void
  close(): void
}

const TARGET = /^[A-Za-z0-9:_-]{1,64}$/
/** herdr's full UI, plus one stream per pane of the space shown (Studio's Herdr App layout draws each pane). */
const MAX_STREAMS_PER_SOCKET = 16

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

/** The embedded herdr UI with its own client preferences (herdr's sidebar hidden), else herdr as usual. */
async function clientLaunch(binary: string, sidebar: ClientSidebar = 'studio'): Promise<ClientViewLaunch> {
  const settings = herdrManager.getSettings()
  try {
    const status = await readHerdrServerStatus(binary, settings)
    const view = status.running && status.socket ? studioClientView(status.socket, { sidebar }) : null
    if (view) return view
  } catch (error) {
    logger.warn({ error: String(error) }, '[herdr] embedded view uses shared client preferences')
  }
  return { args: herdrArgs(settings, []), env: {} }
}

function clientStream(binary: string, launch: ClientViewLaunch, cols: number, rows: number, onData: (bytes: string) => void, onClose: (reason: string) => void): Stream {
  if (!pty) throw new Error('Terminal support (node-pty) is unavailable on this server')
  const proc = pty.spawn(binary, launch.args, {
    name: 'xterm-256color', cols, rows, cwd: process.env.HOME || process.cwd(),
    env: { ...process.env, ...launch.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
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

  // herdr's state for Studio's pages: slimmed, coalesced, and gzipped for
  // pages that can unzip it (they say so with `auth.gz`), so a few hundred
  // chats do not hold back the herdr terminal sharing this socket.
  const ZIPPED = 'herdr:state:gz'
  const PLAIN = 'herdr:state:plain'
  const sendState = (target: { emit: (event: string, ...args: any[]) => boolean }, zipped: boolean, encoded: EncodedState) => {
    if (zipped) target.emit('herdr.state.gz', encoded.gzip)
    else target.emit('herdr.state', encoded.state)
  }
  const feed = createStateFeed(() => herdrManager.getBridge()?.getState() ?? null, encoded => {
    sendState(nsp.to(ZIPPED), true, encoded)
    sendState(nsp.to(PLAIN), false, encoded)
  })
  const stopState = herdrManager.onState(() => feed.changed())
  // Space folders changed (here or in Herdr App's file): pages reload them.
  const stopFolders = herdrManager.onFoldersChanged(() => { nsp.emit('herdr.folders') })

  nsp.on('connection', (socket: Socket) => {
    const streams = new Map<string, Stream>()
    const zipped = socket.handshake.auth?.gz === true
    void socket.join(zipped ? ZIPPED : PLAIN)
    sendState(socket, zipped, feed.current())

    socket.on('terminal.open', async (data: any, ack?: (result: { ok: boolean; streamId?: string; error?: string }) => void) => {
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
        // A client on `machine:<id>` is that saved machine's full herdr (herdr --remote).
        const machine = mode === 'client' && typeof data?.target === 'string' && data.target.startsWith('machine:') ? data.target.slice('machine:'.length) : ''
        const launch = mode !== 'client' ? null
          : machine ? { args: await herdrManager.remoteAttachArgs(machine), env: {} }
            : await clientLaunch(binary, data?.sidebar === 'herdr' ? 'herdr' : 'studio')
        streams.get(streamId)?.close()
        const onData = (bytes: string) => socket.emit('terminal.data', { streamId, bytes })
        const onClose = (reason: string) => {
          if (streams.get(streamId) !== stream) return
          streams.delete(streamId)
          socket.emit('terminal.closed', { streamId, reason })
        }
        let stream: Stream
        if (mode === 'client') {
          stream = clientStream(binary, launch!, cols, rows, onData, onClose)
        } else {
          const target = String(data?.target || '')
          if (!TARGET.test(target)) throw new Error('Invalid pane target')
          stream = paneStream(binary, herdrManager.getSettings(), mode, target, cols, rows, data?.takeover === true, onData, onClose)
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
    socket.on('terminal.scroll', (data: any) => {
      const stream = streams.get(String(data?.streamId || ''))
      const direction = data?.direction === 'down' ? 'down' : data?.direction === 'up' ? 'up' : ''
      if (stream?.scroll && direction) stream.scroll(direction, clampSize(data?.lines, 3, 200))
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
      stopFolders()
      feed.stop()
      nsp.disconnectSockets(true)
    },
  }
}
