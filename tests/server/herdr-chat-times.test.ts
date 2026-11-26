import { describe, expect, it } from 'vitest'
import { toMs } from '../../packages/server/src/bootstrap/herdr'

describe('chat times for herdr', () => {
  it('reads Studio\'s second timestamps as milliseconds and keeps millisecond ones', () => {
    expect(toMs(1794430281)).toBe(1794430281000)
    expect(toMs(1794430281000)).toBe(1794430281000)
    expect(toMs(0)).toBe(0)
  })
})
