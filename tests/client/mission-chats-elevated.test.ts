// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { reactive } from 'vue'

const herdr = reactive<any>({ elevated: new Set(['awake']), isElevated(id: string) { return this.elevated.has(id) } })
const links: Record<string, { paneId: string }> = { live: { paneId: 'p1' } }

vi.mock('naive-ui', async importOriginal => ({
  ...(await importOriginal<typeof import('naive-ui')>()),
  useMessage: () => ({ error: vi.fn(), success: vi.fn() }),
}))
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('@/stores/hermes/herdr', () => ({ useHerdrStore: () => herdr }))
vi.mock('@/stores/hermes/session-state', () => ({
  useSessionStateStore: () => ({ start: vi.fn(), onListChanged: () => () => undefined, statusOf: () => 'idle', herdrLink: (id: string) => links[id] ?? null }),
}))
vi.mock('@/api/studio/sessions', () => ({
  fetchSessions: vi.fn(async () => [
    { id: 'awake', title: 'Awake', agent: 'codex' },
    { id: 'sleepy', title: 'Sleepy', agent: 'codex' },
    { id: 'live', title: 'Live', agent: 'claude' },
  ]),
}))
vi.mock('@/api/coding-agents/herdr', () => ({ openSessionInHerdr: vi.fn() }))
vi.mock('@/mission/useMission', () => ({ studioUrl: () => null }))

import SourceChats from '@/mission/sources/SourceChats.vue'

const elevatedTitles = (wrapper: ReturnType<typeof mount>) => wrapper.findAll('article')
  .filter(card => card.find('[data-testid="mission-chat-elevated"]').exists())
  .map(card => card.find('.source-card-title').text())

describe('Mission chats: elevated to herdr', () => {
  it('marks elevated chats and chats with a live pane; the rest are Studio-only', async () => {
    const wrapper = mount(SourceChats)
    await flushPromises()
    expect(elevatedTitles(wrapper)).toEqual(['Awake', 'Live'])
    const buttons = wrapper.findAll('article').map(card => card.find('button').text())
    expect(buttons).toEqual(['mission.openInHerdr', 'herdr.elevate', 'mission.showPane'])
  })

  it('marks only live panes while nothing is elevated', async () => {
    herdr.elevated = new Set()
    const wrapper = mount(SourceChats)
    await flushPromises()
    expect(elevatedTitles(wrapper)).toEqual(['Live'])
  })
})
