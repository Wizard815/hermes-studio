// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { createPinia, setActivePinia } from 'pinia'
import { NMessageProvider } from 'naive-ui'
import { defineComponent, h } from 'vue'
import type { HermesEnvField, HermesPlatform } from '@/api/hermes/channels'
import {
  buildPlatformUpdate, cleanError, deliveryTargets, extraPlatforms, normalizeWebhookName, panelFields,
  publicWebhookUrl, splitIds, stateKey, stateTagType,
} from '@/components/hermes/channels/channel-helpers'
import { hermesChannelsMessages } from '@/i18n/hermes-agent-channels-messages'

const updateHermesPlatform = vi.fn(async () => ({ ok: true }))
const testHermesPlatform = vi.fn(async () => ({ ok: true, state: 'connected', message: 'ntfy is connected.' }))
vi.mock('@/api/hermes/channels', () => ({
  updateHermesPlatform: (...args: unknown[]) => (updateHermesPlatform as any)(...args),
  testHermesPlatform: (...args: unknown[]) => (testHermesPlatform as any)(...args),
  listHermesPlatforms: vi.fn(async () => ({ platforms: [] })),
  getMattermostSetup: (...args: unknown[]) => (getMattermostSetup as any)(...args),
  inspectMattermostSetup: (...args: unknown[]) => (inspectMattermostSetup as any)(...args),
  applyMattermostSetup: (...args: unknown[]) => (applyMattermostSetup as any)(...args),
}))
const mmRecord = {
  url: 'http://mm', team: { id: 't1', name: 'home', display_name: 'Home' }, user: { id: 'u1', username: 'alex' }, bot: { id: 'b1', username: 'hermes' },
  channels: [{ role: 'main', id: 'c1', name: 'hermes', display_name: 'hermes' }, { role: 'home_alerts', id: 'c2', name: 'home-alerts', display_name: 'home-alerts' }, { role: 'server_alerts', id: 'c3', name: 'server-alerts', display_name: 'server-alerts' }],
  updated_at: '',
}
const getMattermostSetup = vi.fn(async () => ({ current: null }))
const inspectMattermostSetup = vi.fn(async () => ({
  url: 'http://mm', bot: { id: 'b1', username: 'hermes' }, using_admin: false, current: null,
  teams: [{ id: 't1', name: 'home', display_name: 'Home', bot_member: true }],
  defaults: { main: 'hermes', home_alerts: 'home-alerts', server_alerts: 'server-alerts' },
}))
const applyMattermostSetup = vi.fn(async () => ({ ok: true, ...mmRecord, steps: ['created ~hermes'], restarted: true, restart_error: null }))
vi.mock('@/api/client', () => ({ isStoredSuperAdmin: () => true, request: vi.fn() }))
vi.mock('@/api/hermes/profiles', () => ({ restartProfileGateway: vi.fn() }))
vi.mock('@/stores/hermes/profiles', () => ({ useProfilesStore: () => ({ activeProfileName: 'default' }) }))

const field = (key: string, extra: Partial<HermesEnvField> = {}): HermesEnvField => ({
  key, required: false, is_set: false, redacted_value: null, value: null, description: '', prompt: key, help: '',
  url: null, is_password: false, is_list: false, advanced: false, ...extra,
})
const platform = (id: string, env: HermesEnvField[], extra: Partial<HermesPlatform> = {}): HermesPlatform => ({
  id, name: id.toUpperCase(), description: '', docs_url: null, enabled: false, configured: false, gateway_running: false,
  state: 'disabled', error_code: null, error_message: null, updated_at: null, home_channel: null, env_vars: env, ...extra,
})

