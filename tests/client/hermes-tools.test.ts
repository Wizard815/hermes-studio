// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { hermesToolsMessages } from '@/i18n/hermes-agent-tools-messages'

const hermesAgent = vi.fn()
vi.mock('@/api/hermes/agent-api', () => ({ hermesAgent: (...args: unknown[]) => hermesAgent(...args) }))

const api = await import('@/api/hermes/agent-tools')
const { default: HermesActionLog } = await import('@/components/hermes/settings/HermesActionLog.vue')

beforeEach(() => { hermesAgent.mockReset(); hermesAgent.mockResolvedValue({ ok: true }) })

describe('Hermes tools API calls', () => {
  it('toggles and configures toolsets', async () => {
    await api.setToolsetEnabled('web', false)
    expect(hermesAgent).toHaveBeenLastCalledWith('tools/toolsets/web', { method: 'PUT', body: { enabled: false } })
    await api.setToolsetProvider('web', 'Tavily', 'search')
    expect(hermesAgent).toHaveBeenLastCalledWith('tools/toolsets/web/provider', { method: 'PUT', body: { provider: 'Tavily', capability: 'search' } })
    await api.setToolsetProvider('tts', 'Edge')
    expect(hermesAgent).toHaveBeenLastCalledWith('tools/toolsets/tts/provider', { method: 'PUT', body: { provider: 'Edge' } })
    await api.saveToolsetKeys('image_gen', { FAL_KEY: 'k' })
    expect(hermesAgent).toHaveBeenLastCalledWith('tools/toolsets/image_gen/env', { method: 'PUT', body: { env: { FAL_KEY: 'k' } } })
  })

  it('switches the terminal backend and removes hooks with a body', async () => {
    await api.setTerminalBackend('ssh')
    expect(hermesAgent).toHaveBeenLastCalledWith('tools/terminal/backend', { method: 'PUT', body: { backend: 'ssh' } })
    await api.deleteHook('post_tool_call', '/x.sh')
    expect(hermesAgent).toHaveBeenLastCalledWith('ops/hooks', { method: 'DELETE', body: { event: 'post_tool_call', command: '/x.sh' } })
    await api.saveModelRoutes([], 'gone')
    expect(hermesAgent).toHaveBeenLastCalledWith('delegation/backends/model_map', { method: 'PUT', body: { options: [], default: 'gone' } })
    await api.instantiateBlueprint('morning-brief', { time: '08:00' })
    expect(hermesAgent).toHaveBeenLastCalledWith('cron/blueprints/instantiate', { method: 'POST', body: { blueprint: 'morning-brief', values: { time: '08:00' } } })
  })
})

describe('helpers', () => {
  it('sends only keys the user typed', () => {
    expect(api.filledKeys({ A: ' x ', B: '', C: '   ' })).toEqual({ A: 'x' })
  })

  it('finds changed terminal settings', () => {
    const fields = api.TERMINAL_FIELDS.ssh
    expect(api.terminalChanges(fields, {}, { ssh_host: ' tower ', ssh_user: 'root', ssh_port: 22 }))
      .toEqual({ ssh_host: 'tower', ssh_user: 'root', ssh_port: 22 })
    expect(api.terminalChanges(fields, { ssh_host: 'tower', ssh_port: 22 }, { ssh_host: 'tower', ssh_port: '22' })).toEqual({})
    // A cleared number cannot be removed through a merge, so it is not sent.
    expect(api.terminalChanges(fields, { ssh_port: 22 }, { ssh_port: null })).toEqual({})
    expect(api.terminalChanges(api.TERMINAL_FIELDS.docker, {}, { container_persistent: true })).toEqual({ container_persistent: true })
  })

  it('drops a default route that is no longer listed', () => {
    expect(api.routeDefault(['a', 'b'], 'b')).toBe('b')
    expect(api.routeDefault(['a'], 'b')).toBeNull()
    expect(api.routeDefault(['a'], null)).toBeNull()
  })

  it('formats sizes and log lines', () => {
    expect(api.formatBytes(0)).toBe('0 B')
    expect(api.formatBytes(1536)).toBe('1.5 KB')
    expect(api.formatBytes(50 * 1024 * 1024)).toBe('50 MB')
    expect(api.cleanLogLine('\x1b[32m  ✓ web\x1b[0m')).toBe('  ✓ web')
    expect(api.logLineLevel('  ✓ skills')).toBe('ok')
    expect(api.logLineLevel('  ⚠ discord')).toBe('warn')
    expect(api.logLineLevel('  ✗ broken')).toBe('error')
    expect(api.logLineLevel('◆ Memory')).toBe('heading')
  })

  it('fills job templates', () => {
    const bp = {
      key: 'k', title: 'T', description: '', category: '', tags: [],
      fields: [
        { name: 'time', type: 'time', label: 'Time', default: '08:00', options: [], optional: false, strict: true, help: '' },
        { name: 'topic', type: 'text', label: 'Topic', default: null, options: [], optional: false, strict: true, help: '' },
        { name: 'deliver', type: 'enum', label: 'Send to', default: '', options: ['origin'], optional: true, strict: false, help: '' },
      ],
    } as api.Blueprint
    const values = api.blueprintDefaults(bp)
    expect(values).toEqual({ time: '08:00', topic: '', deliver: '' })
    expect(api.missingBlueprintField(bp, values)?.name).toBe('topic')
    values.topic = ' AI news '
    expect(api.missingBlueprintField(bp, values)).toBeUndefined()
    expect(api.blueprintValues(bp, values)).toEqual({ time: '08:00', topic: 'AI news' })
  })
})

describe('translations', () => {
  it('has the same keys in every language', () => {
    const keys = (obj: any, prefix = ''): string[] => Object.entries(obj).flatMap(([k, v]) => typeof v === 'object' ? keys(v, `${prefix}${k}.`) : [`${prefix}${k}`])
    const en = keys(hermesToolsMessages.en).sort()
    expect(en.length).toBeGreaterThan(100)
    for (const [locale, messages] of Object.entries(hermesToolsMessages)) expect(keys(messages).sort(), locale).toEqual(en)
  })
})

describe('HermesActionLog', () => {
  it('shows the outcome and colours result lines', async () => {
    const i18n = createI18n({ legacy: false, locale: 'en', messages: { en: hermesToolsMessages.en as any } })
    const wrapper = mount(HermesActionLog, {
      props: { lines: ['◆ Tools', '  ✓ web', '  ⚠ discord'], running: false, exitCode: 1, finished: true },
      global: { plugins: [i18n] },
    })
    await flushPromises()
    expect(wrapper.text()).toContain('Finished with issues')
    expect(wrapper.find('.line-ok').text()).toContain('web')
    expect(wrapper.find('.line-warn').text()).toContain('discord')
    expect(wrapper.find('.line-heading').exists()).toBe(true)
  })
})
