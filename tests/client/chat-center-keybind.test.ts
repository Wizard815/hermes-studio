import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { nextChatCenter } from '@/composables/useKeyboard'

const store = new Map<string, string>()

beforeEach(() => {
  store.clear()
  ;(globalThis as any).localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value) },
    removeItem: (key: string) => { store.delete(key) },
  }
})

afterEach(() => {
  delete (globalThis as any).localStorage
})

describe('chat center keybind (mod+shift+H)', () => {
  it('swaps to herdr when the chat center is saved or unset', () => {
    expect(nextChatCenter()).toBe('herdr')
    localStorage.setItem('studio_chat_center', 'chat')
    expect(nextChatCenter()).toBe('herdr')
  })

  it('swaps back to chat from herdr mode', () => {
    localStorage.setItem('studio_chat_center', 'herdr')
    expect(nextChatCenter()).toBe('chat')
  })

  it('falls back to herdr when storage is unavailable', () => {
    ;(globalThis as any).localStorage = { getItem: () => { throw new Error('blocked') } }
    expect(nextChatCenter()).toBe('herdr')
  })
})
