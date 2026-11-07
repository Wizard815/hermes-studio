import { describe, expect, it } from 'vitest'
import { keyboardInput, pointerGesture } from '@/utils/android-input'

describe('Android screen input', () => {
  it('turns a short press into a tap, a held press into a long press and a drag into a swipe', () => {
    expect(pointerGesture({ x: 0.5, y: 0.5, t: 0 }, { x: 0.505, y: 0.5, t: 120 })).toEqual({ type: 'tap', x: 0.5, y: 0.5 })
    expect(pointerGesture({ x: 0.2, y: 0.3, t: 0 }, { x: 0.2, y: 0.3, t: 900 })).toEqual({ type: 'longpress', x: 0.2, y: 0.3, ms: 900 })
    expect(pointerGesture({ x: 0.5, y: 0.8, t: 0 }, { x: 0.5, y: 0.2, t: 30 }))
      .toEqual({ type: 'swipe', x1: 0.5, y1: 0.8, x2: 0.5, y2: 0.2, ms: 80 })
  })

  it('sends named keys and printable characters, and leaves shortcuts to the browser', () => {
    const key = (k: string, mods: Partial<KeyboardEvent> = {}) => keyboardInput({ key: k, ctrlKey: false, metaKey: false, altKey: false, ...mods } as KeyboardEvent)
    expect(key('Enter')).toEqual({ key: 'enter' })
    expect(key('ArrowLeft')).toEqual({ key: 'left' })
    expect(key('a')).toEqual({ text: 'a' })
    expect(key('c', { ctrlKey: true })).toBeNull()
    expect(key('Shift')).toBeNull()
  })
})
