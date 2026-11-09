import { beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('@/api/studio/sessions', () => ({}))
vi.mock('@/api/coding-agents/herdr', () => ({}))
vi.mock('@/api/coding-agents', () => ({}))
vi.mock('@/api/studio/orb', () => ({ fetchOrbStatus: vi.fn() }))
import { resetOrbConnection, useOrbConnection } from '@/mission/useMission'

const status = (url: string) => ({ connected: !!url, version: '', error: '', settings: { url, hasToken: !!url, fromEnv: false } })

describe('Mission and an optional Pondering Orb', () => {
  beforeEach(() => resetOrbConnection())

  it('asks once whether Orb has an address, for every source', async () => {
    const fetchStatus = vi.fn(async () => status(''))
    const first = useOrbConnection({ fetchStatus })
    const second = useOrbConnection({ fetchStatus })
    await vi.waitFor(() => expect(first.state.checked).toBe(true))
    expect(fetchStatus).toHaveBeenCalledTimes(1)
    expect(second.state).toMatchObject({ checked: true, configured: false })
  })

  it('opens the Orb sources once an address is saved', async () => {
    let url = ''
    const fetchStatus = vi.fn(async () => status(url))
    const orb = useOrbConnection({ fetchStatus })
    await vi.waitFor(() => expect(orb.state.checked).toBe(true))
    expect(orb.state.configured).toBe(false)
    url = 'http://orb.local'
    await orb.refresh()
    expect(orb.state.configured).toBe(true)
  })

  it('treats an unreachable status check as not connected', async () => {
    const orb = useOrbConnection({ fetchStatus: vi.fn(async () => { throw new Error('forbidden') }) })
    await vi.waitFor(() => expect(orb.state.checked).toBe(true))
    expect(orb.state.configured).toBe(false)
  })
})
