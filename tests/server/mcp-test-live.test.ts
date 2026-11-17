import { describe, expect, it } from 'vitest'
import { checkMcpSecrets, testMcpServerLive } from '../../packages/server/src/modules/hermes/controllers/mcp'

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

describe('MCP server secrets', () => {
  const config = { url: 'http://ha:8123/api/mcp', headers: { Authorization: 'Bearer ${MCP_HA_API_KEY}' } }
  it('accepts MCP_ secrets that the config uses', () => {
    expect(checkMcpSecrets(config, undefined)).toBeNull()
    expect(checkMcpSecrets(config, { MCP_HA_API_KEY: 'tok' })).toBeNull()
  })
  it('rejects other names, unused secrets and multi-line values', () => {
    expect(checkMcpSecrets(config, { OPENAI_API_KEY: 'x' })).toMatch(/MCP_/)
    expect(checkMcpSecrets(config, { MCP_OTHER_API_KEY: 'x' })).toMatch(/not used/)
    expect(checkMcpSecrets(config, { MCP_HA_API_KEY: 'a\nb' })).toMatch(/single line/)
    expect(checkMcpSecrets(config, ['x'])).toMatch(/object/)
  })
})
