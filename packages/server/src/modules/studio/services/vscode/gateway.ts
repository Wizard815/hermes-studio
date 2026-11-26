import { randomBytes } from 'node:crypto'
import { request, type IncomingMessage, type Server } from 'node:http'
import type { Duplex } from 'node:stream'
import type { Context, Next } from 'koa'
import { authenticateUserToken } from '../../public/auth'
import type { VsCodeManager } from './manager'

export const VSCODE_PREFIX = '/vscode/'
const TICKET_HOURS = 12
const MAX_TICKETS = 64
const TICKET = /^([a-f0-9]{48})(\/.*)?$/

interface Ticket { userToken: string; expires: number; connections: Set<Duplex> }

/** Headers never sent on to code-server (Studio's login stays with Studio). */
const DROPPED_REQUEST_HEADERS = new Set(['authorization', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'forwarded'])

/**
 * Serves code-server at /vscode/<ticket>/. A ticket is made for a signed-in
 * super administrator (POST /api/vscode/session) and is checked against their
 * login on every request and every minute on open connections, so signing out
 * or losing the role closes VS Code. code-server itself has no login and only
 * listens on a Unix socket.
 */
export class VsCodeGateway {
  private tickets = new Map<string, Ticket>()

  constructor(private manager: VsCodeManager) {}

  async create(userToken: string): Promise<{ id: string; path: string }> {
    const user = await authenticateUserToken(userToken)
    if (user?.role !== 'super_admin') throw Object.assign(new Error('Super administrator required'), { status: 403 })
    for (const [id, ticket] of this.tickets) if (ticket.expires < Date.now()) this.drop(id)
    if (this.tickets.size >= MAX_TICKETS) {
      const oldest = [...this.tickets.entries()].sort((a, b) => a[1].expires - b[1].expires)[0]
      if (oldest) this.drop(oldest[0])
    }
    const id = randomBytes(24).toString('hex')
    this.tickets.set(id, { userToken, expires: Date.now() + TICKET_HOURS * 3600_000, connections: new Set() })
    return { id, path: `${VSCODE_PREFIX}${id}/` }
  }

  remove(id: string, userToken: string) {
    if (this.tickets.get(id)?.userToken === userToken) this.drop(id)
  }

  private drop(id: string) {
    const ticket = this.tickets.get(id)
    this.tickets.delete(id)
    for (const connection of ticket?.connections || []) connection.destroy()
  }

  handlesUpgrade(req: IncomingMessage): boolean {
    return (req.url || '').startsWith(VSCODE_PREFIX)
  }

  /** The ticket for a /vscode/... path, if it is still good, and the path inside code-server. */
  private async open(pathname: string): Promise<{ id: string; ticket: Ticket; inner: string } | null> {
    const match = TICKET.exec(pathname.slice(VSCODE_PREFIX.length))
    const ticket = match ? this.tickets.get(match[1]) : undefined
    if (!match || !ticket || ticket.expires < Date.now()) return null
    const user = await authenticateUserToken(ticket.userToken).catch(() => null)
    if (user?.role !== 'super_admin') { this.drop(match[1]); return null }
    return { id: match[1], ticket, inner: match[2] || '' }
  }

