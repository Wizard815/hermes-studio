// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { createPinia, setActivePinia } from 'pinia'
import AgentStatusIcon from '@/components/common/AgentStatusIcon.vue'
import { resolveDisplayStatus } from '../../packages/shared/session-state'
import { herdrMessages } from '@/i18n/herdr-messages'

vi.mock('@/api/studio/session-state', () => ({ connectSessionState: vi.fn() }))
vi.mock('@/api/auth-invalidation', () => ({ onAuthInvalidated: () => () => {} }))

const { useSessionStateStore } = await import('@/stores/hermes/session-state')

describe('display status', () => {
  it('ranks blocked over working over done over idle', () => {
    expect(resolveDisplayStatus({ working: true, blocked: true })).toBe('blocked')
    expect(resolveDisplayStatus({ working: true, unread: true })).toBe('working')
    expect(resolveDisplayStatus({ unread: true })).toBe('done')
    expect(resolveDisplayStatus({})).toBe('idle')
    expect(resolveDisplayStatus({ herdr: 'blocked' })).toBe('blocked')
    expect(resolveDisplayStatus({ herdr: 'unknown' })).toBe('unknown')
  })

  it('renders herdr glyphs with a localized label', () => {
    const i18n = createI18n({ legacy: false, locale: 'en', messages: { en: herdrMessages.en as any } })
    const glyphs = (['working', 'blocked', 'done', 'idle', 'unknown'] as const).map(status => {
      const wrapper = mount(AgentStatusIcon, { props: { status }, global: { plugins: [i18n] } })
      expect(wrapper.attributes('aria-label')).toBe(herdrMessages.en.agentStatus[status])
      return wrapper.text()
    })
    expect(glyphs).toEqual(['◐', '×', '✓', '○', '·'])
  })

  it('every locale has every herdr and status string', () => {
    const keys = (value: unknown, prefix = ''): string[] => typeof value === 'object' && value
      ? Object.entries(value).flatMap(([k, v]) => keys(v, `${prefix}${k}.`))
      : [prefix]
    const reference = keys(herdrMessages.en).sort()
    for (const [locale, messages] of Object.entries(herdrMessages)) expect(keys(messages).sort(), locale).toEqual(reference)
  })
})

describe('session state store', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('shows local work immediately and server work this tab never saw', () => {
    const store = useSessionStateStore()
    // No server state yet: the tab that sent the message knows first.
    expect(store.isWorking('a', true)).toBe(true)
    store.sessions.set('a', { sessionId: 'a', working: false, backgroundPending: 0, lastMessageId: 0, readMessageId: 0, unread: false })
    // A stale "not working" from the server must not hide the local run.
    expect(store.isWorking('a', true)).toBe(true)
    store.sessions.set('b', { sessionId: 'b', working: true, backgroundPending: 0, lastMessageId: 0, readMessageId: 0, unread: false })
    expect(store.isWorking('b', false)).toBe(true)
  })

  it('combines blocked, unread and herdr pane status', () => {
    const store = useSessionStateStore()
    store.sessions.set('c', { sessionId: 'c', working: true, blocked: true, backgroundPending: 0, lastMessageId: 2, readMessageId: 1, unread: false })
    expect(store.statusOf('c')).toBe('blocked')
    store.sessions.set('d', { sessionId: 'd', working: false, backgroundPending: 0, lastMessageId: 2, readMessageId: 1, unread: true })
    expect(store.statusOf('d')).toBe('done')
    store.sessions.set('e', { sessionId: 'e', working: false, backgroundPending: 0, lastMessageId: 0, readMessageId: 0, unread: false, herdr: { paneId: 'w1:p1', status: 'working' } })
    expect(store.statusOf('e')).toBe('working')
    expect(store.herdrLink('e')?.paneId).toBe('w1:p1')
  })
})
