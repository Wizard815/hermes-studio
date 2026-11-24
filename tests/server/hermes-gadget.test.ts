import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import YAML from 'js-yaml'

let base = ''
vi.mock('../../packages/server/src/modules/hermes/services/profiles/config', async (orig) => {
  const { safeFileStore } = await import('../../packages/server/src/modules/studio/public/safe-file-store')
  return {
    ...(await orig<any>()),
    updateConfigYamlForProfile: (_profile: string, updater: any) => safeFileStore.updateYaml(join(base, 'config.yaml'), updater),
  }
})

vi.mock('../../packages/client/src/api/client', () => ({ request: vi.fn() }))

import {
  enableGadgetPlatformOnce, gadgetDefaultsFromEnv, probePort, readGadgetStatus, readLiveStatus, updateGadgetPlatform, validHost,
  type GadgetStatusDeps,
} from '../../packages/server/src/modules/hermes/services/plugins/gadget'
import { gadgetDeviceUrl, gadgetState } from '../../packages/client/src/api/hermes/gadget'

const config = () => YAML.load(readFileSync(join(base, 'config.yaml'), 'utf8')) as any

function deps(overrides: Partial<GadgetStatusDeps> = {}): GadgetStatusDeps {
  return {
    homeOf: () => base,
    platformState: async () => ({ gatewayRunning: true, state: 'connected', error: null }),
    probe: async () => true,
    ...overrides,
  }
}

function installGadget(cfg: Record<string, unknown>) {
  mkdirSync(join(base, 'plugins', 'gadget'), { recursive: true })
  writeFileSync(join(base, 'config.yaml'), YAML.dump(cfg))
}

function writeData(file: string, data: unknown) {
  mkdirSync(join(base, 'plugin-data', 'gadget'), { recursive: true })
  writeFileSync(join(base, 'plugin-data', 'gadget', file), JSON.stringify(data))
}

beforeEach(() => { base = mkdtempSync(join(tmpdir(), 'studio-gadget-')) })
afterEach(() => rmSync(base, { recursive: true, force: true }))

describe('Hermes Gadget platform', () => {
  it('turns the platform on once with the env bind address, and leaves one the user set alone', async () => {
    writeFileSync(join(base, 'config.yaml'), 'model:\n  default: x\n')
    expect(await enableGadgetPlatformOnce('default', { STUDIO_GADGET_HOST: '192.168.1.20', STUDIO_GADGET_PORT: '9001' })).toBe('enabled')
    expect(config().platforms.gadget).toEqual({ enabled: true, extra: { host: '192.168.1.20', port: 9001 } })
    expect(config().model).toEqual({ default: 'x' })

    await updateGadgetPlatform('default', { enabled: false })
    expect(await enableGadgetPlatformOnce('default', {})).toBe('already-set')
    expect(config().platforms.gadget.enabled).toBe(false)
  })

  it('keeps the plugin defaults when no env is set, and ignores a bad env value', async () => {
    writeFileSync(join(base, 'config.yaml'), '{}\n')
    await enableGadgetPlatformOnce('default', { STUDIO_GADGET_HOST: 'bad host;rm', STUDIO_GADGET_PORT: '70000' })
    expect(config().platforms.gadget).toEqual({ enabled: true, extra: {} })
    expect(gadgetDefaultsFromEnv({ STUDIO_GADGET_HOST: '0.0.0.0' })).toEqual({ host: '0.0.0.0' })
    expect(validHost('::')).toBe('::')
    expect(validHost('a b')).toBeNull()
  })

  it('saves bind address and port from Settings', async () => {
    writeFileSync(join(base, 'config.yaml'), 'platforms:\n  gadget:\n    enabled: true\n    extra:\n      path: /gadget\n')
    await updateGadgetPlatform('default', { host: '127.0.0.1', port: 8800 })
    expect(config().platforms.gadget).toEqual({ enabled: true, extra: { path: '/gadget', host: '127.0.0.1', port: 8800 } })
  })
})