  middleware = async (ctx: Context, next: Next) => {
    if (!ctx.path.startsWith(VSCODE_PREFIX)) return next()
    ctx.set('Cache-Control', 'no-store')
    const opened = await this.open(ctx.path)
    if (!opened) {
      ctx.status = 401
      ctx.type = 'text/plain'
      ctx.body = 'This VS Code link has expired. Reopen VS Code from Studio.'
      return
    }
    const origin = ctx.get('Origin')
    if (origin) {
      try { if (new URL(origin).host !== ctx.host) { ctx.status = 403; return } } catch { ctx.status = 403; return }
    }
    if (!opened.inner) {
      // Relative links in code-server's pages need the trailing slash.
      ctx.redirect(`${VSCODE_PREFIX}${opened.id}/${ctx.search}`)
      return
    }
    try { await this.manager.ensureRunning() } catch (error: any) {
      ctx.status = 503
      ctx.type = 'text/plain'
      ctx.body = `VS Code is not running: ${error?.message || error}`
      return
    }
    this.manager.touch()
    const mount = `${VSCODE_PREFIX}${opened.id}`
    const headers: Record<string, string | string[]> = {}
    for (const [name, value] of Object.entries(ctx.req.headers)) {
      if (value !== undefined && !DROPPED_REQUEST_HEADERS.has(name)) headers[name] = value
    }
    ctx.respond = false
    const res = ctx.res
    await new Promise<void>((resolve) => {
      const upstream = request({ socketPath: this.manager.socketPath, method: ctx.method, path: opened.inner + ctx.search, headers }, (response) => {
        // Studio's own frame and script rules would block VS Code in Studio's frame.
        res.removeHeader('X-Frame-Options')
        res.removeHeader('Content-Security-Policy')
        res.removeHeader('Cache-Control')
        res.setHeader('X-Frame-Options', 'SAMEORIGIN')
        const outgoing: Record<string, string | string[]> = {}
        for (const [name, value] of Object.entries(response.headers)) {
          if (value === undefined || name === 'x-frame-options') continue
          if (name === 'location' && typeof value === 'string' && value.startsWith('/')) outgoing[name] = mount + value
          else if (name === 'content-security-policy' && typeof value === 'string') outgoing[name] = value.replace(/frame-ancestors[^;]*/g, "frame-ancestors 'self'")
          else outgoing[name] = value
        }
        res.writeHead(response.statusCode || 502, outgoing)
        response.pipe(res)
        response.once('end', resolve)
        response.once('error', () => { res.destroy(); resolve() })
      })
      upstream.once('error', () => {
        if (!res.headersSent) { res.statusCode = 502; res.end('VS Code is not answering') } else res.destroy()
        resolve()
      })
      res.once('close', () => { upstream.destroy(); resolve() })
      ctx.req.pipe(upstream)
    })
  }

  attach(servers: Server[]): () => void {
    const tunnels = new Set<Duplex>()
    const upgrade = async (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      if (!this.handlesUpgrade(req)) return
      const reject = (status = '403 Forbidden') => {
        if (!socket.destroyed) { socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`); socket.destroy() }
      }
      socket.on('error', () => socket.destroy())
      try {
        const url = new URL(req.url || '/', 'http://studio.invalid')
        const opened = await this.open(url.pathname)
        if (!opened || !opened.inner) return reject()
        if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) return reject()
        await this.manager.ensureRunning()
        const headers: Record<string, string | string[]> = {}
        for (const [name, value] of Object.entries(req.headers)) {
          if (value !== undefined && !DROPPED_REQUEST_HEADERS.has(name)) headers[name] = value
        }
        const upstream = request({ socketPath: this.manager.socketPath, method: req.method, path: opened.inner + url.search, headers })
        const timer = setTimeout(() => { upstream.destroy(); reject('504 Gateway Timeout') }, 15_000)
        upstream.once('error', () => { clearTimeout(timer); reject('502 Bad Gateway') })
        upstream.once('response', (response) => { clearTimeout(timer); response.resume(); reject(`${response.statusCode || 502} Refused`) })
        upstream.once('upgrade', (response, peer, upstreamHead) => {
          clearTimeout(timer)
          if (socket.destroyed) { peer.destroy(); return }
          const lines = [`HTTP/1.1 101 ${response.statusMessage || 'Switching Protocols'}`]
          for (let index = 0; index < response.rawHeaders.length; index += 2) lines.push(`${response.rawHeaders[index]}: ${response.rawHeaders[index + 1]}`)
          socket.write(`${lines.join('\r\n')}\r\n\r\n`)
          if (upstreamHead.length) socket.write(upstreamHead)
          if (head.length) peer.write(head)
          opened.ticket.connections.add(socket)
          tunnels.add(socket)
          this.manager.tunnelOpened()
          const revalidate = setInterval(() => {
            void this.open(url.pathname).then(still => { if (!still) socket.destroy() })
          }, 60_000)
          revalidate.unref()
          let closed = false
          const close = () => {
            if (closed) return
            closed = true
            clearInterval(revalidate)
            opened.ticket.connections.delete(socket)
            tunnels.delete(socket)
            this.manager.tunnelClosed()
            peer.destroy()
            socket.destroy()
          }
          peer.on('error', close); socket.on('error', close)
          peer.once('close', close); socket.once('close', close)
          socket.pipe(peer); peer.pipe(socket)
        })
        upstream.end()
      } catch { reject('502 Bad Gateway') }
    }
    for (const server of servers) server.on('upgrade', upgrade)
    return () => {
      for (const server of servers) server.off('upgrade', upgrade)
      for (const socket of tunnels) socket.destroy()
    }
  }
}
