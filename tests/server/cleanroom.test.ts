import { describe, expect, it } from 'vitest'
import {
  cleanRoomCommand, cleanRoomEnv, cleanRoomExec, containerName, hostAllowed, parseCleanRoomCommand,
  sanitizeCleanRoomSettings, studioPathAllowed, DEFAULT_CLEANROOM_SETTINGS,
} from '../../packages/server/src/modules/coding-agents/services/cleanroom'

describe('clean rooms', () => {
  it('marks a launch as running in a container and reads it back', () => {
    const command = cleanRoomCommand('studio-cleanroom-abc', '/opt/npm/bin/claude')
    expect(parseCleanRoomCommand(command)).toEqual({ container: 'studio-cleanroom-abc', command: '/opt/npm/bin/claude' })
    expect(parseCleanRoomCommand('/opt/npm/bin/claude')).toBeNull()
    expect(containerName('a/b c')).toBe('studio-cleanroom-a-b-c')
  })

  it('gives the agent only what Studio set for it, never the host environment', () => {
    const host = { PATH: '/usr/bin', SECRET_TOKEN: 's3cret', AWS_SECRET_ACCESS_KEY: 'x', HOME: '/home/me' }
    const env = cleanRoomEnv({ ...host, CODEX_HOME: '/studio/codex', HERMES_STUDIO_SESSION_ID: 'c1' }, host)
    expect(env.SECRET_TOKEN).toBeUndefined()
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined()
    expect(env.CODEX_HOME).toBe('/studio/codex')
    expect(env.HOME).toBe('/root')
    expect(env.HTTPS_PROXY).toBe('http://127.0.0.1:3128')
    expect(env.NO_PROXY).toContain('127.0.0.1')
  })

  it('runs the agent with docker exec in its own process group that waits for it', () => {
    const exec = cleanRoomExec('room', '/opt/npm/bin/codex', ['exec', '-'], '/work', { CODEX_HOME: '/c' }, { runId: 'r1' })
    expect(exec.command).toBe('docker')
    expect(exec.args.slice(0, 4)).toEqual(['exec', '-i', '-w', '/work'])
    expect(exec.args).toContain('CODEX_HOME=/c')
    const at = exec.args.indexOf('room')
    expect(exec.args.slice(at + 1, at + 3)).toEqual(['setsid', '-w'])
    expect(exec.args.slice(-3)).toEqual(['/opt/npm/bin/codex', 'exec', '-'])
  })

  it('lets the room reach only its model proxies in Studio, and only allowed hosts outside', () => {
    expect(studioPathAllowed('/api/codex-proxy/abc/v1/responses')).toBe(true)
    expect(studioPathAllowed('/api/claude-code-proxy/abc/v1/messages')).toBe(true)
    expect(studioPathAllowed('/api/auth/status')).toBe(false)
    expect(studioPathAllowed('/api/codex-proxy/../terminals')).toBe(false)
    const settings = { network: 'allowlist' as const, allowHosts: ['registry.npmjs.org', 'github.com'] }
    expect(hostAllowed('registry.npmjs.org', settings)).toBe(true)
    expect(hostAllowed('codeload.github.com', settings)).toBe(true)
    expect(hostAllowed('example.com', settings)).toBe(false)
    expect(hostAllowed('evilgithub.com', settings)).toBe(false)
    expect(hostAllowed('example.com', { ...settings, network: 'studio' })).toBe(false)
    expect(hostAllowed('example.com', { ...settings, network: 'internet' })).toBe(true)
  })

  it('keeps settings within sane bounds', () => {
    const next = sanitizeCleanRoomSettings({ image: 'rm -rf /', network: 'everything' as any, memory: '8g', cpus: 500, allowHosts: ['Pypi.org', 'bad host'] })
    expect(next.image).toBe(DEFAULT_CLEANROOM_SETTINGS.image)
    expect(next.network).toBe('allowlist')
    expect(next.memory).toBe('8g')
    expect(next.cpus).toBe(DEFAULT_CLEANROOM_SETTINGS.cpus)
    expect(next.allowHosts).toEqual(['pypi.org'])
  })
})
