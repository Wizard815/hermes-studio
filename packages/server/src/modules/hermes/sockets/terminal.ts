import { pty, findShell, canOpenTerminal, resolveTerminalCwd } from '../services/terminal/runtime'
import { WebSocketServer } from 'ws'
import type { IncomingMessage, Server as HttpServer } from 'http'
import type { Duplex } from 'stream'
import { authenticateUserToken, isAuthEnabled } from '../../studio/public/auth'
import { logger } from '../../studio/public/logging'
import { config } from '../../studio/public/config'
import {
  parseUpgradeRequestUrl,
  shouldRejectUpgradeOrigin,
  writeBadUpgradeRequest,
  writeForbiddenOrigin,
} from '../../studio/public/security'
import {
  ensureTmuxSession,
  killTmuxSession,
  listChatSessions,
  nextSessionIndex,
  tmuxAvailable,
  tmuxSessionExists,
  tmuxSessionName,
} from '../services/terminal/tmux-sessions'

function shellName(shell: string): string { return shell.split('/').pop() || 'shell' }

// ─── Shared attach registry ─────────────────────────────────────
//
// Exactly ONE `tmux attach` client exists per tmux session, regardless of how
// many browser sockets are open. Multiple attach clients mirror the same pane
// (doubled output) and fight over size (redraw/overdraw). The registry keeps a
// single client and fans its output out to the active subscriber, buffering
// while nobody is connected.

interface AttachClient {
  id: string
  pty: { pid: number; onData: (cb: (data: string) => void) => void; onExit: (cb: (e: { exitCode: number }) => void) => void; write: (data: string) => void; kill: (signal?: string) => void; resize: (cols: number, rows: number) => void }
  pid: number
  /** Called with raw output; set by the currently active socket. */
  sink: ((data: string) => void) | null
  /** Identifier of the socket that owns the current sink. */
  sinkOwner: string | null
  buffer: string[]
  cols: number
  rows: number
  history: string
}

const attaches = new Map<string, AttachClient>()
const MAX_HISTORY = 400_000
const MAX_BUFFER_CHUNKS = 4000

// Intermediaries idle out an upgraded socket after ~30s of silence — the
// observed median reconnect gap on this deployment was 31.2s. Push a frame on a
// fixed interval well inside that window so the connection survives idle
// periods instead of reconnecting (and replaying) every half minute.
export const TERMINAL_HEARTBEAT_MS = 20_000

// Remember which tmux session each chat scope was last viewing. Without this a
// socket reconnect (panel remount, dropped connection) always restored
// `tmuxSessions[0]`, snapping the user from `bash #2` back to `bash #1`.
const activeByChat = new Map<string, string>()

function sanitizeChatId(value: string): string {
  return String(value || '').trim().replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64)
}

function getOrCreateAttach(name: string): AttachClient {
  const existing = attaches.get(name)
  if (existing) return existing

  const ptyProcess = pty.spawn('tmux', ['attach-session', '-t', name], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: resolveTerminalCwd(),
    env: { ...process.env, TERM: 'xterm-256color' },
  })

  const client: AttachClient = {
    id: name,
    pty: ptyProcess,
    pid: ptyProcess.pid,
    sink: null,
    sinkOwner: null,
    buffer: [],
    cols: 80,
    rows: 24,
    history: '',
  }

  ptyProcess.onData((data: string) => {
    client.history += data
    if (client.history.length > MAX_HISTORY) {
      client.history = client.history.slice(-MAX_HISTORY)
    }
    if (client.sink) {
      client.sink(data)
    } else {
      client.buffer.push(data)
      if (client.buffer.length > MAX_BUFFER_CHUNKS) client.buffer.shift()
    }
  })

  ptyProcess.onExit(({ exitCode }: { exitCode: number }) => {
    // The attach client exited. If the tmux session is still alive (e.g. it
    // was detached), transparently respawn so the terminal stays usable.
    if (attaches.get(name) === client) attaches.delete(name)
    if (tmuxSessionExists(name)) {
      logger.info('tmux attach exited; respawning: %s', name)
      setTimeout(() => {
        if (attaches.has(name)) return
        if (!tmuxSessionExists(name)) return
        const next = getOrCreateAttach(name)
        if (client.sink) {
          next.sink = client.sink
          next.sinkOwner = client.sinkOwner
        }
      }, 250)
      return
    }
    logger.info('tmux session ended: %s (code %d)', name, exitCode)
  })

  attaches.set(name, client)
  return client
}

