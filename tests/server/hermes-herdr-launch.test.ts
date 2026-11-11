import { describe, expect, it } from 'vitest'
import { tmpdir } from 'node:os'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { findHermesCli, hermesCliAvailable, hermesCliPath, hermesInteractiveLaunch, hermesNewChatLaunch } from '../../packages/server/src/modules/hermes/services/herdr-launch'

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

  it('finds the CLI where Studio\'s Docker image puts it (HERMES_BIN) or on PATH', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hermes-cli-'))
    const bin = join(dir, 'hermes')
    writeFileSync(bin, '#!/bin/sh\n')
    const home = join(tmpdir(), 'no-such-home')
    expect(findHermesCli(home, { HERMES_BIN: bin, PATH: '' })).toBe(bin)
    expect(findHermesCli(home, { PATH: `/nowhere:${dir}` })).toBe(bin)
    expect(findHermesCli(home, { HERMES_BIN: join(dir, 'missing'), PATH: '' })).toBeNull()
  })

  it('starts a fresh hermes chat for agents launched from herdr', () => {
    const launch = hermesNewChatLaunch('/home/u/project')
    expect(launch.args).toEqual(['chat'])
    expect(launch.workspaceDir).toBe('/home/u/project')
    expect(hermesNewChatLaunch().workspaceDir).not.toBe('')
  })
})
