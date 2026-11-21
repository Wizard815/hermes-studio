// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import en from '@/i18n/locales/en'

const api = vi.hoisted(() => ({
  getCleanRoomCheck: vi.fn(),
  getCleanRoomEgress: vi.fn(),
  rerunCleanRoomCheck: vi.fn(),
}))
vi.mock('@/api/coding-agents', () => api)

const { default: CleanRoomPanel } = await import('@/components/hermes/chat/CleanRoomPanel.vue')

function setup() {
  api.getCleanRoomCheck.mockResolvedValue({
    selfCheck: { at: '2026-11-21T10:00:00Z', container: 'studio-cleanroom-c1', state: 'pass', checks: [
      { id: 'docker-socket', state: 'pass', detail: 'absent' },
      { id: 'environment', state: 'info', detail: 'ANTHROPIC_API_KEY, HOME' },
    ] },
    leaks: { at: '2026-11-21T10:00:00Z', workspace: '/w', findings: [{ path: '.env', kind: 'env' }, { path: 'id_rsa', kind: 'ssh-key' }], truncated: false, scanned: 12 },
  })
  api.getCleanRoomEgress.mockResolvedValue({
    entries: [
      { time: '2026-11-21T10:00:01Z', host: 'example.com', port: 443, allowed: false, reason: 'not allowed (allowlist)', hash: 'a' },
      { time: '2026-11-21T10:00:02Z', host: 'registry.npmjs.org', port: 443, allowed: true, hash: 'b' },
    ],
    chain: { ok: true, lines: 2, chained: 2 },
  })
  const i18n = createI18n({ legacy: false, locale: 'en', messages: { en: en as any } })
  return mount(CleanRoomPanel, { props: { sessionId: 'c1', canRerun: true }, global: { plugins: [i18n] } })
}

describe('clean room panel', () => {
  it('shows a short summary: self-check, secret-looking files and blocked connections', async () => {
    const wrapper = setup()
    await flushPromises()
    expect(wrapper.get('[data-testid="cleanroom-summary"]').text()).toContain('Self-check passed')
    expect(wrapper.get('[data-testid="cleanroom-leak-count"]').text()).toContain('2')
    expect(wrapper.get('[data-testid="cleanroom-blocked-count"]').text()).toContain('1')
    // Collapsed until asked.
    expect(wrapper.find('[data-testid="cleanroom-selfcheck"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('opens to the checks, the file names and the connection list (newest first)', async () => {
    const wrapper = setup()
    await flushPromises()
    await wrapper.get('[data-testid="cleanroom-summary"]').trigger('click')
    expect(wrapper.get('[data-testid="cleanroom-selfcheck"]').text()).toContain('Docker socket')
    expect(wrapper.get('[data-testid="cleanroom-selfcheck"]').text()).toContain('ANTHROPIC_API_KEY, HOME')
    expect(wrapper.get('[data-testid="cleanroom-leaks"]').text()).toContain('id_rsa')
    expect(wrapper.get('[data-testid="cleanroom-leaks"]').text()).toContain('SSH key')
    const rows = wrapper.findAll('[data-testid="cleanroom-egress-row"]').map(row => row.text())
    expect(rows[0]).toContain('registry.npmjs.org:443')
    expect(rows[0]).toContain('allowed')
    expect(rows[1]).toContain('example.com:443')
    expect(rows[1]).toContain('blocked')
    expect(wrapper.get('[data-testid="cleanroom-chain"]').text()).toContain('intact')
    wrapper.unmount()
  })
})
