import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import type { IncomingMessage, Server } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type WebSocket } from 'ws'
import { authenticateUserToken } from '../../public/auth'
import { bridgeScript, type ScreenManager } from './manager'

export const SCREEN_WS_PATH = '/api/studio/screen/ws'
const TICKET_MS = 30_000
export const CLOSE_CONTROL_TAKEN = 4000
export const CLOSE_SCREEN_GONE = 4001
export const CLOSE_BAD_TICKET = 4401

interface Ticket { viewerId: string; userToken: string; expires: number }

/**
 * Viewers of the agents' screen. A signed-in super administrator gets a
 * single-use, 30-second ticket (POST /api/studio/screen/ticket); the viewer
 * (noVNC) opens SCREEN_WS_PATH?ticket=… and Studio pipes the screen's RFB
 * stream through Hermes's own input filter (bin/bot-screen-bridge.py), so
 * keyboard and mouse only reach the screen from the viewer holding control.
 */
export class ScreenGateway {
  private tickets = new Map<string, Ticket>()
  private wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 1024 * 1024 })
  private sockets = new Set<WebSocket>()

  constructor(private readonly manager: ScreenManager) {}

  /** Each viewer (a browser tab) keeps its own id; Studio prefixes it with the user. */
  static viewerId(userId: string | number, clientId: string): string {
    return `studio:${userId}:${String(clientId || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) || 'viewer'}`
  }

  createTicket(viewerId: string, userToken: string): string {
    const now = Date.now()
    for (const [id, ticket] of this.tickets) if (ticket.expires < now) this.tickets.delete(id)
    const id = randomBytes(24).toString('hex')
    this.tickets.set(id, { viewerId, userToken, expires: now + TICKET_MS })
    return id
  }

  private takeTicket(id: string): Ticket | null {
    const ticket = this.tickets.get(id)
    this.tickets.delete(id)
    return ticket && ticket.expires >= Date.now() ? ticket : null
  }

  handlesUpgrade(req: IncomingMessage): boolean {
    return (req.url || '').split('?')[0] === SCREEN_WS_PATH
  }

  attach(servers: Server[]): () => void {
    const upgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      if (!this.handlesUpgrade(req)) return
      // Only Studio's own pages may open the screen.
      try {
        if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) {
          socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); socket.destroy(); return
        }
      } catch { socket.destroy(); return }
      this.wss.handleUpgrade(req, socket, head, ws => { void this.connect(ws, req) })
    }
    for (const server of servers) server.on('upgrade', upgrade)
    return () => {
      for (const server of servers) server.off('upgrade', upgrade)
      for (const ws of this.sockets) ws.terminate()
      this.wss.close()
    }
  }

  private async connect(ws: WebSocket, req: IncomingMessage) {
    const url = new URL(req.url || '/', 'http://studio.invalid')
    const ticket = this.takeTicket(url.searchParams.get('ticket') || '')
    const user = ticket ? await authenticateUserToken(ticket.userToken).catch(() => null) : null
    if (!ticket || user?.role !== 'super_admin') { ws.close(CLOSE_BAD_TICKET, 'ticket missing, expired or used'); return }
    const python = this.manager.python
    if (!python) { ws.close(CLOSE_SCREEN_GONE, 'Hermes is not installed'); return }
    this.sockets.add(ws)
    const child = spawn(python, [bridgeScript(), 'bridge', ticket.viewerId], {
      env: { ...process.env, HERMES_HOME: this.manager.home, STUDIO_SCREEN_HOME: this.manager.home },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let cleanClose = false
    let finished = false
    const finish = (code: number, reason: string) => {
      if (finished) return
      finished = true
      if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close(code, reason)
    }
    child.stdout.on('data', (chunk: Buffer) => {
      if (ws.readyState !== ws.OPEN) return
      ws.send(chunk, { binary: true })
      // Backpressure toward the screen: pause while the browser is behind.
      if (ws.bufferedAmount > 8 * 1024 * 1024) {
        child.stdout.pause()
        const resume = setInterval(() => {
          if (ws.readyState !== ws.OPEN || ws.bufferedAmount < 1024 * 1024) { clearInterval(resume); child.stdout.resume() }
        }, 50)
      }
    })
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-500) })
    child.stdin.on('error', () => undefined)
    ws.on('message', (data, isBinary) => {
      if (!isBinary) { finish(1003, 'RFB is binary'); return }
      child.stdin.write(data as Buffer)
    })
    // Revalidate the login every minute: signing out closes the screen.
    const revalidate = setInterval(() => {
      void authenticateUserToken(ticket.userToken).then(current => { if (current?.role !== 'super_admin') finish(CLOSE_BAD_TICKET, 'signed out') }).catch(() => finish(CLOSE_BAD_TICKET, 'signed out'))
    }, 60_000)
    revalidate.unref()
    ws.on('close', (code) => {
      clearInterval(revalidate)
      this.sockets.delete(ws)
      cleanClose = code === 1000 || code === 1001
      child.stdin.end()
      setTimeout(() => { if (child.exitCode === null) child.kill('SIGTERM') }, 2000).unref()
      // Closing the viewer hands control back; a dropped link keeps it (the
      // person may be mid-login on that screen).
      if (cleanClose) void this.manager.lease('release', ticket.viewerId).catch(() => undefined)
    })
    child.once('exit', (code) => {
      if (code === 40) finish(CLOSE_CONTROL_TAKEN, 'control-taken')
      else if (code === 41) finish(CLOSE_SCREEN_GONE, 'screen is not running')
      else finish(code === 0 ? 1000 : 1011, (stderr.trim().split(/\r?\n/).pop() || 'screen bridge ended').slice(0, 100))
    })
  }
}
