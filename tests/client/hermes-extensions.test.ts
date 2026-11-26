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

describe('Home Assistant and Unraid servers', () => {
  it('builds Home Assistant read-only, with the token only in .env', () => {
    const draft = api.buildHomeAssistantServer({ address: 'homeassistant.local:8123/', token: 'Bearer abc.def' })
    expect(draft).toEqual({
      name: 'home-assistant',
      config: {
        url: 'http://homeassistant.local:8123/api/mcp',
        headers: { Authorization: 'Bearer ${MCP_HOME_ASSISTANT_API_KEY}' },
        tools: { include: [...api.HOME_ASSISTANT_READ_TOOLS] },
      },
      secrets: { MCP_HOME_ASSISTANT_API_KEY: 'abc.def' },
    })
    expect(JSON.stringify(draft.config)).not.toContain('abc.def')
    expect(api.buildHomeAssistantServer({ address: 'https://ha.example/api/mcp', token: 't', readOnly: false }).config)
      .toEqual({ url: 'https://ha.example/api/mcp', headers: { Authorization: 'Bearer ${MCP_HOME_ASSISTANT_API_KEY}' } })
  })

  it('keeps only the read tools in the read-only list', () => {
    const allowed = (name: string) => api.HOME_ASSISTANT_READ_TOOLS.some(glob => new RegExp(`^${glob.replace(/\*/g, '.*')}$`).test(name))
    for (const tool of ['homeassistant__GetLiveContext', 'GetLiveContext', 'llm__GetDateTime', 'history__get_history', 'search__search', 'system_log__get_logs', 'todo__get_items'])
      expect(allowed(tool), tool).toBe(true)
    for (const tool of ['intent__HassTurnOn', 'HassTurnOff', 'homeassistant__call_action', 'todo__HassListAddItem', 'config__reload_config_entry', 'assist_satellite__HassBroadcast', 'intent__HassCancelAllTimers'])
      expect(allowed(tool), tool).toBe(false)
  })

  it('reports what is missing in the Home Assistant form', () => {
    expect(() => api.buildHomeAssistantServer({ address: '', token: 't' })).toThrow('address')
    expect(() => api.buildHomeAssistantServer({ address: 'ha:8123', token: ' ' })).toThrow('token')
  })

  it('builds the Unraid Management Agent with a token, a Connect URL or nothing', () => {
    expect(api.buildUnraidServer({ address: 'tower.local', auth: 'token', token: 'uma' })).toEqual({
      name: 'unraid',
      config: { url: 'http://tower.local:8043/mcp', headers: { Authorization: 'Bearer ${MCP_UNRAID_API_KEY}' } },
      secrets: { MCP_UNRAID_API_KEY: 'uma' },
    })
    expect(api.buildUnraidServer({ address: 'https://unraid.home:9443/mcp', auth: 'none' }).config).toEqual({ url: 'https://unraid.home:9443/mcp' })
    expect(api.buildUnraidServer({ auth: 'connect-url', connectUrl: 'http://192.168.1.5:8043/mcp/abcdefgh12345678abcdefgh12345678' })).toEqual({
      name: 'unraid',
      config: { url: 'http://192.168.1.5:8043/mcp/${MCP_UNRAID_CONNECT_SECRET}' },
      secrets: { MCP_UNRAID_CONNECT_SECRET: 'abcdefgh12345678abcdefgh12345678' },
    })
    expect(() => api.buildUnraidServer({ auth: 'connect-url', connectUrl: 'http://tower:8043/mcp' })).toThrow('connectUrl')
    expect(() => api.buildUnraidServer({ address: 'tower', auth: 'token' })).toThrow('token')
  })

  it('builds the script builder settings only when an SSH host is given', () => {
    const ha = { address: 'http://ha:8123', token: 'tok' }
    expect(api.homeAssistantBuilderEnv(ha, { sshHost: '' })).toEqual({})
    expect(api.homeAssistantBuilderEnv(ha, { sshHost: 'ha.local', sshKey: '~/.ssh/ha' })).toEqual({
      HA_BUILD_URL: 'http://ha:8123', HA_BUILD_TOKEN: 'tok', HA_BUILD_SSH_HOST: 'ha.local', HA_BUILD_SSH_PORT: '22',
      HA_BUILD_SSH_USER: 'root', HA_BUILD_SSH_KEY: '~/.ssh/ha', HA_BUILD_CONFIG_DIR: 'auto',
    })
    expect(api.homeAssistantBuilderEnv(ha, { sshHost: 'h', configDir: ' /homeassistant ' }).HA_BUILD_CONFIG_DIR).toBe('/homeassistant')
    expect(() => api.homeAssistantBuilderEnv(ha, { sshHost: 'h', sshPort: 'x' })).toThrow('sshPort')
  })
})

describe('MCP tool include globs', () => {
  it('matches exact names and * globs only', () => {
    expect(api.toolIncluded('homeassistant__GetLiveContext', ['*GetLiveContext'])).toBe(true)
    expect(api.toolIncluded('search', ['search'])).toBe(true)
    expect(api.toolIncluded('homeassistant__search_actions', ['search'])).toBe(false)
    expect(api.toolIncluded('a.b', ['a?b'])).toBe(true)
    expect(api.toolIncluded('axb', ['a.b'])).toBe(false)
  })
})
