import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { applyLocalProvider, LocalServerNotRunningError, readManagedLocalServer, resolveHermesLocalUpstream } from '../../packages/server/src/modules/hermes/services/models/local-provider'

function hermesHome(state?: Record<string, unknown>) {
  const root = mkdtempSync(join(tmpdir(), 'hermes-local-'))
  mkdirSync(join(root, 'runtimes', 'llamacpp'), { recursive: true })
  if (state) writeFileSync(join(root, 'runtimes', 'llamacpp', 'server.json'), JSON.stringify(state))
  return root
}

describe("Hermes's managed llama-server", () => {
  it('is read from the state Hermes writes, with the key it was started with', () => {
    const root = hermesHome({ base_url: 'http://127.0.0.1:18434/v1', api_key: 'k-123' })
    expect(readManagedLocalServer(root)).toEqual({ base_url: 'http://127.0.0.1:18434/v1', api_key: 'k-123' })
  })

  it('is not running when there is no state, or its process is gone or another program', () => {
    expect(readManagedLocalServer(hermesHome())).toBeNull()
    const proc = mkdtempSync(join(tmpdir(), 'proc-'))
    mkdirSync(join(proc, '4242'))
    symlinkSync('/usr/bin/other', join(proc, '4242', 'exe'))
    const gone = hermesHome({ base_url: 'http://127.0.0.1:18434/v1', api_key: 'k', pid: 999999, executable: '/opt/llama-server' })
    expect(readManagedLocalServer(gone, proc)).toBeNull()
    const reused = hermesHome({ base_url: 'http://127.0.0.1:18434/v1', api_key: 'k', pid: 4242, executable: '/opt/llama-server' })
    expect(readManagedLocalServer(reused, proc)).toBeNull()
    const alive = hermesHome({ base_url: 'http://127.0.0.1:18434/v1', api_key: 'k', pid: 4242, executable: '/usr/bin/other' })
    expect(readManagedLocalServer(alive, proc)).toEqual({ base_url: 'http://127.0.0.1:18434/v1', api_key: 'k' })
  })

  it('the gateway calls it where it runs now, with its key, and says so clearly when it is off', () => {
    const resolved = { provider: 'custom:hermes-local', baseUrl: 'http://127.0.0.1:8080/v1', apiKey: 'local' }
    expect(resolveHermesLocalUpstream(resolved, { base_url: 'http://127.0.0.1:40001', api_key: 'k-9' }))
      .toEqual({ provider: 'custom:hermes-local', baseUrl: 'http://127.0.0.1:40001/v1', apiKey: 'k-9' })
    expect(() => resolveHermesLocalUpstream(resolved, null)).toThrow(LocalServerNotRunningError)
    expect(() => resolveHermesLocalUpstream(resolved, null)).toThrow(/local model server is not running/)
    const other = { provider: 'custom:fakepool', apiKey: 'x' }
    expect(resolveHermesLocalUpstream(other, null)).toBe(other)
  })

  it("moves any of Hermes's names for llama.cpp onto the Provider, with the server's key", () => {
    const config: Record<string, any> = { studio_provider_pool: 2, providers: {}, model: { provider: 'llama.cpp', default: 'Qwen3-0.6B' } }
    expect(applyLocalProvider(config, { server_base_url: 'http://127.0.0.1:18434', models: [] }, { apiKey: 'k-1' })).toBe(true)
    expect(config.model).toEqual({ provider: 'custom:hermes-local', default: 'Qwen3-0.6B' })
    expect(config.providers['custom:hermes-local']).toMatchObject({ base_url: 'http://127.0.0.1:18434/v1', api_key: 'k-1', models: { 'Qwen3-0.6B': {} } })
  })
})