/** Detach a session's sink and flush buffered output to the new sink. */
function bindSink(client: AttachClient, owner: string, sink: (data: string) => void): string {
  client.sink = sink
  client.sinkOwner = owner
  const pending = client.buffer.join('')
  client.buffer = []
  return pending
}

// ─── WebSocket server setup ─────────────────────────────────────

export function setupTerminalWebSocket(
  httpServers: HttpServer | HttpServer[],
  options: { heartbeatMs?: number } = {},
) {
  if (!pty) {
    logger.warn('node-pty not available, skipping terminal WebSocket setup')
    return null
  }
  if (!tmuxAvailable()) {
    logger.warn('tmux not available, terminal sessions will not persist across restarts')
  }

  const heartbeatMs = options.heartbeatMs ?? TERMINAL_HEARTBEAT_MS
  const wss = new WebSocketServer({ noServer: true })
  const defaultShell = findShell()
  const servers = Array.isArray(httpServers) ? httpServers : [httpServers]

  const onUpgrade = async (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = parseUpgradeRequestUrl(req)
    if (!url) {
      writeBadUpgradeRequest(socket)
      return
    }
    if (url.pathname !== '/api/hermes/terminal') return

    if (shouldRejectUpgradeOrigin(req, config.corsOrigins)) {
      writeForbiddenOrigin(socket)
      return
    }

    if (await isAuthEnabled()) {
      const token = url.searchParams.get('token') || ''
      const user = await authenticateUserToken(token)
      if (!user) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
        socket.destroy()
        return
      }
      if (!canOpenTerminal(user)) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
        socket.destroy()
        return
      }
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req)
    })
  }

  servers.forEach(httpServer => httpServer.on('upgrade', onUpgrade))

  wss.on('connection', (ws, req) => {
    const url = parseUpgradeRequestUrl(req)
    const rawChatId = url?.searchParams.get('chat_session_id') || url?.searchParams.get('client_id') || ''
    const chatSessionId = sanitizeChatId(rawChatId) || 'default'

    let closed = false
    const socketId = `${chatSessionId}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`
    const wsOpen = () => !closed && ws.readyState === ws.OPEN
    const sendControl = (payload: Record<string, unknown>) => {
      if (wsOpen()) ws.send(JSON.stringify(payload))
    }
    const sendRaw = (data: string) => {
      if (wsOpen()) ws.send(data)
    }

    // Keep the upgraded socket warm. Without this an intermediary idle timeout
    // silently drops it; the client then reconnects every ~30s, and each
    // reconnect used to reset the pane. Protocol-level ping also keeps the TCP
    // leg warm (the browser answers pong automatically); the JSON frame covers
    // intermediaries that only count data frames.
    const heartbeat = setInterval(() => {
      if (!wsOpen()) return
      try {
        ws.ping()
        sendControl({ type: 'ping', t: Date.now() })
      } catch {
        /* socket already gone; the close handler does the cleanup */
      }
    }, heartbeatMs)
    heartbeat.unref?.()

    // The sink drops output for a session this socket is no longer viewing.
    let activeId: string | null = null
    const sinkFor = (name: string) => (data: string) => {
      if (activeId === name) sendRaw(data)
    }

    function bind(name: string) {
      const client = getOrCreateAttach(name)
      const pending = bindSink(client, socketId, sinkFor(name))
      if (pending) sendRaw(pending)
      return client
    }

    function writeRaw(data: string) {
      if (!activeId) return
      const client = attaches.get(activeId)
      if (client) client.pty.write(data)
    }

    function handleControl(parsed: any) {
      switch (parsed.type) {
        case 'create': {
          const name = tmuxSessionName(chatSessionId, nextSessionIndex(chatSessionId))
          try {
            ensureTmuxSession(name, resolveTerminalCwd())
          } catch (err: any) {
            sendControl({ type: 'error', message: err.message })
            return
          }
          const client = bind(name)
          activeId = name
          activeByChat.set(chatSessionId, name)
          sendControl({ type: 'created', id: name, pid: client.pid, shell: shellName(defaultShell) })
          break
        }

        case 'switch': {
          const { sessionId } = parsed
          if (!attaches.has(sessionId) && !tmuxSessionExists(sessionId)) {
            sendControl({ type: 'error', message: 'Session not found' })
            return
          }
          const client = bind(sessionId)
          activeId = sessionId
          activeByChat.set(chatSessionId, sessionId)
          sendControl({ type: 'switched', id: sessionId })
          void client
          break
        }

        case 'close': {
          const { sessionId } = parsed
          const client = attaches.get(sessionId)
          if (client) {
            try { client.pty.kill() } catch { /* ignore */ }
            attaches.delete(sessionId)
          }
          killTmuxSession(sessionId)
          if (activeId === sessionId) activeId = null
          if (activeByChat.get(chatSessionId) === sessionId) activeByChat.delete(chatSessionId)
          break
        }

        case 'resize': {
          if (!activeId) return
          const client = attaches.get(activeId)
          if (!client) return
          const cols = Math.max(1, parsed.cols || 0)
          const rows = Math.max(1, parsed.rows || 0)
          client.cols = cols
          client.rows = rows
          try { client.pty.resize(cols, rows) } catch { /* ignore */ }
          break
        }

        case 'input': {
          if (typeof parsed.data === 'string') writeRaw(parsed.data)
          break
        }
      }
    }

    ws.on('message', (raw: any) => {
      const msg = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw)
      if (msg.charCodeAt(0) === 0x7B) {
        try {
          handleControl(JSON.parse(msg))
        } catch {
          writeRaw(msg)
        }
        return
      }
      writeRaw(msg)
    })

    let tmuxSessions = listChatSessions(chatSessionId)
    if (tmuxSessions.length === 0) {
      const name = tmuxSessionName(chatSessionId, 1)
      try {
        ensureTmuxSession(name, resolveTerminalCwd())
        tmuxSessions = listChatSessions(chatSessionId)
      } catch (err: any) {
        sendControl({ type: 'error', message: err.message })
        logger.error(err, 'Failed to create initial tmux session')
        ws.close()
        return
      }
    }

    // Prefer the session the user was last viewing so a reconnect does not
    // yank them back to the first tab.
    const remembered = activeByChat.get(chatSessionId)
    activeId = remembered && tmuxSessions.some(session => session.name === remembered)
      ? remembered
      : tmuxSessions[0]?.name ?? null
    if (activeId) activeByChat.set(chatSessionId, activeId)

    const restored = tmuxSessions.map(session => {
      const client = bind(session.name)
      return {
        id: session.name,
        shell: shellName(defaultShell),
        pid: client.pid,
        exited: !tmuxSessionExists(session.name),
        // Replay the tail of the live buffer so reattaching repaints the pane
        // instead of flashing an empty terminal.
        scrollback: client.history.slice(-MAX_HISTORY),
      }
    })
    sendControl({ type: 'restored', activeSessionId: activeId, sessions: restored })
    logger.info('Chat %s attached to %d tmux session(s)', chatSessionId, restored.length)

    // On close, unbind only this socket's sinks but leave tmux + attach clients
    // alive so reopening the panel is instant and lossless.
    const shutdown = () => {
      if (closed) return
      closed = true
      clearInterval(heartbeat)
      for (const client of attaches.values()) {
        if (client.sinkOwner !== socketId) continue
        client.sink = null
        client.sinkOwner = null
      }
    }
    ws.on('close', shutdown)
    ws.on('error', shutdown)
  })

  logger.info('WebSocket ready at /terminal (tmux-backed, shell: %s)', defaultShell)

  let closePromise: Promise<void> | null = null
  const detachAndTerminate = () => {
    servers.forEach(httpServer => httpServer.off('upgrade', onUpgrade))
    for (const ws of wss.clients) ws.terminate()
  }
  return {
    forceClose: detachAndTerminate,
    close(): Promise<void> {
      if (closePromise) return closePromise
      detachAndTerminate()
      closePromise = new Promise(resolve => {
        wss.close(() => resolve())
      })
      return closePromise
    },
  }
}
