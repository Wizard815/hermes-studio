import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_CLEANROOM_SETTINGS, hardeningArgs, managedClaudeSettings, resolveRoomUser, roomUid, sanitizeCleanRoomSettings, studioConfigMounts,
} from '../../packages/server/src/modules/coding-agents/services/cleanroom'
import { appendEgress, readEgress, verifyEgressChain } from '../../packages/server/src/modules/coding-agents/services/cleanroom/egress-log'
import { scanForLeaks } from '../../packages/server/src/modules/coding-agents/services/cleanroom/leaks'
import { judgeProbe, normalizeProbe, overallState, PROBE_SCRIPT, type ProbeOutput, type SelfCheckExpectations } from '../../packages/server/src/modules/coding-agents/services/cleanroom/probe'

const dirs: string[] = []
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'cleanroom-hardening-')); dirs.push(dir); return dir }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

describe('clean room walls', () => {
  it('drops every capability, makes the root read-only and runs as the given user by default', () => {
    const args = hardeningArgs(DEFAULT_CLEANROOM_SETTINGS, { uid: 1000, gid: 1000 })
    expect(args).toEqual(expect.arrayContaining(['--security-opt', 'no-new-privileges', '--cap-drop', 'ALL', '--read-only', '--user', '1000:1000']))
    expect(args).not.toContain('--cap-add')
    expect(args.filter(arg => arg.startsWith('/tmp:'))).toHaveLength(1)
    const loose = hardeningArgs({ ...DEFAULT_CLEANROOM_SETTINGS, readOnlyRoot: false, dropAllCaps: false }, { uid: 0, gid: 0 })
    expect(loose).not.toContain('--read-only')
    expect(loose).not.toContain('ALL')
    expect(loose).toContain('no-new-privileges')
    const back = hardeningArgs({ ...DEFAULT_CLEANROOM_SETTINGS, capAdd: ['CHOWN'] }, { uid: 1, gid: 1 })
    expect(back.join(' ')).toContain('--cap-add CHOWN')
  })

  it('keeps settings safe: unknown capabilities and users are refused', () => {
    const next = sanitizeCleanRoomSettings({ capAdd: ['cap_chown', 'SYS_ADMIN', 'net_raw'], user: 'admin' as any, readOnlyRoot: false, allowWebTools: 'yes' as any })
    expect(next.capAdd).toEqual(['CHOWN', 'NET_RAW'])
    expect(next.user).toBe('auto')
    expect(next.readOnlyRoot).toBe(false)
    expect(next.allowWebTools).toBe(false)
    expect(DEFAULT_CLEANROOM_SETTINGS).toMatchObject({ readOnlyRoot: true, dropAllCaps: true, selfCheck: true, leakCheck: true, egressLog: true, auditChain: true, allowWebTools: false })
  })

  it('picks a non-root user: Studio\'s own, the folder owner, or one per room', () => {
    expect(resolveRoomUser('auto', 's1', { uid: 1000, gid: 1000 }, { uid: 501, gid: 20 })).toEqual({ uid: 501, gid: 20 })
    expect(resolveRoomUser('auto', 's1', { uid: 1000, gid: 1000 }, { uid: 0, gid: 0 })).toEqual({ uid: 1000, gid: 1000 })
    const room = resolveRoomUser('room', 's1', { uid: 0, gid: 0 }, { uid: 0, gid: 0 })
    expect(room.uid).toBe(roomUid('s1'))
    expect(room.uid).toBeGreaterThanOrEqual(20000)
    expect(resolveRoomUser('root', 's1', { uid: 1000, gid: 1000 }, { uid: 0, gid: 0 })).toEqual({ uid: 0, gid: 0 })
  })

  it('denies Claude Code\'s web tools unless the setting allows them', () => {
    expect(managedClaudeSettings(false)).toEqual({ permissions: { deny: ['WebSearch', 'WebFetch'] } })
    expect(managedClaudeSettings(true)).toEqual({})
  })

  it('mounts Studio\'s prompt files read-only and the agent\'s own home writable', () => {
    const root = join(process.env.HERMES_WEB_UI_HOME || join(process.env.HOME || '', '.hermes-web-ui'), 'coding-agent', 'model')
    const agentHome = join(root, 'default', 'openai', 'codex')
    const prompts = join(root, 'default', 'anthropic', 'claude')
    const mounts = studioConfigMounts(['--append-system-prompt-file', join(prompts, 'prompt.md')], { CODEX_HOME: join(agentHome, 'home') })
    expect(mounts.configs).toEqual([agentHome])
    expect(mounts.readOnlyConfigs).toEqual([prompts])
  })

  it('finds config folders in a provider account\'s tree too', () => {
    const home = process.env.HERMES_WEB_UI_HOME || join(process.env.HOME || '', '.hermes-web-ui')
    const agent = join(home, 'providers', 'users', '1', 'coding-agent', 'model', 'default', 'custom_fake', 'claude-code')
    const mounts = studioConfigMounts(['--settings', join(agent, 'runs', 'abc', 'settings.json')], { HOME: '/root' })
    expect(mounts.readOnlyConfigs).toEqual([join(agent, 'runs', 'abc')])
    expect(studioConfigMounts([join(home, 'providers', 'users', '1', 'secrets.json')]).readOnlyConfigs).toEqual([])
  })
})

