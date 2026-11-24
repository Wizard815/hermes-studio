import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import YAML from 'js-yaml'

let base = ''
let savedAppConfig: Record<string, unknown> = {}
vi.mock('../../packages/server/src/modules/hermes/services/profiles/profile', async (orig) => ({
  ...(await orig<any>()),
  getHermesBaseDir: () => base,
  getProfileDir: (name: string) => (!name || name === 'default' ? base : join(base, 'profiles', name)),
  listProfileNamesFromDisk: () => ['default'],
}))
vi.mock('../../packages/server/src/modules/hermes/services/profiles/config', async (orig) => {
  const { safeFileStore } = await import('../../packages/server/src/modules/studio/public/safe-file-store')
  return {
    ...(await orig<any>()),
    updateConfigYamlForProfile: (profile: string, updater: any) =>
      safeFileStore.updateYaml(join(profile === 'default' ? base : join(base, 'profiles', profile), 'config.yaml'), updater),
  }
})
vi.mock('../../packages/server/src/modules/studio/public/app-config', async (orig) => ({
  ...(await orig<any>()),
  readAppConfig: async () => savedAppConfig,
}))

import {
  MCP_SERVE_SERVER_NAME, RECOMMENDED_HERMES_PLUGINS, addMcpServerToConfig, explainRefusal, mcpServeCommand, applyRecommendedPlugins, mcpServeServerConfig,
  platformAllowed, readRecommendedState, recommendedAutoInstallSetting, satisfiesHermes, type HermesCall, type RecommendedDeps,
} from '../../packages/server/src/modules/hermes/services/plugins/recommended'
import { missingEnvFor, requiredEnvNames } from '../../packages/server/src/modules/hermes/services/plugins/plugin-env'

interface FakeEntry { name: string; requires_hermes?: string; platforms?: string[]; installed?: boolean; runtime_status?: string | null }

function catalog(overrides: Record<string, Partial<FakeEntry>> = {}): FakeEntry[] {
  return [
    ...RECOMMENDED_HERMES_PLUGINS.map(name => ({
      name,
      requires_hermes: '>=0.22.0',
      platforms: name === 'bubblewrap' ? ['linux'] : name === 'print3d' ? ['macos', 'linux'] : [],
      installed: false,
      ...overrides[name],
    })),
    { name: 'spotify', installed: false },
  ]
}

function fakeHermes(entries: FakeEntry[] | (() => FakeEntry[]), opts: { version?: string; install?: (name: string) => HermesCall; available?: boolean } = {}) {
  const calls: Array<{ method: string; path: string; body: unknown }> = []
  const servers: Array<{ profile: string; name: string; server: Record<string, unknown> }> = []
  const gadgetPlatforms: string[] = []
  const deps: RecommendedDeps = {
    async call(method, path, body) {
      calls.push({ method, path, body })
      if (path === 'dashboard/plugins/catalog') return { status: 200, body: { entries: typeof entries === 'function' ? entries() : entries } }
      if (path === 'dashboard/agent-plugins/install') {
        const name = (body as any).catalog_name
        return opts.install?.(name) || { status: 200, body: { ok: true, plugin_name: name, missing_env: name === 'langfuse' ? ['HERMES_LANGFUSE_PUBLIC_KEY'] : [] } }
      }
      if (path.endsWith('/enable')) return { status: 200, body: { ok: true } }
      return { status: 404, body: { detail: 'Not found' } }
    },
    hermesAvailable: () => opts.available !== false,
    hermesVersion: () => opts.version ?? '0.22.7 (2026.11.20)',
    addMcpServer: async (profile, name, server) => { servers.push({ profile, name, server }); return true },
    enableGadgetPlatform: async (profile) => { gadgetPlatforms.push(profile); return 'enabled' },
    hermesCommand: () => '/usr/local/bin/hermes',
    stateFile: join(base, 'state', 'recommended-hermes-plugins.json'),
    platform: 'linux',
    homeOf: profile => (profile === 'default' ? base : join(base, 'profiles', profile)),
  }
  return { deps, calls, servers, gadgetPlatforms }
}

const installs = (calls: Array<{ path: string; body: unknown }>) =>
  calls.filter(call => call.path === 'dashboard/agent-plugins/install').map(call => (call.body as any).catalog_name)

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'recommended-plugins-'))
  savedAppConfig = {}
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