describe('channel helpers', () => {
  it('builds a Hermes update without echoing secrets back', () => {
    const fields = [
      field('NTFY_TOKEN', { is_password: true, is_set: true }),
      field('NTFY_TOPIC', { required: true }),
      field('NTFY_ALLOWED_USERS', { is_list: true, is_set: true, value: 'a,b' }),
      field('NTFY_SERVER_URL', { is_set: true }),
    ]
    // Untouched secret and plain field: nothing sent. Unchanged list: nothing sent.
    expect(buildPlatformUpdate(fields, { NTFY_ALLOWED_USERS: 'a,b' }, [])).toEqual({})
    // New topic, blank secret keeps it, emptied list clears it, explicit remove clears the URL.
    expect(buildPlatformUpdate(fields, { NTFY_TOKEN: '', NTFY_TOPIC: ' alerts ', NTFY_ALLOWED_USERS: '' }, ['NTFY_SERVER_URL'], true))
      .toEqual({ enabled: true, env: { NTFY_TOPIC: 'alerts' }, clear_env: ['NTFY_SERVER_URL', 'NTFY_ALLOWED_USERS'] })
    expect(buildPlatformUpdate(fields, { NTFY_TOKEN: 'tk_new' }, [])).toEqual({ env: { NTFY_TOKEN: 'tk_new' } })
  })

  it('hides fields Studio cards already edit and splits optional tuning', () => {
    const tg = platform('telegram', [field('TELEGRAM_BOT_TOKEN', { required: true, is_password: true }), field('TELEGRAM_ALLOWED_USERS', { is_list: true })])
    expect(panelFields(tg, true).basic.map(f => f.key)).toEqual(['TELEGRAM_ALLOWED_USERS'])
    expect(panelFields(tg, false).basic.map(f => f.key)).toEqual(['TELEGRAM_BOT_TOKEN', 'TELEGRAM_ALLOWED_USERS'])
    const line = platform('line', [field('LINE_CHANNEL_SECRET', { required: true }), field('LINE_PORT'), field('LINE_X', { advanced: true })])
    expect(panelFields(line, false).advanced.map(f => f.key)).toEqual(['LINE_PORT', 'LINE_X'])
  })

  it('lists every other Hermes platform, active ones first', () => {
    const list = [platform('telegram', []), platform('webhook', []), platform('irc', []), platform('ntfy', [], { enabled: true })]
    expect(extraPlatforms(list).map(p => p.id)).toEqual(['ntfy', 'irc'])
    // Mattermost has its own card now, so it is not in "More channels"; its Hermes fields all stay in that card.
    expect(extraPlatforms([platform('mattermost', [])])).toEqual([])
    const mm = platform('mattermost', [field('MATTERMOST_URL', { required: true }), field('MATTERMOST_TOKEN', { required: true, is_password: true }), field('MATTERMOST_ALLOWED_USERS', { is_list: true })])
    expect(panelFields(mm, true).basic.map(f => f.key)).toEqual(['MATTERMOST_URL', 'MATTERMOST_TOKEN', 'MATTERMOST_ALLOWED_USERS'])
    expect(deliveryTargets([platform('telegram', [], { configured: true }), platform('irc', [])])).toEqual(['log', 'telegram'])
  })

  it('maps states, errors, ids, names and URLs', () => {
    expect(stateTagType('connected')).toBe('success')
    expect(stateTagType('pending_restart')).toBe('warning')
    expect(stateTagType('fatal')).toBe('error')
    expect(stateKey('fatal')).toBe('error')
    expect(stateKey('weird')).toBe('unknown')
    expect(cleanError(new Error('API Error 400: Bad token'))).toBe('Bad token')
    expect(splitIds('1, 2\n2 3')).toEqual(['1', '2', '3'])
    expect(normalizeWebhookName('GitHub Push')).toBe('github-push')
    expect(normalizeWebhookName('-bad')).toBeNull()
    expect(publicWebhookUrl('http://localhost:8644/webhooks/x', 'nas.local')).toBe('http://nas.local:8644/webhooks/x')
    expect(publicWebhookUrl('http://localhost:8644/webhooks/x', 'localhost')).toBe('http://localhost:8644/webhooks/x')
  })

  it('every locale has every channels string', () => {
    const keys = (value: unknown, prefix = ''): string[] => typeof value === 'object' && value
      ? Object.entries(value).flatMap(([k, v]) => keys(v, `${prefix}${k}.`))
      : [prefix]
    const reference = keys(hermesChannelsMessages.en).sort()
    expect(Object.keys(hermesChannelsMessages)).toHaveLength(12)
    for (const [locale, messages] of Object.entries(hermesChannelsMessages)) expect(keys(messages).sort(), locale).toEqual(reference)
  })
})

