// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { reactive } from 'vue'

const herdr = reactive<any>({ bridge: { connected: true, chatSpaces: ['awake'] } })
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

const asleepTitles = (wrapper: ReturnType<typeof mount>) => wrapper.findAll('article')
  .filter(card => card.find('[data-testid="mission-chat-asleep"]').exists())
  .map(card => card.find('.source-card-title').text())

describe('Mission chats: asleep in herdr', () => {
  it('marks only chats with no herdr space and no live pane', async () => {
    const wrapper = mount(SourceChats)
    await flushPromises()
    expect(asleepTitles(wrapper)).toEqual(['Sleepy'])
  })

  it('marks nothing while herdr is not connected', async () => {
    herdr.bridge = { connected: false, chatSpaces: [] }
    const wrapper = mount(SourceChats)
    await flushPromises()
    expect(asleepTitles(wrapper)).toEqual([])
  })
})