describe('clean room leak check', () => {
  it('names files that usually hold secrets, never their contents, and skips dependency folders', () => {
    const dir = temp()
    const put = (path: string, text = 'x') => { mkdirSync(join(dir, path, '..'), { recursive: true }); writeFileSync(join(dir, path), text) }
    put('.env', 'API_KEY=supersecret')
    put('.env.example', 'API_KEY=')
    put('app/.env.production')
    put('id_rsa')
    put('certs/server.pem')
    put('credentials.json')
    put('.aws/credentials')
    put('notes/credentials')
    put('.npmrc', '//registry.npmjs.org/:_authToken=npm_abc\n')
    put('pkg/.npmrc', 'save-exact=true\n')
    put('.docker/config.json', '{"auths":{"x":{"auth":"Zm9v"}}}')
    put('src/config.json', '{"auth":"not docker"}')
    put('node_modules/dep/.env')
    put('README.md')
    const report = scanForLeaks(dir)
    const found = Object.fromEntries(report.findings.map(finding => [finding.path, finding.kind]))
    expect(found).toEqual({
      '.env': 'env',
      'app/.env.production': 'env',
      id_rsa: 'ssh-key',
      'certs/server.pem': 'private-key',
      'credentials.json': 'credentials',
      '.aws/credentials': 'credentials',
      '.npmrc': 'token-config',
      '.docker/config.json': 'token-config',
    })
    expect(JSON.stringify(report)).not.toContain('supersecret')
    expect(report.truncated).toBe(false)
  })

  it('stops after a bounded number of entries', () => {
    const dir = temp()
    for (let index = 0; index < 30; index += 1) writeFileSync(join(dir, `f${index}.txt`), '')
    expect(scanForLeaks(dir, { maxEntries: 10 }).truncated).toBe(true)
  })
})

describe('clean room egress log', () => {
  it('writes one JSON line per attempt and links each line to the one before', () => {
    const file = join(temp(), 'room.jsonl')
    appendEgress(file, { host: 'example.com', port: 443, allowed: false, reason: 'not allowed (allowlist)' })
    appendEgress(file, { host: 'registry.npmjs.org', port: 443, allowed: true })
    const lines = readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatchObject({ host: 'example.com', port: 443, allowed: false })
    expect(lines[1].prev).toBe(lines[0].hash)
    expect(verifyEgressChain(file)).toEqual({ ok: true, lines: 2, chained: 2 })
    expect(readEgress(file, 1).map(entry => entry.host)).toEqual(['registry.npmjs.org'])
  })

  it('notices an edited or removed line', () => {
    const file = join(temp(), 'room.jsonl')
    for (const host of ['a.test', 'b.test', 'c.test']) appendEgress(file, { host, port: 443, allowed: false })
    const lines = readFileSync(file, 'utf8').trim().split('\n')
    writeFileSync(file, `${[lines[0], lines[1].replace('b.test', 'z.test'), lines[2]].join('\n')}\n`)
    expect(verifyEgressChain(file)).toMatchObject({ ok: false, brokenAt: 2 })
    writeFileSync(file, `${[lines[0], lines[2]].join('\n')}\n`)
    expect(verifyEgressChain(file)).toMatchObject({ ok: false, brokenAt: 2 })
  })

  it('writes plain lines when the chain is off', () => {
    const file = join(temp(), 'room.jsonl')
    const entry = appendEgress(file, { host: 'a.test', port: 80, allowed: true }, { chain: false })
    expect(entry.hash).toBeUndefined()
    expect(verifyEgressChain(file)).toEqual({ ok: true, lines: 1, chained: 0 })
  })
})

