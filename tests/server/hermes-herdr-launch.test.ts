import { describe, expect, it } from 'vitest'
import { tmpdir } from 'node:os'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { findHermesCli, hermesCliAvailable, hermesCliPath, hermesInteractiveLaunch, hermesModelArgs, hermesNewChatLaunch } from '../../packages/server/src/modules/hermes/services/herdr-launch'

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

  it("runs the pane in the chat's profile and on the chat's model", () => {
    const home = (profile: string) => `/hermes/profiles/${profile}`
    const launch = hermesInteractiveLaunch({ id: 's1', profile: 'work', model: 'qwen3-8b', provider: 'custom:llama-swap' }, home)
    expect(launch.env).toEqual({ HERMES_HOME: '/hermes/profiles/work' })
    expect(launch.args).toEqual(['chat', '--resume', 's1', '--create-if-missing', '-m', 'qwen3-8b', '--provider', 'custom:llama-swap'])
    // No model of its own: the profile's default model (no -m), default profile when none is stored.
    const plain = hermesInteractiveLaunch({ id: 's2' }, home)
    expect(plain.env).toEqual({ HERMES_HOME: '/hermes/profiles/default' })
    expect(plain.args).not.toContain('-m')
  })

  it('maps Studio provider keys to the names Hermes runs them under', () => {
    expect(hermesModelArgs('claude-sonnet-4.6', 'claude-oauth')).toEqual(['-m', 'claude-sonnet-4.6', '--provider', 'anthropic'])
    expect(hermesModelArgs('some-model', 'global')).toEqual(['-m', 'some-model'])
    expect(hermesModelArgs('', 'openrouter')).toEqual([])
  })

  it("starts a new hermes chat in herdr's profile, on a picked model or the profile default", () => {
    const home = (profile: string) => `/h/${profile}`
    expect(hermesNewChatLaunch('/w', { profile: 'work', profileHome: home })).toMatchObject({ args: ['chat'], env: { HERMES_HOME: '/h/work' }, model: '' })
    expect(hermesNewChatLaunch('/w', { profile: 'work', provider: 'openrouter', model: 'a/b', profileHome: home }))
      .toMatchObject({ args: ['chat', '-m', 'a/b', '--provider', 'openrouter'], provider: 'openrouter', model: 'a/b' })
  })
})
