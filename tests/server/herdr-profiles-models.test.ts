import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { herdrChatProfile, migrateHerdrSettings, sanitizeHerdrSettings, DEFAULT_HERDR_SETTINGS } from '../../packages/server/src/modules/coding-agents/services/herdr/runtime'
import { HerdrHermesLaunchStore, herdrModelChange, hermesRowProvider, readHermesSessionRoute, type HerdrHermesLaunchRecord } from '../../packages/server/src/modules/hermes/services/herdr-model-sync'
import { localModelsGroup } from '../../packages/server/src/modules/hermes/controllers/models'

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

describe("Hermes's local models in Studio's model list", () => {
  it("lists the profile's local default model under Hermes's own provider", () => {
    expect(localModelsGroup('qwen3-8b-q4', 'llamacpp')).toMatchObject({ provider: 'llamacpp', models: ['qwen3-8b-q4'] })
    expect(localModelsGroup('gpt-5', 'openai')).toBeNull()
    expect(localModelsGroup('', 'llamacpp')).toBeNull()
  })
})
