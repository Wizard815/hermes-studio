import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { herdrChatProfile, migrateHerdrSettings, sanitizeHerdrSettings, DEFAULT_HERDR_SETTINGS } from '../../packages/server/src/modules/coding-agents/services/herdr/runtime'
import { HerdrHermesLaunchStore, herdrModelChange, hermesRowProvider, readHermesSessionRoute, type HerdrHermesLaunchRecord } from '../../packages/server/src/modules/hermes/services/herdr-model-sync'
import { applyLocalProvider, localServerApiUrl } from '../../packages/server/src/modules/hermes/services/models/local-provider'
import { logicalHermesRoute, hermesRowProvider } from '../../packages/server/src/modules/hermes/services/herdr-model-sync'
import { pooledKeyEntries } from '../../packages/server/src/modules/studio/services/providers/key-pools'

describe("herdr follows Studio's profile", () => {
  it('uses the pinned profile, else the one picked in Studio, else default', () => {
    expect(DEFAULT_HERDR_SETTINGS.profile).toBe('')
    expect(herdrChatProfile({ profile: '', studioProfile: 'work' })).toBe('work')
    expect(herdrChatProfile({ profile: 'home', studioProfile: 'work' })).toBe('home')
    expect(herdrChatProfile({ profile: '', studioProfile: '' })).toBe('default')
  })

  it("lets settings go back to following Studio and remembers Studio's profile", () => {
    const pinned = sanitizeHerdrSettings({ profile: 'home' })
    expect(sanitizeHerdrSettings({ profile: '' }, pinned).profile).toBe('')
    expect(sanitizeHerdrSettings({ studioProfile: ' work ' }).studioProfile).toBe('work')
  })

  it("moves old settings files (always 'default') to following Studio, once", () => {
    expect(migrateHerdrSettings({ enabled: true, profile: 'default' })).toMatchObject({ profile: '', studioProfile: '' })
    expect(migrateHerdrSettings({ profile: 'home' })).toMatchObject({ profile: 'home' })
    // Written by a version that knows "follow": a pinned 'default' stays.
    expect(migrateHerdrSettings({ profile: 'default', studioProfile: 'work' })).toMatchObject({ profile: 'default' })
  })
})

describe('a model picked in a Hermes herdr pane stays with the chat', () => {
  const record: HerdrHermesLaunchRecord = {
    studio: { model: 'm-studio', provider: 'openrouter' },
    hermes: { model: 'm-old', provider: 'openrouter' },
    launched: 'm-studio',
    at: 1,
  }

  it('takes /model from the pane when only herdr changed it', () => {
    expect(herdrModelChange(record, record.studio, { model: 'm-pane', provider: 'nous' })).toEqual({ model: 'm-pane', provider: 'nous' })
  })

  it("keeps Studio's model when the pane did not change it", () => {
    expect(herdrModelChange(record, record.studio, record.hermes)).toBeNull()
    // Hermes recorded the launch model (-m) for the session.
    expect(herdrModelChange(record, record.studio, { model: 'm-studio', provider: 'openrouter' })).toBeNull()
    expect(herdrModelChange(record, record.studio, null)).toBeNull()
    expect(herdrModelChange(null, record.studio, { model: 'm-pane', provider: 'nous' })).toBeNull()
  })

  it("lets a pick in Studio's model picker since the launch win", () => {
    expect(herdrModelChange(record, { model: 'm-picked', provider: 'openrouter' }, { model: 'm-pane', provider: 'nous' })).toBeNull()
  })

  it('treats a new chat that started on the profile default as unchanged', () => {
    const fresh: HerdrHermesLaunchRecord = { studio: { model: '', provider: '' }, hermes: { model: '', provider: '' }, launched: 'm-default', at: 1 }
    expect(herdrModelChange(fresh, fresh.studio, { model: 'm-default', provider: '' })).toBeNull()
    expect(herdrModelChange(fresh, fresh.studio, { model: 'm-pane', provider: 'nous' })).toEqual({ model: 'm-pane', provider: 'nous' })
  })

  it("keeps Studio's Claude sign-in key for Hermes's anthropic route", () => {
    const claude = { ...record, studio: { model: 'claude-a', provider: 'claude-oauth' }, launched: 'claude-a' }
    expect(herdrModelChange(claude, claude.studio, { model: 'claude-b', provider: 'anthropic' })).toEqual({ model: 'claude-b', provider: 'claude-oauth' })
  })

  it("reads a Hermes session's model and route from the profile's state.db", async () => {
    expect(hermesRowProvider('{"gateway_runtime":{"provider":"nous"},"provider":"x"}')).toBe('nous')
    expect(hermesRowProvider({ provider: 'openrouter' })).toBe('openrouter')
    expect(hermesRowProvider('not json')).toBe('')
    const home = mkdtempSync(join(tmpdir(), 'hermes-profile-'))
    const db = new DatabaseSync(join(home, 'state.db'))
    db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, model TEXT, model_config TEXT)')
    db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run('s1', 'm-pane', JSON.stringify({ gateway_runtime: { provider: 'nous' } }))
    db.close()
    expect(await readHermesSessionRoute(home, 's1')).toEqual({ model: 'm-pane', provider: 'nous' })
    expect(await readHermesSessionRoute(home, 'missing')).toBeNull()
    expect(await readHermesSessionRoute(join(home, 'nope'), 's1')).toBeNull()
  })

  it('stores one launch record per chat', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'herdr-models-')), 'hermes-models.json')
    const store = new HerdrHermesLaunchStore(file)
    store.set('a', record)
    expect(new HerdrHermesLaunchStore(file).get('a')).toEqual(record)
    store.delete('a')
    expect(new HerdrHermesLaunchStore(file).get('a')).toBeNull()
  })
})

