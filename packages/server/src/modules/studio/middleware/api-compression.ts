import type { Middleware } from 'koa'
import { promisify } from 'util'
import { gzip as gzipCallback, constants as zlibConstants } from 'zlib'
import { selectStaticCompressionEncoding } from './static-compression'

const gzip = promisify(gzipCallback)

export interface ApiCompressionOptions {
  minBytes?: number
}

/**
 * Compresses JSON answers of /api routes. Koa serializes object bodies after
 * every middleware, so the static compression further down never sees them:
 * the chat list alone is about 1 KB a chat, sent uncompressed on every poll.
 * Streams, strings and buffers (SSE, files, proxies) are left alone.
 */
export function createApiCompressionMiddleware(options: ApiCompressionOptions = {}): Middleware {
  const minBytes = options.minBytes ?? 2048
  return async (ctx, next) => {
    await next()
    if (!ctx.path.startsWith('/api/')) return
    if (ctx.method === 'HEAD' || ctx.status < 200 || ctx.status >= 300 || ctx.status === 204) return
    if (ctx.response.get('Content-Encoding')) return
    const body = ctx.body
    if (!body || typeof body !== 'object' || Buffer.isBuffer(body) || typeof (body as { pipe?: unknown }).pipe === 'function') return
    if (ArrayBuffer.isView(body) || body instanceof ArrayBuffer) return
    // Only when the client lists gzip (no header means no compression).
    if (selectStaticCompressionEncoding(ctx.get('Accept-Encoding'), { bodyLength: Infinity, maxBrotliBytes: 0 }) !== 'gzip') return
    const json = Buffer.from(JSON.stringify(body))
    ctx.vary('Accept-Encoding')
    if (json.byteLength < minBytes) return
    // Level 5: most of the ratio of the default for about half the CPU.
    const compressed = await gzip(json, { level: 5, memLevel: 9, strategy: zlibConstants.Z_DEFAULT_STRATEGY })
    ctx.type = 'application/json'
    ctx.set('Content-Encoding', 'gzip')
    ctx.body = compressed
    ctx.set('Content-Length', String(compressed.byteLength))
  }
}
