import { describe, expect, it } from 'vitest'
import { testMcpServerLive } from '../../packages/server/src/modules/hermes/controllers/mcp'

const reply = (status: number, body: unknown) => async () => ({ status, contentType: 'application/json', body: Buffer.from(JSON.stringify(body)) })

describe('MCP server test', () => {
  it("reports Hermes's real connection failure", async () => {
    const result = await testMcpServerLive('deepwiki', 'default', { hermes: reply(200, { ok: false, error: '403 Forbidden', tools: [] }), bridge: async () => ({ ok: true, tools: [] }) })
    expect(result).toEqual({ ok: false, tools: [], error: '403 Forbidden' })
  })
  it('lists the tools when it connects', async () => {
    const result = await testMcpServerLive('deepwiki', 'default', { hermes: reply(200, { ok: true, tools: [{ name: 'ask_question' }, 'read_wiki'] }), bridge: async () => ({}) })
    expect(result).toEqual({ ok: true, tools: ['ask_question', 'read_wiki'] })
  })
  it('falls back to the bridge, and an empty tool list is not a pass', async () => {
    const down = async () => { throw new Error('down') }
    expect(await testMcpServerLive('x', undefined, { hermes: down, bridge: async () => ({ ok: true, tools: [] }) })).toMatchObject({ ok: false })
    expect(await testMcpServerLive('x', undefined, { hermes: down, bridge: async () => ({ ok: true, tools: ['a'] }) })).toEqual({ ok: true, tools: ['a'] })
  })
})