describe('clean room self-check', () => {
  const expectations: SelfCheckExpectations = {
    network: 'allowlist', readOnlyRoot: true, dropAllCaps: true, capAdd: [], uid: 1000,
    workspace: '/work/app', readOnlyPaths: ['/opt/agent'], blockedHost: 'example.com', allowedHost: 'registry.npmjs.org',
  }
  const good: ProbeOutput = {
    uid: 1000, gid: 1000, user: 'agent', noNewPrivs: true, capEff: [], capBnd: [],
    mounts: [
      { path: '/', readOnly: true, writable: false, type: 'overlay' },
      { path: '/work/app', readOnly: false, writable: true, type: 'ext4' },
      { path: '/opt/agent', readOnly: true, writable: false, type: 'ext4' },
      { path: '/tmp', readOnly: false, writable: true, type: 'tmpfs' },
    ],
    envNames: ['ANTHROPIC_API_KEY', 'HOME'], dockerSocket: [],
    network: [
      { target: '1.1.1.1:443', via: 'direct', reached: false, error: 'ENETUNREACH' },
      { target: 'example.com:443', via: 'direct', reached: false, error: 'EAI_AGAIN' },
      { target: 'example.com:443', via: 'proxy', reached: false, status: 403 },
      { target: 'registry.npmjs.org:443', via: 'proxy', reached: true, status: 200 },
      { target: 'studio:/api/auth/status', via: 'studio', reached: false, status: 403 },
    ],
  }

  it('passes a room whose walls all hold', () => {
    const checks = judgeProbe(good, expectations)
    expect(overallState(checks)).toBe('pass')
    expect(checks.find(check => check.id === 'environment')?.detail).toBe('ANTHROPIC_API_KEY, HOME')
  })

  it('fails on a Docker socket, a way out, a writable program or capabilities left', () => {
    const bad: ProbeOutput = {
      ...good,
      dockerSocket: ['/var/run/docker.sock'],
      capBnd: ['SYS_ADMIN'],
      mounts: good.mounts.map(mount => mount.path === '/opt/agent' ? { ...mount, readOnly: false, writable: true } : mount),
      network: good.network.map(entry => entry.via === 'direct' ? { ...entry, reached: true } : entry),
    }
    const failed = judgeProbe(bad, expectations).filter(check => check.state === 'fail').map(check => check.id)
    expect(failed).toEqual(expect.arrayContaining(['docker-socket', 'capabilities', 'read-only-mount', 'direct-internet']))
  })

  it('warns when the agent runs as root and when an allowed host does not answer', () => {
    const checks = judgeProbe({ ...good, uid: 0, network: good.network.map(entry => entry.target.startsWith('registry') ? { ...entry, reached: false, error: 'timeout' } : entry) }, { ...expectations, uid: 0 })
    expect(overallState(checks)).toBe('warn')
  })

  it('the probe prints names of environment variables, never their values', () => {
    const dir = temp()
    writeFileSync(join(dir, 'probe.mjs'), PROBE_SCRIPT)
    const out = execFileSync(process.execPath, [join(dir, 'probe.mjs')], {
      env: { PATH: process.env.PATH, VERY_SECRET_TOKEN: 'do-not-print-me', STUDIO_PROBE: JSON.stringify({ blockedHost: 'blocked.invalid', direct: false }) },
      encoding: 'utf8', timeout: 30000,
    })
    expect(out).not.toContain('do-not-print-me')
    const probe = normalizeProbe(JSON.parse(out.trim()))
    expect(probe.envNames).toContain('VERY_SECRET_TOKEN')
    expect(probe.envNames).not.toContain('STUDIO_PROBE')
    expect(probe.uid).toBe(process.getuid?.())
    expect(probe.mounts.some(mount => mount.path === '/')).toBe(true)
  }, 40000)
})
