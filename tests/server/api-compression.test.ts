import Koa from 'koa'
import { get } from 'http'
import { PassThrough } from 'stream'
import { gunzipSync } from 'zlib'
import { describe, expect, it } from 'vitest'
import { createApiCompressionMiddleware } from '../../packages/server/src/modules/studio/middleware/api-compression'

async function call(body: unknown, options: { path?: string; acceptEncoding?: string; status?: number } = {}) {
  const app = new Koa()
  app.use(createApiCompressionMiddleware())
  app.use(ctx => { ctx.status = options.status ?? 200; ctx.body = body as any })
  const server = app.listen(0)
  try {
    const port = (server.address() as { port: number }).port
    // node:http hands back the raw bytes; fetch would decompress them.
    return await new Promise<{ res: { headers: { get(name: string): string | null } }; raw: Buffer }>((resolve, reject) => {
      get({ host: '127.0.0.1', port, path: options.path ?? '/api/studio/sessions', headers: { 'Accept-Encoding': options.acceptEncoding ?? 'gzip, deflate, br' } }, response => {
        const chunks: Buffer[] = []
        response.on('data', chunk => chunks.push(chunk))
        response.on('end', () => resolve({
          res: { headers: { get: name => { const value = response.headers[name.toLowerCase()]; return value === undefined ? null : String(value) } } },
          raw: Buffer.concat(chunks),
        }))
      }).on('error', reject)
    })
  } finally {
    server.close()
  }
}

const big = { sessions: Array.from({ length: 200 }, (_, i) => ({ id: `s-${i}`, title: `Chat ${i} about the homelab`, preview: 'How do I set up the reverse proxy?' })) }

describe('api compression', () => {
  it('gzips large JSON answers of /api routes', async () => {
    const { res, raw } = await call(big)
    expect(res.headers.get('content-encoding')).toBe('gzip')
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(raw.byteLength).toBeLessThan(JSON.stringify(big).length / 5)
    expect(JSON.parse(gunzipSync(raw).toString())).toEqual(big)
  })

  it('leaves small answers, other paths, errors and clients without gzip alone', async () => {
    for (const result of [
      await call({ ok: true }),
      await call(big, { path: '/v1/models' }),
      await call(big, { status: 404 }),
      await call(big, { acceptEncoding: 'identity' }),
      await call(big, { acceptEncoding: '' }),
    ]) {
      expect(result.res.headers.get('content-encoding')).toBeNull()
      expect(() => JSON.parse(result.raw.toString())).not.toThrow()
    }
  })

  it('leaves strings, buffers and streams alone', async () => {
    const stream = new PassThrough(); stream.end('data: x\n\n')
    for (const body of ['x'.repeat(5000), Buffer.alloc(5000, 120), stream]) {
      const { res } = await call(body)
      expect(res.headers.get('content-encoding')).toBeNull()
    }
  })
})