describe('Hermes platform panel', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    updateHermesPlatform.mockClear()
  })

  it('shows a stored secret as set, never its value, and saves a replacement', async () => {
    const { default: HermesPlatformPanel } = await import('@/components/hermes/channels/HermesPlatformPanel.vue')
    const i18n = createI18n({ legacy: false, locale: 'en', messages: { en: hermesChannelsMessages.en as any } })
    const p = platform('ntfy', [
      field('NTFY_TOPIC', { required: true, is_set: true, redacted_value: 'ale…rts' }),
      field('NTFY_TOKEN', { is_password: true, is_set: true, redacted_value: 'tk_…xyz' }),
    ], { enabled: true, configured: true, state: 'gateway_stopped' })
    const Host = defineComponent(() => () => h(NMessageProvider, null, { default: () => h(HermesPlatformPanel, { platform: p }) }))
    const wrapper = mount(Host, { global: { plugins: [i18n] }, attachTo: document.body })
    expect(wrapper.text()).toContain('Gateway stopped')
    expect(wrapper.text()).toContain('Set')
    expect(wrapper.html()).not.toContain('tk_…xyz')
    const inputs = wrapper.findAll('input')
    await inputs[1].setValue('tk_replacement')
    const save = wrapper.findAll('button').find(b => b.text() === 'Save')!
    await save.trigger('click')
    await flushPromises()
    expect(updateHermesPlatform).toHaveBeenCalledWith('ntfy', { env: { NTFY_TOKEN: 'tk_replacement' } })
    wrapper.unmount()
  })

  it('gives Mattermost plain-language fields and setup steps, and keeps its token hidden', async () => {
    const { default: HermesPlatformPanel } = await import('@/components/hermes/channels/HermesPlatformPanel.vue')
    const i18n = createI18n({ legacy: false, locale: 'en', messages: { en: hermesChannelsMessages.en as any } })
    const p = platform('mattermost', [
      field('MATTERMOST_URL', { required: true, prompt: 'Mattermost server URL' }),
      field('MATTERMOST_TOKEN', { required: true, is_password: true, is_set: true, redacted_value: 'abc…xyz' }),
      field('MATTERMOST_ALLOWED_USERS', { is_list: true }),
    ], { enabled: true, configured: false, state: 'not_configured' })
    const Host = defineComponent(() => () => h(NMessageProvider, null, { default: () => h(HermesPlatformPanel, { platform: p, embedded: true }) }))
    const wrapper = mount(Host, { global: { plugins: [i18n] }, attachTo: document.body })
    const text = wrapper.text()
    expect(text).toContain('Server address')
    expect(text).toContain('Bot token')
    expect(text).toContain('Allowed user IDs')
    expect(text).toContain('Add Bot Account')
    expect(text).toContain('@hermes')
    expect(wrapper.html()).not.toContain('abc…xyz')
    expect(wrapper.find('input').attributes('placeholder')).toBe('https://chat.example.com')
    await wrapper.findAll('input')[0].setValue('https://chat.example.com')
    await wrapper.findAll('button').find(b => b.text() === 'Save agent settings')!.trigger('click')
    await flushPromises()
    expect(updateHermesPlatform).toHaveBeenCalledWith('mattermost', { env: { MATTERMOST_URL: 'https://chat.example.com' } })
    wrapper.unmount()
  })
})

describe('Mattermost setup for Hermes', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('waits for the token and a passing test, then sets up the team in one go', async () => {
    const { default: HermesPlatformPanel } = await import('@/components/hermes/channels/HermesPlatformPanel.vue')
    const i18n = createI18n({ legacy: false, locale: 'en', missingWarn: false, fallbackWarn: false, messages: { en: hermesChannelsMessages.en as any } })
    const mm = (extra: Partial<HermesPlatform>) => platform('mattermost', [field('MATTERMOST_URL'), field('MATTERMOST_TOKEN', { is_password: true })], extra)

    const notYet = mount(defineComponent(() => () => h(NMessageProvider, null, { default: () => h(HermesPlatformPanel, { platform: mm({ state: 'not_configured' }), embedded: true }) })), { global: { plugins: [i18n] } })
    await flushPromises()
    expect(notYet.text()).toContain('press Test')
    expect(notYet.find('[data-testid="mattermost-setup-start"]').exists()).toBe(false)
    expect(notYet.text()).toContain('Install it on Unraid')
    notYet.unmount()

    const wrapper = mount(defineComponent(() => () => h(NMessageProvider, null, { default: () => h(HermesPlatformPanel, { platform: mm({ configured: true, enabled: true, state: 'connected' }), embedded: true }) })), { global: { plugins: [i18n] }, attachTo: document.body })
    await flushPromises()
    await wrapper.find('[data-testid="mattermost-setup-start"]').trigger('click')
    await flushPromises()
    expect(inspectMattermostSetup).toHaveBeenCalledWith(undefined)
    await wrapper.find('[data-testid="mattermost-setup-username"] input').setValue('alex')
    await wrapper.find('[data-testid="mattermost-setup-run"]').trigger('click')
    await flushPromises()
    expect(applyMattermostSetup).toHaveBeenCalledWith({ team_id: 't1', username: 'alex', channels: { main: 'hermes', home_alerts: 'home-alerts', server_alerts: 'server-alerts' }, admin: undefined })
    expect(wrapper.text()).toContain('~server-alerts')
    expect(wrapper.text()).toContain('Unraid server alerts')
    wrapper.unmount()
  })
})
