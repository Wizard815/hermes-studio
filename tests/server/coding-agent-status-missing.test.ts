import { describe, expect, it } from 'vitest'
import { getCodingAgentDefinition, getCodingAgentStatus } from '../../packages/server/src/modules/coding-agents/services/index'

describe('status of a coding agent that is not installed', () => {
  it('says the agent is not installed, not that Node/npm is missing', async () => {
    // Node and npm are there (this test runs on them); only the agent's own command is missing.
    const kimi = getCodingAgentDefinition('kimi')!
    const status = await getCodingAgentStatus({ ...kimi, command: 'studio-test-agent-that-is-not-installed' })
    expect(status.installed).toBe(false)
    expect(status.source).toBe('not-installed')
    expect(status.error).toBe(`${kimi.name} is not installed`)
    expect(status.error).not.toMatch(/Node\/npm/)
  })
})