describe("Hermes's local models as a model gateway Provider", () => {
  const status = { server_base_url: 'http://127.0.0.1:8080', models: [{ id: 'qwen3-8b-q4' }, { id: 'gemma-4b' }] }

  it('registers the llama.cpp server under /v1 in the account Provider pool', () => {
    expect(localServerApiUrl('http://127.0.0.1:8080/')).toBe('http://127.0.0.1:8080/v1')
    expect(localServerApiUrl('http://127.0.0.1:8080/v1')).toBe('http://127.0.0.1:8080/v1')
    const config: Record<string, any> = { studio_provider_pool: 2, providers: {}, model: { provider: 'deepseek', default: 'deepseek-v4' } }
    expect(applyLocalProvider(config, status)).toBe(true)
    expect(config.providers['custom:hermes-local']).toMatchObject({ base_url: 'http://127.0.0.1:8080/v1', api_mode: 'chat_completions', models: { 'qwen3-8b-q4': {}, 'gemma-4b': {} } })
    expect(config.model).toEqual({ provider: 'deepseek', default: 'deepseek-v4' })
    expect(applyLocalProvider(config, status)).toBe(false)
  })

  it("makes a local model the profile default, and moves Hermes's own llamacpp default onto the Provider", () => {
    const config: Record<string, any> = { studio_provider_pool: 2, providers: {}, model: { provider: 'deepseek', default: 'deepseek-v4', base_url: 'x' } }
    applyLocalProvider(config, status, { defaultModel: 'gemma-4b' })
    expect(config.model).toEqual({ provider: 'custom:hermes-local', default: 'gemma-4b' })
    const legacy: Record<string, any> = { custom_providers: [], model: { provider: 'llamacpp', default: 'qwen3-8b-q4' } }
    applyLocalProvider(legacy, status)
    expect(legacy.custom_providers[0]).toMatchObject({ name: 'hermes-local', base_url: 'http://127.0.0.1:8080/v1' })
    expect(legacy.model).toEqual({ provider: 'custom:hermes-local', default: 'qwen3-8b-q4' })
  })

  it('does nothing without a server address or models', () => {
    expect(applyLocalProvider({ providers: {} }, { server_base_url: null, models: [{ id: 'a' }] })).toBe(false)
    expect(applyLocalProvider({ providers: {} }, { server_base_url: 'http://h:1', models: [] })).toBe(false)
  })
})

describe('herdr Hermes panes through the model gateway', () => {
  it("reads a gateway session row's model back as the chat's provider and model", () => {
    expect(hermesRowProvider({ provider: 'ekkostudio', model: 'deepseek/deepseek-v4', gateway_runtime: { provider: 'custom', base_url: 'http://127.0.0.1:8648/api/ekko-studio/models/v1' } })).toBe('ekkostudio')
    expect(hermesRowProvider({ provider: 'openrouter' })).toBe('openrouter')
    const toLogical = (model: string) => model === 'deepseek/deepseek-v4' ? { provider: 'deepseek', model: 'deepseek-v4' } : null
    expect(logicalHermesRoute({ provider: 'ekkostudio', model: 'deepseek/deepseek-v4' }, toLogical)).toEqual({ provider: 'deepseek', model: 'deepseek-v4' })
    expect(logicalHermesRoute({ provider: 'ekkostudio', model: 'gone/x' }, toLogical)).toEqual({ provider: 'ekkostudio', model: 'gone/x' })
    expect(logicalHermesRoute({ provider: 'openrouter', model: 'a/b' }, toLogical)).toEqual({ provider: 'openrouter', model: 'a/b' })
  })
})

describe('key pools', () => {
  it('rotates only entries that carry their own API key', () => {
    expect(pooledKeyEntries([
      { auth_type: 'api_key', source: 'env:OPENROUTER_API_KEY' },
      { auth_type: 'api_key', access_token: 'sk-2' },
      { auth_type: 'oauth', access_token: 'oauth-token' },
      { access_token: 'codex-token' },
    ]).map(entry => entry.access_token)).toEqual(['sk-2'])
  })
})
