// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { defineComponent, h } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { NMessageProvider } from 'naive-ui'
import { hermesMemoryMessages } from '@/i18n/hermes-agent-memory-messages'

const hermesAgent = vi.fn()
vi.mock('@/api/hermes/agent-api', () => ({ hermesAgent: (...args: unknown[]) => hermesAgent(...args) }))

const api = await import('@/api/hermes/agent-memory')
const { default: SkillLockToggle } = await import('@/components/hermes/skills/SkillLockToggle.vue')

const field = (over: Partial<import('@/api/hermes/agent-memory').MemoryProviderField>) =>
  ({ key: 'k', label: 'K', kind: 'text', value: '', is_set: false, ...over }) as import('@/api/hermes/agent-memory').MemoryProviderField

beforeEach(() => hermesAgent.mockReset())

describe('memory provider form helpers', () => {
  it('never prefills secrets and coerces booleans and numbers', () => {
    expect(api.initialFieldValue(field({ kind: 'secret', value: 'x', is_set: true }))).toBe('')
    expect(api.initialFieldValue(field({ kind: 'bool', value: 'true' }))).toBe(true)
    expect(api.initialFieldValue(field({ kind: 'boolean', value: false }))).toBe(false)
    expect(api.initialFieldValue(field({ kind: 'integer', value: '5' }))).toBe(5)
    expect(api.initialFieldValue(field({ kind: 'number', value: '' }))).toBeNull()
    expect(api.initialFieldValue(field({ kind: 'select', value: 'a' }))).toBe('a')
  })

  it('keeps a stored secret when left blank and skips hidden fields', () => {
    const fields = [
      field({ key: 'api_key', kind: 'secret', is_set: true }),
      field({ key: 'mode', kind: 'select' }),
      field({ key: 'url', when: { mode: 'self' } }),
      field({ key: 'n', kind: 'number' }),
    ]
    expect(api.buildSubmitValues(fields, { api_key: '  ', mode: 'cloud', url: 'http://x', n: null })).toEqual({ mode: 'cloud', n: '' })
    expect(api.buildSubmitValues(fields, { api_key: ' sk-1 ', mode: 'self', url: 'http://x', n: 3 })).toEqual({ api_key: 'sk-1', mode: 'self', url: 'http://x', n: 3 })
  })

  it('labels and colors providers generically', () => {
    expect(api.providerLabel('retaindb')).toBe('RetainDB')
    expect(api.providerLabel('obsidian_vault')).toBe('Obsidian Vault')
    expect(api.providerStatusType('ready')).toBe('success')
    expect(api.providerStatusType('needs_config')).toBe('warning')
    expect(api.providerStatusType('unavailable')).toBe('error')
  })

  it('uses the declared settings panel when a provider has one, else its own schema', async () => {
    hermesAgent.mockImplementation(async (_path: string, init: any) => init?.query?.surface === 'declared'
      ? { name: 'p', label: 'P', fields: [] }
      : { name: 'p', label: 'P', fields: [field({ key: 'a' })] })
    expect((await api.getMemoryProviderConfig('p')).surface).toBe('legacy')
    hermesAgent.mockImplementation(async () => ({ name: 'p', label: 'P', fields: [field({ key: 'a' })] }))
    expect((await api.getMemoryProviderConfig('p')).surface).toBe('declared')
    await api.saveMemoryProviderConfig('p', 'legacy', { a: 1 })
    expect(hermesAgent).toHaveBeenLastCalledWith('memory/providers/p/config', { method: 'PUT', body: { values: { a: 1 } }, query: { surface: undefined } })
  })

  it('matches hub installs by identifier, including ClawHub slugs', () => {
    const skill = { name: 'x', description: '', source: 'clawhub', identifier: 'x', trust_level: 'community', tags: [] }
    expect(api.hubInstalledEntry(skill, { 'clawhub/x': { name: 'x' } })).toEqual({ name: 'x' })
    expect(api.hubInstalledEntry(skill, {})).toBeNull()
    expect(api.hubInstalledEntry({ ...skill, installed: true }, {})).toEqual({})
  })

  it('polls a background action until it ends', async () => {
    hermesAgent
      .mockResolvedValueOnce({ name: 'a', running: true, exit_code: null, lines: [] })
      .mockResolvedValueOnce({ name: 'a', running: false, exit_code: 0, lines: ['done'] })
    const status = await api.waitForAction('a', { sleep: async () => {} })
    expect(status.exit_code).toBe(0)
    expect(hermesAgent).toHaveBeenCalledTimes(2)
  })
})

describe('skill lock toggle', () => {
  it('locks through Hermes and reports the new state', async () => {
    hermesAgent.mockResolvedValue({ ok: true })
    const i18n = createI18n({ legacy: false, locale: 'en', messages: { en: hermesMemoryMessages.en as any } })
    const Host = defineComponent({ setup: () => () => h(NMessageProvider, null, { default: () => h(SkillLockToggle, { name: 'codex', locked: false }) }) })
    const wrapper = mount(Host, { global: { plugins: [i18n] } })
    const button = wrapper.find('button.lock-toggle')
    expect(button.attributes('aria-label')).toBe('Lock')
    await button.trigger('click')
    await flushPromises()
    expect(hermesAgent).toHaveBeenCalledWith('skills/lock', { method: 'PUT', body: { name: 'codex', locked: true } })
    expect(wrapper.findComponent(SkillLockToggle).emitted('toggled')?.[0]).toEqual(['codex', true])
  })
})

describe('memory translations', () => {
  it('every locale has every string', () => {
    const reference = Object.keys(hermesMemoryMessages.en.hermesMemory).sort()
    for (const [locale, messages] of Object.entries(hermesMemoryMessages)) {
      expect(Object.keys(messages.hermesMemory).sort(), locale).toEqual(reference)
      for (const value of Object.values(messages.hermesMemory)) expect(String(value).trim(), locale).not.toBe('')
    }
  })
})
