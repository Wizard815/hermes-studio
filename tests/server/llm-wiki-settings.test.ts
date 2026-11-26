import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import yaml from 'js-yaml'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { LlmWikiService, readEnvValue } from '../../packages/server/src/modules/studio/services/llm-wiki/service'
import { parseWhoami, wikiBaseUrl, wikiView } from '../../packages/server/src/modules/studio/services/llm-wiki/client'

const { createWiki } = createRequire(import.meta.url)('../fixtures/llm-wiki/stub-wiki.cjs')

/** Connections → LLM wiki: per-profile token in .env, memory.llm_wiki in config.yaml, test via whoami. */
describe('LLM wiki settings', () => {
  const wiki = createWiki()
  let url = ''
  let base = ''
  let service: LlmWikiService
  const dir = (profile: string) => join(base, profile)
  const config = (profile: string) => (yaml.load(readFileSync(join(dir(profile), 'config.yaml'), 'utf8')) || {}) as any
  const env = (profile: string) => { try { return readFileSync(join(dir(profile), '.env'), 'utf8') } catch { return '' } }

  beforeAll(async () => {
    url = await wiki.listen()
    base = mkdtempSync(join(tmpdir(), 'llm-wiki-settings-'))
    for (const profile of ['default', 'sam', 'house']) mkdirSync(dir(profile), { recursive: true })
    writeFileSync(join(dir('sam'), 'config.yaml'), 'model:\n  default: local\nmemory:\n  provider: honcho\n')
    service = new LlmWikiService({
      profiles: () => ['default', 'sam', 'house'],
      profileDir: dir,
      readConfig: async profile => (existsSync(join(dir(profile), 'config.yaml')) ? config(profile) : {}),
      updateConfig: async (profile, updater) => {
        const current = existsSync(join(dir(profile), 'config.yaml')) ? config(profile) : {}
        const next = await updater(current)
        if (next.write !== false) writeFileSync(join(dir(profile), 'config.yaml'), yaml.dump(next.data))
        return next.result
      },
      saveEnv: async (profile, key, value) => {
        const lines = env(profile).split('\n').filter(line => line && !line.startsWith(`${key}=`))
        if (value) lines.push(`${key}=${value}`)
        writeFileSync(join(dir(profile), '.env'), `${lines.join('\n')}\n`)
      },
      pluginSource: () => resolve('packages/server/src/assets/hermes-plugins/llm_wiki'),
    })
  })
  afterAll(async () => { await wiki.close(); rmSync(base, { recursive: true, force: true }) })

  it('lists every profile, without any token', async () => {
    const status = await service.status()
    expect(status.tokenEnv).toBe('LLM_WIKI_TOKEN')
    expect(status.profiles.map(item => item.profile)).toEqual(['default', 'sam', 'house'])
    expect(status.profiles.find(item => item.profile === 'sam')).toMatchObject({ enabled: false, provider: 'honcho', hasToken: false, recall: true, remember: true })
    expect(JSON.stringify(status)).not.toContain('t-')
  })

  it("keeps each profile's token in its own .env and never returns it", async () => {
    const saved = await service.save('sam', { url: `${url}/family-mcp/`, token: 'Bearer t-sam' })
    expect(saved).toMatchObject({ url, hasToken: true, enabled: false })
    expect(JSON.stringify(saved)).not.toContain('t-sam')
    expect(readEnvValue(env('sam'), 'LLM_WIKI_TOKEN')).toBe('t-sam')
    await service.save('house', { url, token: 't-house' })
    expect(readEnvValue(env('house'), 'LLM_WIKI_TOKEN')).toBe('t-house')
    expect(readEnvValue(env('sam'), 'LLM_WIKI_TOKEN')).toBe('t-sam')
    expect(config('sam').memory.llm_wiki.url).toBe(url)
    expect(config('sam').model.default).toBe('local')
  })

  it("tests with the profile's token: whose view it is", async () => {
    expect(await service.test('sam')).toMatchObject({ ok: true, view: 'own', identity: { name: 'Sam', kind: 'member', id: 'sam' } })
    expect(await service.test('house')).toMatchObject({ ok: true, view: 'household' })
    expect(await service.test('house', { token: 'nope' })).toMatchObject({ ok: false, error: expect.stringMatching(/refused this token/) })
    expect(await service.test('default')).toMatchObject({ ok: false, error: expect.stringMatching(/address/) })
    expect(await service.test('sam', { url: 'http://127.0.0.1:9' })).toMatchObject({ ok: false, error: expect.stringMatching(/not reachable/) })
  })

  it('turning it on installs the provider and replaces the previous one; off puts it back', async () => {
    await expect(service.save('default', { enabled: true })).rejects.toThrow(/address and this profile's token/)
    const on = await service.save('sam', { enabled: true, recall: false })
    expect(on).toMatchObject({ enabled: true, provider: 'llm_wiki', previousProvider: 'honcho', installed: true, recall: false })
    expect(config('sam').memory.provider).toBe('llm_wiki')
    expect(readFileSync(join(dir('sam'), 'plugins/llm_wiki/__init__.py'), 'utf8')).toContain('class LlmWikiMemoryProvider')
    expect(existsSync(join(dir('sam'), 'plugins/llm_wiki/plugin.yaml'))).toBe(true)
    const off = await service.save('sam', { enabled: false })
    expect(off).toMatchObject({ enabled: false, provider: 'honcho', previousProvider: '' })
    const house = await service.save('house', { enabled: true })
    expect(house).toMatchObject({ enabled: true, previousProvider: '' })
    expect((await service.save('house', { enabled: false })).provider).toBe('')
    expect(config('house').memory.provider).toBeUndefined()
  })

  it('refuses bad input in plain words', async () => {
    await expect(service.save('nobody', {})).rejects.toThrow(/no Hermes profile called "nobody"/)
    await expect(service.save('sam', { url: 'wiki.lan' })).rejects.toThrow(/http:\/\//)
    await expect(service.save('sam', { token: 'two words' })).rejects.toThrow(/no spaces/)
    const cleared = await service.save('sam', { clearToken: true })
    expect(cleared.hasToken).toBe(false)
    expect(env('sam')).not.toContain('LLM_WIKI_TOKEN')
  })

  it('reads the wiki identity line', () => {
    expect(wikiBaseUrl('http://w:27123/family-mcp')).toBe('http://w:27123')
    expect(parseWhoami('You are acting for: House assistant (shared-parents, id faith-parents).')).toEqual({ name: 'House assistant', kind: 'shared-parents', id: 'faith-parents' })
    expect(wikiView({ name: 'M', kind: 'master', id: 'master' })).toBe('everyone')
    expect(wikiView(null)).toBe('unknown')
  })
})
