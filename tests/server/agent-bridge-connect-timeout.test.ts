import { describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentBridgeClient } from '../../packages/server/src/modules/hermes/services/bridge/client'

// Opening a chat asks the bridge for the chat's run with a 1 s timeout. While
// the bridge was down that lookup waited out the whole 5 s connect-retry window
// before the chat's messages were sent.
describe('TestAgentBridge_timeoutBoundsConnectRetries', () => {
  it('a short request timeout also bounds the connect retries', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bridge-down-'))
    try {
      const client = new AgentBridgeClient({ endpoint: `ipc://${join(dir, 'missing.sock')}`, connectRetryMs: 5000 })
      const started = Date.now()
      await expect(client.statusIfLoaded('chat-1', 'default', { timeoutMs: 300 })).rejects.toMatchObject({ code: 'ENOENT' })
      expect(Date.now() - started).toBeLessThan(1500)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('without a timeout it still retries for the client window', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bridge-down-'))
    try {
      const client = new AgentBridgeClient({ endpoint: `ipc://${join(dir, 'missing.sock')}`, connectRetryMs: 600 })
      const started = Date.now()
      await expect(client.statusIfLoaded('chat-1', 'default')).rejects.toMatchObject({ code: 'ENOENT' })
      expect(Date.now() - started).toBeGreaterThanOrEqual(500)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