describe('recommended Hermes plugins', () => {
  it('installs the eight by catalog name only (pinned entry), enables them, and adds mcp-serve once', async () => {
    const hermes = fakeHermes(catalog())
    const result = await applyRecommendedPlugins('default', hermes.deps)
    expect(installs(hermes.calls)).toEqual([...RECOMMENDED_HERMES_PLUGINS])
    for (const call of hermes.calls.filter(c => c.path === 'dashboard/agent-plugins/install')) {
      expect(call.body).toEqual({ identifier: '', catalog_name: (call.body as any).catalog_name, enable: true })
    }
    expect(result.failed).toEqual({})
    expect(result.mcpServer).toBe('added')
    expect(hermes.servers).toHaveLength(1)
    expect(hermes.servers[0].name).toBe(MCP_SERVE_SERVER_NAME)
    const state = await readRecommendedState(hermes.deps.stateFile)
    expect(state.homes[base].done.langfuse).toMatchObject({ outcome: 'installed', missingEnv: ['HERMES_LANGFUSE_PUBLIC_KEY'] })
    expect(state.homes[base].mcpServer?.outcome).toBe('added')

    // Next start: nothing to do, Hermes is not even asked.
    const again = fakeHermes(catalog())
    again.deps.stateFile = hermes.deps.stateFile
    expect((await applyRecommendedPlugins('default', again.deps)).skipped).toBe('done')
    expect(again.calls).toEqual([])
    expect(again.servers).toEqual([])
  })

  it('leaves a plugin the user had already disabled, and enables one that was installed but never chosen', async () => {
    const hermes = fakeHermes(catalog({
      homeassistant: { installed: true, runtime_status: 'disabled' },
      langfuse: { installed: true, runtime_status: 'inactive' },
      rea: { installed: true, runtime_status: 'enabled' },
      'mcp-serve': { installed: true, runtime_status: 'disabled' },
    }))
    await applyRecommendedPlugins('default', hermes.deps)
    expect(installs(hermes.calls)).toEqual(['agent-importers', 'bubblewrap', 'print3d', 'gadget'])
    expect(hermes.calls.filter(c => c.path.endsWith('/enable')).map(c => c.path)).toEqual(['dashboard/agent-plugins/langfuse/enable'])
    const done = (await readRecommendedState(hermes.deps.stateFile)).homes[base].done
    expect(done.homeassistant.outcome).toBe('kept-disabled')
    expect(done.rea.outcome).toBe('already-enabled')
    // mcp-serve kept disabled: its MCP server is not added either.
    expect(hermes.servers).toEqual([])
  })

  it('logs and retries when the catalog is unreachable, then installs on a later start', async () => {
    let online = false
    const hermes = fakeHermes(catalog())
    const call = hermes.deps.call
    hermes.deps.call = async (method, path, body, profile) => {
      if (!online) throw new Error('fetch failed: getaddrinfo ENOTFOUND github.com')
      return call(method, path, body, profile)
    }
    const first = await applyRecommendedPlugins('default', hermes.deps)
    expect(Object.keys(first.failed)).toEqual([...RECOMMENDED_HERMES_PLUGINS])
    let state = await readRecommendedState(hermes.deps.stateFile)
    expect(state.homes[base].done).toEqual({})
    expect(state.homes[base].lastFailure?.rea.attempts).toBe(1)
    await applyRecommendedPlugins('default', hermes.deps)
    expect((await readRecommendedState(hermes.deps.stateFile)).homes[base].lastFailure?.rea.attempts).toBe(2)

    online = true
    const later = await applyRecommendedPlugins('default', hermes.deps)
    expect(later.done).toHaveLength(8)
    state = await readRecommendedState(hermes.deps.stateFile)
    expect(state.homes[base].lastFailure).toBeUndefined()
  })

  it('does not install a plugin this Hermes is too old for, and retries it after Hermes is updated', async () => {
    let version = '0.22.2'
    const hermes = fakeHermes(catalog({ bubblewrap: { requires_hermes: '>=0.22.6' }, rea: { requires_hermes: '>=0.22.3' } }))
    hermes.deps.hermesVersion = () => version
    const result = await applyRecommendedPlugins('default', hermes.deps)
    expect(installs(hermes.calls)).not.toContain('bubblewrap')
    expect(result.failed.bubblewrap).toBe('needs Hermes >=0.22.6; this is 0.22.2')
    expect(result.failed.rea).toMatch(/needs Hermes/)
    version = '0.22.6 (2026.11.1)'
    hermes.calls.length = 0
    await applyRecommendedPlugins('default', hermes.deps)
    expect(installs(hermes.calls)).toEqual(['bubblewrap', 'rea'])
  })

  it('keeps an install Hermes refuses (print3d without Blender) for a later start', async () => {
    const hermes = fakeHermes(catalog(), {
      install: name => name === 'print3d' ? { status: 400, body: { detail: 'Blender 4.2+ not found. Install Blender first.' } } : undefined as any,
    })
    const result = await applyRecommendedPlugins('default', hermes.deps)
    expect(result.failed).toEqual({ print3d: 'needs Blender 4.2+ on the Hermes host (Hermes said: Blender 4.2+ not found. Install Blender first.)' })
    expect(explainRefusal('print3d', "Can't install plugin 'print3d': print3d is not installed. Install print3d 4.2 or newer, then try again."))
      .toMatch(/^needs Blender 4\.2\+ on the Hermes host/)
    expect(explainRefusal('rea', 'x is not installed')).toBe('x is not installed')
    expect(result.done).toHaveLength(7)
    hermes.calls.length = 0
    await applyRecommendedPlugins('default', hermes.deps)
    expect(installs(hermes.calls)).toEqual(['print3d'])
  })

  it('skips plugins for other platforms for good, and maps macos/windows names', async () => {
    const hermes = fakeHermes(catalog())
    hermes.deps.platform = 'darwin'
    await applyRecommendedPlugins('default', hermes.deps)
    expect(installs(hermes.calls)).not.toContain('bubblewrap')
    expect(installs(hermes.calls)).toContain('print3d')
    expect((await readRecommendedState(hermes.deps.stateFile)).homes[base].done.bubblewrap.outcome).toBe('not-for-this-platform')
    expect(platformAllowed(['macos', 'linux'], 'win32')).toBe(false)
    expect(platformAllowed(['windows'], 'win32')).toBe(true)
    expect(platformAllowed([], 'aix')).toBe(true)
  })

  it('does nothing without Hermes installed', async () => {
    const hermes = fakeHermes(catalog(), { available: false })
    expect((await applyRecommendedPlugins('default', hermes.deps)).skipped).toBe('no-hermes')
    expect(hermes.calls).toEqual([])
    expect(existsSync(hermes.deps.stateFile)).toBe(false)
  })

  it('treats a consent or scan answer as not done', async () => {
    const hermes = fakeHermes(catalog(), {
      install: name => name === 'rea' ? { status: 200, body: { consent_required: true } } : undefined as any,
    })
    const result = await applyRecommendedPlugins('default', hermes.deps)
    expect(result.failed.rea).toMatch(/consent/)
  })
})

