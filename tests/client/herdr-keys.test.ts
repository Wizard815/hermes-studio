import { describe, expect, it } from 'vitest'
import { comboBytes, herdrKeyBytes } from '@/utils/herdr-keys'

describe('herdr key buttons', () => {
  it('turns herdr combos into the bytes a terminal sends', () => {
    expect(herdrKeyBytes('prefix+g', 'ctrl+b')).toBe('\x02g')
    expect(herdrKeyBytes('prefix+?', 'ctrl+b')).toBe('\x02?')
    expect(herdrKeyBytes('prefix+shift+r', 'ctrl+a')).toBe('\x01R')
    expect(herdrKeyBytes('prefix+s', 'ctrl+space')).toBe('\x00s')
    expect(herdrKeyBytes('alt+w', 'ctrl+b')).toBe('\x1bw')
    expect(comboBytes('f9')).toBeNull()
    expect(herdrKeyBytes('prefix+s', 'cmd+b')).toBeNull()
    expect(herdrKeyBytes('', 'ctrl+b')).toBeNull()
  })
})
