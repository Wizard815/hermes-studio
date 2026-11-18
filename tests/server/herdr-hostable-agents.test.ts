import { describe, expect, it } from 'vitest'
import { herdrHostableAgentId, herdrStoredAgent } from '../../packages/server/src/bootstrap/herdr'

describe('which chats herdr can host', () => {
  it('reads a chat with no stored agent as a Hermes chat (older Studio chats)', () => {
    for (const agent of ['', '  ', null, undefined]) {
      expect(herdrStoredAgent(agent)).toBe('hermes')
      expect(herdrHostableAgentId(agent)).toBe('hermes')
    }
    expect(herdrHostableAgentId('', 'cli')).toBe('hermes')
    expect(herdrHostableAgentId('', 'api_server')).toBe('hermes')
  })

  it('keeps Ekko chats (stored or by source) out of herdr panes: they use Studio\'s chat client there', () => {
    expect(herdrStoredAgent('', 'builtin_agent')).toBe('ekko-agent')
    expect(herdrHostableAgentId('', 'builtin_agent')).toBeNull()
    expect(herdrHostableAgentId('ekko-agent')).toBeNull()
  })

  it('maps stored coding agents to herdr agents as before', () => {
    expect(herdrHostableAgentId('hermes')).toBe('hermes')
    expect(herdrHostableAgentId('claude')).toBe('claude-code')
    expect(herdrHostableAgentId('codex')).toBe('codex')
    expect(herdrHostableAgentId('dsh')).toBeNull()
  })
})