describe('gadget platform', () => {
  it('is turned on once after gadget is installed, and not again after the user turns it off', async () => {
    const hermes = fakeHermes(catalog())
    const result = await applyRecommendedPlugins('default', hermes.deps)
    expect(result.gadgetPlatform).toBe('enabled')
    expect(hermes.gadgetPlatforms).toEqual(['default'])
    expect((await readRecommendedState(hermes.deps.stateFile)).homes[base].gadgetPlatform?.outcome).toBe('enabled')
    const state = JSON.parse(readFileSync(hermes.deps.stateFile, 'utf8'))
    delete state.homes[base].done.rea
    writeFileSync(hermes.deps.stateFile, JSON.stringify(state))
    await applyRecommendedPlugins('default', hermes.deps)
    expect(hermes.gadgetPlatforms).toEqual(['default'])
  })

  it('is left off when the user had gadget installed and disabled', async () => {
    const hermes = fakeHermes(catalog({ gadget: { installed: true, runtime_status: 'disabled' } }))
    const result = await applyRecommendedPlugins('default', hermes.deps)
    expect(result.gadgetPlatform).toBeUndefined()
    expect(hermes.gadgetPlatforms).toEqual([])
  })
})

describe('mcp-serve MCP server', () => {
  it('adds a read-only stdio server once and never over an existing or removed one', async () => {
    writeFileSync(join(base, 'config.yaml'), 'model:\n  default: x\nmcp_servers:\n  other:\n    url: http://x\n')
    const server = mcpServeServerConfig('default', '/usr/local/bin/hermes', base)
    expect(await addMcpServerToConfig('default', MCP_SERVE_SERVER_NAME, server)).toBe(true)
    const cfg = YAML.load(readFileSync(join(base, 'config.yaml'), 'utf8')) as any
    expect(cfg.mcp_servers.other).toEqual({ url: 'http://x' })
    expect(cfg.mcp_servers['hermes-chats']).toMatchObject({ command: '/usr/local/bin/hermes', args: ['mcp-serve'], env: { HERMES_HOME: base } })
    expect(cfg.mcp_servers['hermes-chats'].tools.include).not.toContain('messages_send')
    expect(cfg.mcp_servers['hermes-chats'].tools.include).toContain('messages_read')
    expect(await addMcpServerToConfig('default', 'Hermes-Chats', server)).toBe(false)
    expect(mcpServeServerConfig('work', 'hermes', base).args).toEqual(['-p', 'work', 'mcp-serve'])
    expect(mcpServeCommand('/opt/hermes/bin/hermes', p => p === '/opt/hermes/.venv/bin/hermes')).toBe('/opt/hermes/.venv/bin/hermes')
    expect(mcpServeCommand('/opt/hermes/bin/hermes', () => false)).toBe('/opt/hermes/bin/hermes')
    expect(mcpServeCommand('/opt/hermes/.venv/bin/hermes', () => true)).toBe('/opt/hermes/.venv/bin/hermes')
  })

  it('is not added again after the user removes it', async () => {
    const hermes = fakeHermes(catalog())
    await applyRecommendedPlugins('default', hermes.deps)
    expect(hermes.servers).toHaveLength(1)
    // A new recommended plugin later, or a retry: the removed server stays removed.
    const state = JSON.parse(readFileSync(hermes.deps.stateFile, 'utf8'))
    delete state.homes[base].done.rea
    writeFileSync(hermes.deps.stateFile, JSON.stringify(state))
    await applyRecommendedPlugins('default', hermes.deps)
    expect(hermes.servers).toHaveLength(1)
  })
})

