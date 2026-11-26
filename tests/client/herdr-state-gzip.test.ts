import { gzipSync } from 'node:zlib'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/api/client', () => ({ request: vi.fn(), getApiKey: () => 'k', getBaseUrlValue: () => '' }))

import { canGunzip, gunzipState } from '@/api/coding-agents/herdr'

describe('herdr state over the socket, gzipped', () => {
  it('unzips the state the server sends as herdr.state.gz', async () => {
    const state = { connected: true, error: '', version: '0.9.5', focusedPaneId: 'w1:p2', workspaces: [], panes: [], chatSpaces: ['a', 'b'] }
    const zipped = gzipSync(JSON.stringify(state))
    expect(canGunzip()).toBe(true)
    // Socket.IO hands binary attachments over as an ArrayBuffer.
    const buffer = zipped.buffer.slice(zipped.byteOffset, zipped.byteOffset + zipped.byteLength)
    await expect(gunzipState(buffer)).resolves.toEqual(state)
    await expect(gunzipState(new Uint8Array(zipped))).resolves.toEqual(state)
  })
})
