// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { hermesExtensionsMessages } from '@/i18n/hermes-agent-extensions-messages'

const hermesAgent = vi.fn()
vi.mock('@/api/hermes/agent-api', () => ({ hermesAgent: (...args: unknown[]) => hermesAgent(...args) }))

const api = await import('@/api/hermes/extensions')
const { default: McpOAuthConnect } = await import('@/components/hermes/mcp/McpOAuthConnect.vue')

beforeEach(() => { hermesAgent.mockReset() })

const plugin = (over: Partial<import('@/api/hermes/extensions').PluginCatalogEntry>) =>
  ({ name: 'p', description: '', tier: 'community', category: 'tools', installed: false, update_available: false, ...over }) as import('@/api/hermes/extensions').PluginCatalogEntry

describe('MCP sign-in address', () => {
  it('reads code and state from the address the browser landed on', () => {
    expect(api.parseOAuthRedirect('http://127.0.0.1:43663/api/mcp/oauth/callback/notion?code=abc&state=xyz'))
      .toEqual({ code: 'abc', state: 'xyz' })
    expect(api.parseOAuthRedirect('  ?state=s1&error=access_denied ')).toEqual({ state: 's1', error: 'access_denied' })
    expect(api.parseOAuthRedirect('http://localhost/cb?code=c&state=s&iss=https%3A%2F%2Fid.example')).toEqual({ code: 'c', state: 's', iss: 'https://id.example' })
  })

  it('rejects addresses without a code or state', () => {
    expect(api.parseOAuthRedirect('')).toBeNull()
    expect(api.parseOAuthRedirect('http://127.0.0.1/cb?code=abc')).toBeNull()
    expect(api.parseOAuthRedirect('http://127.0.0.1/cb?state=abc')).toBeNull()
  })

  it('treats Hermes\'s HTML answer to the callback as accepted', async () => {
    hermesAgent.mockRejectedValueOnce(new SyntaxError('Unexpected token <'))
    await expect(api.deliverMcpOAuthCallback('my server', { code: 'c', state: 's' })).resolves.toBeUndefined()
    expect(hermesAgent).toHaveBeenCalledWith('mcp/oauth/callback/my%20server', { query: { code: 'c', state: 's' } })
    hermesAgent.mockRejectedValueOnce(new Error('API Error 400'))
    await expect(api.deliverMcpOAuthCallback('x', { code: 'c', state: 's' })).rejects.toThrow('400')
  })
})

describe('catalog and hub filters', () => {
  it('filters the MCP catalog by text and installed state', () => {
    const entries = [
      { name: 'notion', description: 'Pages', installed: true },
      { name: 'linear', description: 'Issues', installed: false },
    ] as import('@/api/hermes/extensions').McpCatalogEntry[]
    expect(api.filterMcpCatalog(entries, 'iss').map(e => e.name)).toEqual(['linear'])
    expect(api.filterMcpCatalog(entries, '', 'installed').map(e => e.name)).toEqual(['notion'])
    expect(api.filterMcpCatalog(entries, '', 'available').map(e => e.name)).toEqual(['linear'])
  })

  it('orders plugins installed first, then official, verified, community', () => {
    const list = [
      plugin({ name: 'b', tier: 'community' }),
      plugin({ name: 'a', tier: 'official' }),
      plugin({ name: 'c', tier: 'verified' }),
      plugin({ name: 'z', tier: 'community', installed: true, update_available: true }),
    ]
    expect(api.filterPluginCatalog(list, { query: '' }).map(p => p.name)).toEqual(['z', 'a', 'c', 'b'])
    expect(api.filterPluginCatalog(list, { query: '', show: 'updates' }).map(p => p.name)).toEqual(['z'])
    expect(api.filterPluginCatalog(list, { query: '', tier: 'verified' }).map(p => p.name)).toEqual(['c'])
    expect(api.filterPluginCatalog([plugin({ name: 'ha', platforms: ['homeassistant'] })], { query: 'homeassist' })).toHaveLength(1)
  })

  it('names install and update answers that need a decision', () => {
    expect(api.pluginActionProblem({ ok: true })).toBeNull()
    expect(api.pluginActionProblem({ ok: false, consent_required: true })).toBe('consent')
    expect(api.pluginActionProblem({ ok: false, scan_blocked: true })).toBe('scan')
    expect(api.pluginActionProblem({ ok: false, error: 'nope' })).toBe('nope')
  })

  it('calls Hermes\'s plugin endpoints', async () => {
    hermesAgent.mockResolvedValue({ ok: true })
    await api.installHubPlugin('homeassistant')
    expect(hermesAgent).toHaveBeenLastCalledWith('dashboard/agent-plugins/install', { method: 'POST', body: { identifier: '', catalog_name: 'homeassistant', enable: true } })
    await api.updateHubPlugin('owner/x', { force: true })
    expect(hermesAgent).toHaveBeenLastCalledWith('dashboard/agent-plugins/owner/x/update', { method: 'POST', body: { force: true } })
    await api.removeHubPlugin('x')
    expect(hermesAgent).toHaveBeenLastCalledWith('dashboard/agent-plugins/x', { method: 'DELETE' })
    await api.setPluginsAutoUpdate(true)
    expect(hermesAgent).toHaveBeenLastCalledWith('dashboard/plugins/auto-update', { method: 'PUT', body: { enabled: true } })
    await api.installMcpCatalogEntry('notion')
    expect(hermesAgent).toHaveBeenLastCalledWith('mcp/catalog/install', { method: 'POST', body: { name: 'notion', env: {}, enable: true } })
  })
})

describe('MCP sign-in window', () => {
  it('starts the sign-in, accepts a pasted address and reports success', async () => {
    vi.useFakeTimers()
    const flow = { flow_id: 'f1', server_name: 'notion', status: 'authorization_required', authorization_url: 'https://auth.example/authorize?state=s', error: null }
    hermesAgent.mockImplementation(async (path: string) => {
      if (path === 'mcp/servers/notion/auth') return flow
      if (path.startsWith('mcp/oauth/callback/')) throw new SyntaxError('html')
      if (path === 'mcp/oauth/flows/f1') return { ...flow, status: 'approved' }
      throw new Error(`unexpected ${path}`)
    })
    const i18n = createI18n({ legacy: false, locale: 'en', messages: { en: hermesExtensionsMessages.en } as any })
    const wrapper = mount(McpOAuthConnect, { props: { show: true, server: 'notion' }, global: { plugins: [i18n] }, attachTo: document.body })
    await flushPromises()
    const input = document.body.querySelector('input') as HTMLInputElement
    expect(input).toBeTruthy()
    input.value = 'http://127.0.0.1:1/api/mcp/oauth/callback/notion?code=c1&state=s'
    input.dispatchEvent(new Event('input'))
    await flushPromises()
    const send = Array.from(document.body.querySelectorAll('button')).find(b => b.textContent?.includes('Send')) as HTMLButtonElement
    send.click()
    await flushPromises()
    expect(hermesAgent).toHaveBeenCalledWith('mcp/oauth/callback/notion', { query: { code: 'c1', state: 's' } })
    await vi.advanceTimersByTimeAsync(2100)
    await flushPromises()
    expect(wrapper.emitted('connected')?.[0]).toEqual(['notion'])
    expect(document.body.textContent).toContain('notion is signed in')
    wrapper.unmount()
    vi.useRealTimers()
  })
})