describe('switch and helpers', () => {
  it('is on by default, off by Settings or by STUDIO_RECOMMENDED_HERMES_PLUGINS=0', async () => {
    expect(await recommendedAutoInstallSetting({})).toEqual({ enabled: true, disabledByEnv: false })
    expect(await recommendedAutoInstallSetting({ STUDIO_RECOMMENDED_HERMES_PLUGINS: '0' })).toEqual({ enabled: false, disabledByEnv: true })
    expect(await recommendedAutoInstallSetting({ STUDIO_RECOMMENDED_HERMES_PLUGINS: 'off' })).toEqual({ enabled: false, disabledByEnv: true })
    savedAppConfig = { recommendedHermesPlugins: false }
    expect(await recommendedAutoInstallSetting({})).toEqual({ enabled: false, disabledByEnv: false })
  })

  it('reads requires_hermes ranges', () => {
    expect(satisfiesHermes('>=0.21.6', '0.22.0 (2026.9.24)')).toBe(true)
    expect(satisfiesHermes('>=0.22.6', '0.22.5')).toBe(false)
    expect(satisfiesHermes('>=0.21,<0.30', '0.30.0')).toBe(false)
    expect(satisfiesHermes('', '0.1.0')).toBe(true)
    expect(satisfiesHermes('>=0.22.0', null)).toBeNull()
  })

  it('finds required keys unset in the profile .env and in the environment', () => {
    mkdirSync(join(base, 'p'), { recursive: true })
    writeFileSync(join(base, 'p', '.env'), '# keys\nHASS_TOKEN="abc"\nexport EMPTY=\n')
    const names = requiredEnvNames([{ name: 'HASS_TOKEN' }, 'EMPTY', 'HERMES_LANGFUSE_SECRET_KEY', { name: '' }])
    expect(names).toEqual(['HASS_TOKEN', 'EMPTY', 'HERMES_LANGFUSE_SECRET_KEY'])
    expect(missingEnvFor(join(base, 'p'), names, {})).toEqual(['EMPTY', 'HERMES_LANGFUSE_SECRET_KEY'])
    expect(missingEnvFor(join(base, 'p'), names, { HERMES_LANGFUSE_SECRET_KEY: 'x' })).toEqual(['EMPTY'])
    expect(missingEnvFor(join(base, 'missing'), ['A'], {})).toEqual(['A'])
  })
})
