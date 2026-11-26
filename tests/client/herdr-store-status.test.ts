// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const fetchHerdrStatus = vi.fn()
vi.mock('@/api/coding-agents/herdr', () => ({
  connectHerdrSocket: vi.fn(),
  fetchHerdrStatus: () => fetchHerdrStatus(),
  gunzipState: vi.fn(),
  saveHerdrSettings: vi.fn(),
  startHerdrServer: vi.fn(),
}))

import { useHerdrStore } from '@/stores/hermes/herdr'

describe('herdr store status', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('treats an answer without herdr settings as off instead of crashing', async () => {
    fetchHerdrStatus.mockResolvedValueOnce({})
    const store = useHerdrStore()
    await store.refresh()
    expect(store.status).toBeNull()
    expect(store.enabled).toBe(false)
    expect(store.connected).toBe(false)
  })

  it('reads a real status', async () => {
    fetchHerdrStatus.mockResolvedValueOnce({ settings: { enabled: true }, bridge: { connected: true, elevatedChats: ['s1'] } })
    const store = useHerdrStore()
    await store.refresh()
    expect(store.enabled).toBe(true)
    expect(store.isElevated('s1')).toBe(true)
  })
})