describe('Hermes Gadget status', () => {
  it('says not installed without asking Hermes or probing the port', async () => {
    writeFileSync(join(base, 'config.yaml'), '{}\n')
    const platformState = vi.fn()
    const probe = vi.fn()
    const status = await readGadgetStatus('default', deps({ platformState, probe }))
    expect(status.plugin).toEqual({ installed: false, enabled: false })
    expect(platformState).not.toHaveBeenCalled()
    expect(probe).not.toHaveBeenCalled()
    expect(gadgetState(status)).toBe('not-installed')
  })

  it('lists known and connected devices from the plugin files, never their keys', async () => {
    installGadget({ plugins: { enabled: ['gadget'] }, platforms: { gadget: { enabled: true, extra: { port: 8765 } } } })
    const now = Date.now() / 1000
    writeData('devices.json', {
      devices: {
        'hg-dash': { key: 'c2VjcmV0', name: 'D.A.S.H', board: 'esp32-32e', firmware: '0.1.0', last_seen: now },
        'hg-old': { key: 'b2xk', name: 'Desk', board: 'cardputer', last_seen: now - 3600 },
        'hg-new': { key: 'bmV3', name: '', last_seen: now, pending_until: now + 600 },
        'hg-gone': { key: 'Z29uZQ', pending_until: now - 10 },
      },
    })
    writeData('status.json', {
      version: 1, running: true, updated_at: now - 5,
      devices: { 'hg-dash': { online: true, name: 'D.A.S.H', paired: true, profile: 'default', activity: { state: 'ready' }, battery: { battery_percent: 81.6 } } },
    })
    const status = await readGadgetStatus('default', deps())
    expect(status.listening).toBe(true)
    expect(status.connected).toBe(1)
    expect(status.devices.map(d => d.id)).toEqual(['hg-dash', 'hg-old', 'hg-new'])
    expect(status.devices[0]).toMatchObject({ online: true, paired: true, batteryPercent: 81.6, activity: 'ready', firmware: '0.1.0' })
    expect(status.devices[2]).toMatchObject({ online: false, pending: true, paired: false })
    expect(JSON.stringify(status)).not.toMatch(/c2VjcmV0|b2xk|bmV3|"key"/)
    expect(gadgetState(status)).toBe('listening')
    expect(gadgetDeviceUrl(status, 'studio.lan')).toBe('ws://studio.lan:8765/gadget')
  })

  it('reads a stale or stopped status file as not listening and asks for a restart', async () => {
    installGadget({ plugins: { enabled: ['gadget'] }, platforms: { gadget: { enabled: true } } })
    writeData('status.json', { version: 1, running: true, updated_at: Date.now() / 1000 - 600, devices: { a: { online: true } } })
    const status = await readGadgetStatus('default', deps({ platformState: async () => ({ gatewayRunning: true, state: 'pending_restart', error: null }) }))
    expect(status.listening).toBe(false)
    expect(status.connected).toBe(0)
    expect(gadgetState(status)).toBe('restart')
    expect(readLiveStatus(join(base, 'plugin-data', 'gadget'), Date.now() / 1000 + 1000).running).toBe(false)
  })

  it('tells a stopped gateway, a disabled plugin, an off platform and a gateway error apart', async () => {
    installGadget({ plugins: { enabled: ['gadget'] }, platforms: { gadget: { enabled: true, extra: { host: '10.0.0.2', tls_cert: '/c.pem' } } } })
    let status = await readGadgetStatus('default', deps({ platformState: async () => ({ gatewayRunning: false, state: 'gateway_stopped', error: null }) }))
    expect(gadgetState(status)).toBe('gateway-stopped')
    expect(gadgetDeviceUrl(status, 'x')).toBe('wss://10.0.0.2:8765/gadget')
    status = await readGadgetStatus('default', deps({ platformState: async () => ({ gatewayRunning: true, state: 'fatal', error: 'Cannot listen on 0.0.0.0:8765: address in use' }) }))
    expect(gadgetState(status)).toBe('error')
    installGadget({ plugins: { enabled: ['gadget'], disabled: ['gadget'] } })
    expect(gadgetState(await readGadgetStatus('default', deps()))).toBe('plugin-off')
    installGadget({ plugins: { enabled: ['gadget'] } })
    status = await readGadgetStatus('default', deps())
    expect(status.platform).toMatchObject({ enabled: false, configured: false, host: '0.0.0.0', port: 8765, path: '/gadget' })
    expect(gadgetState(status)).toBe('platform-off')
  })

  it('probes the port on loopback for a 0.0.0.0 bind', async () => {
    const server = createServer(socket => socket.end())
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
    const port = (server.address() as any).port
    expect(await probePort('0.0.0.0', port)).toBe(true)
    await new Promise<void>(done => server.close(() => done()))
    expect(await probePort('127.0.0.1', port, 300)).toBe(false)
  })
})
