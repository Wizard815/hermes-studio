// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { createPinia, setActivePinia } from 'pinia'
import { NDialogProvider, NMessageProvider } from 'naive-ui'
import { defineComponent, h } from 'vue'
import { hermesModelsMessages } from '@/i18n/hermes-agent-models-messages'

const calls: Array<{ path: string; init: any }> = []
const responses: Record<string, unknown> = {}
vi.mock('@/api/hermes/agent-api', () => ({
  hermesAgent: vi.fn(async (path: string, init: any = {}) => {
    calls.push({ path, init })
    return responses[path] ?? {}
  }),
}))

const studio: Array<{ path: string; init: any }> = []
const studioResponses: Record<string, unknown> = {}
vi.mock('@/api/client', () => ({
  request: vi.fn(async (path: string, init: any = {}) => {
    studio.push({ path, init })
    return studioResponses[path.split('?')[0]] ?? {}
  }),
}))

const api = await import('@/api/hermes/local-models')
const LocalModelsPanel = (await import('@/components/hermes/models/LocalModelsPanel.vue')).default
const CredentialPoolsPanel = (await import('@/components/hermes/models/CredentialPoolsPanel.vue')).default

const i18n = () => createI18n({ legacy: false, locale: 'en', missingWarn: false, fallbackWarn: false, messages: { en: hermesModelsMessages.en as any } })
const mountIn = (component: any, props: Record<string, unknown>) => mount(defineComponent({
  render: () => h(NMessageProvider, () => h(NDialogProvider, () => h(component, props))),
}), { global: { plugins: [i18n()] } })

describe('local models helpers', () => {
  it('formats sizes and remaining time', () => {
    expect(api.formatBytes(0)).toBe('0 MB')
    expect(api.formatBytes(5 * 1024 * 1024)).toBe('5 MB')
    expect(api.formatBytes(18538593472)).toBe('17.3 GB')
    expect(api.formatEta(null)).toBe('')
    expect(api.formatEta(42)).toBe('42s')
    expect(api.formatEta(125)).toBe('2m 5s')
    expect(api.formatEta(3 * 3600 + 120)).toBe('3h 2m')
  })

  it('shows active jobs first, then a few finished ones', () => {
    const job = (job_id: string, status: any) => ({ job_id, status }) as any
    const shown = api.visibleJobs([job('a', 'done'), job('b', 'running'), job('c', 'error'), job('d', 'paused'), job('e', 'done'), job('f', 'done')], 2)
    expect(shown.map(j => j.job_id)).toEqual(['b', 'd', 'a', 'c'])
    expect(api.hasActiveJob(shown)).toBe(true)
    expect(api.hasActiveJob([job('x', 'paused')])).toBe(false)
  })

  it('every locale has every string', () => {
    const reference = Object.keys(hermesModelsMessages.en.hermesModels).sort()
    for (const [locale, messages] of Object.entries(hermesModelsMessages)) expect(Object.keys(messages.hermesModels).sort(), locale).toEqual(reference)
  })
})

describe('Local models panel', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    calls.length = 0
    for (const key of Object.keys(responses)) delete responses[key]
  })

  it('shows hardware, catalog and downloaded models for the chosen profile', async () => {
    responses['local-models/status'] = { runtime_installed: true, tag: 'b1', runtime_backend: 'cpu', server_running: true, active_model_id: 'm1', loaded_models: { m1: 'loaded' }, models: [{ id: 'm1', size_bytes: 1, size_label: '4.0 GB' }], models_dir: '/models' }
    responses['local-models/hardware'] = { uma: false, vram_label: '24.0 GB', vram_usable_bytes: 20 * 2 ** 30, ram_total_bytes: 64 * 2 ** 30, ram_available_bytes: 32 * 2 ** 30, gpu_name: 'RTX 4090', gpu_util_percent: 12 }
    responses['local-models/catalog'] = { models: [{ id: 'qwen', display_name: 'Qwen Small', description: 'Fast', native_context_label: '32K', size_label: '5.0 GB', fit_summary: 'runs at its full 32K context', fits: true, recommended: true }] }
    responses['local-models/jobs'] = { jobs: [{ job_id: 'j1', target: 'Qwen Small (Q4)', status: 'running', detail: 'Downloading', total_bytes: 100, done_bytes: 50, percent: 50, can_pause: true }] }
    // The profile's default comes from Studio's model manager (its gateway Provider for local models).
    studioResponses['/api/hermes/model-local-provider'] = { provider: 'custom:hermes-local', registered: true, base_url: 'http://127.0.0.1:8080/v1', models: ['m1'], default_model: 'm1' }
    const wrapper = mountIn(LocalModelsPanel, { profile: 'work' })
    await flushPromises()
    const text = wrapper.text()
    expect(text).toContain('RTX 4090')
    expect(text).toContain('llama.cpp b1 (cpu)')
    expect(text).toContain('Qwen Small')
    expect(text).toContain('Recommended')
    expect(text).toContain('m1')
    expect(text).toContain('Default')
    expect(text).toContain('Pause')
    expect(calls.every(call => call.init.query?.profile === 'work')).toBe(true)

    const download = wrapper.findAll('button').find(b => b.text() === 'Download')!
    await download.trigger('click')
    await flushPromises()
    const post = calls.find(call => call.path === 'local-models/download')
    expect(post?.init).toMatchObject({ method: 'POST', body: { model_id: 'qwen' } })
    expect(studio.some(call => call.path === '/api/hermes/model-local-provider?profile=work' && call.init.method === 'POST')).toBe(true)
    wrapper.unmount()
  })
})

describe('Key pools panel', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    calls.length = 0
    for (const key of Object.keys(responses)) delete responses[key]
  })

  it('lists the pooled keys of the account Providers', async () => {
    studioResponses['/api/hermes/model-key-pools'] = { providers: [{ provider: 'openrouter', entries: [{ index: 1, id: 'a', label: 'main', source: 'manual', request_count: 3, token_preview: 'sk-…abcd', last_status: 'ok' }] }] }
    const wrapper = mountIn(CredentialPoolsPanel, { profile: 'default' })
    await flushPromises()
    const text = wrapper.text()
    expect(text).toContain('openrouter')
    expect(text).toContain('sk-…abcd')
    expect(text).toContain('3 requests')
    expect(calls).toEqual([])
    wrapper.unmount()
  })
})
