import { describe, expect, it } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hermesCliAvailable, hermesCliPath, hermesInteractiveLaunch, hermesNewChatLaunch } from '../../packages/server/src/modules/hermes/services/herdr-launch'

describe('hermes chats in herdr', () => {
  it('resumes the Studio session in an interactive hermes pane', () => {
    const launch = hermesInteractiveLaunch({ id: 'mukx4i2vk5c1lc', workspace: '/home/u/project' })
    expect(launch.agentId).toBe('hermes')
    expect(launch.args).toEqual(['chat', '--resume', 'mukx4i2vk5c1lc', '--create-if-missing'])
    expect(launch.workspaceDir).toBe('/home/u/project')
  })

  it("prefers the agent's own session id for chats imported from herdr", () => {
    const launch = hermesInteractiveLaunch({ id: 'herdr-abc123', agent_native_session_id: 'abc123' })
    expect(launch.args).toContain('abc123')
    expect(launch.args).not.toContain('herdr-abc123')
  })

  it('falls back to PATH when the installed CLI is missing', () => {
    expect(hermesCliPath(join(tmpdir(), 'no-such-home'))).toBe('hermes')
    expect(hermesCliAvailable(join(tmpdir(), 'no-such-home'))).toBe(false)
  })

  it('starts a fresh hermes chat for agents launched from herdr', () => {
    const launch = hermesNewChatLaunch('/home/u/project')
    expect(launch.args).toEqual(['chat'])
    expect(launch.workspaceDir).toBe('/home/u/project')
    expect(hermesNewChatLaunch().workspaceDir).not.toBe('')
  })
})
