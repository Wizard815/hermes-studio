import { execFile } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { WatcherStore } from '../../packages/server/src/modules/studio/services/watcher/store'
import { WatcherConfigFile } from '../../packages/server/src/modules/studio/services/watcher/config'
import { closeWatcher, configureWatcher, givenTrustAction, observeWatcherChatEvent } from '../../packages/server/src/modules/studio/services/watcher'

afterEach(() => closeWatcher())

describe('Home Assistant actions in Hermes chats ask first', () => {
  it('the bridge sends service calls through Hermes\'s approval gate and lets reads through', async () => {
    const { stdout } = await promisify(execFile)(process.platform === 'win32' ? 'python' : 'python3', ['-B', resolve('tests/server/fixtures/hermes-bridge-home-assistant.py')], {
      cwd: resolve('.'), timeout: 25_000, maxBuffer: 1024 * 1024, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    })
    expect(stdout).toContain('Hermes bridge Home Assistant approvals verified')
  }, 30_000)

  it('"Trust this" sees the service, and a rule like light.* lets the next call run', () => {
    const service = configureWatcher({
      store: new WatcherStore(new DatabaseSync(':memory:')),
      config: new WatcherConfigFile(() => join(mkdtempSync(join(tmpdir(), 'watcher-ha-')), 'watcher.json')),
    })
    observeWatcherChatEvent('chat-ha', 'approval.requested', {
      approval_id: 'ha-1', command: 'Home Assistant: light.turn_on on light.bed_light', trust_action: { kind: 'tool', value: 'light.turn_on' },
    }, 'bridge')
    expect(service.list().events[0]).toMatchObject({ kind: 'approval_asked', agent: 'hermes', action: { kind: 'tool', value: 'light.turn_on' } })

    service.addRule({ kind: 'tool', scope: 'agent', target: 'hermes', pattern: 'light.*' })
    const context = { sessionId: 'chat-ha', agentId: 'hermes' }
    expect(service.trusts(context, { kind: 'tool', values: ['light.turn_on'] })).not.toBeNull()
    expect(service.trusts(context, { kind: 'tool', values: ['switch.turn_off'] })).toBeNull()
    // A command rule does not answer a Home Assistant action.
    expect(service.trusts(context, { kind: 'command', values: ['light.turn_on'] })).toBeNull()
  })

  it('only well-formed trust actions from the bridge are used', () => {
    expect(givenTrustAction({ kind: 'tool', value: 'light.turn_on' })).toEqual({ kind: 'tool', value: 'light.turn_on' })
    expect(givenTrustAction({ kind: 'shell', value: 'x' })).toBeUndefined()
    expect(givenTrustAction({ kind: 'tool', value: '' })).toBeUndefined()
    expect(givenTrustAction('light.turn_on')).toBeUndefined()
  })
})
