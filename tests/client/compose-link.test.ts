import { describe, expect, it } from 'vitest'
import { MAX_COMPOSE_LENGTH, composeQueryText, withoutComposeQuery } from '@/utils/compose-link'

describe('compose links (#/hermes/chat?compose=...)', () => {
  it('reads the text of a compose query', () => {
    expect(composeQueryText('Call Sam about the invoice')).toBe('Call Sam about the invoice')
    expect(composeQueryText('')).toBe('')
    expect(composeQueryText(['first', 'second'])).toBe('first')
    expect(composeQueryText(undefined)).toBeNull()
    expect(composeQueryText(null)).toBeNull()
    expect(composeQueryText([null])).toBeNull()
  })

  it('caps the text without splitting a character', () => {
    expect(composeQueryText('a'.repeat(MAX_COMPOSE_LENGTH + 10))).toHaveLength(MAX_COMPOSE_LENGTH)
    const atBoundary = composeQueryText('a'.repeat(MAX_COMPOSE_LENGTH - 1) + '\u{1F600}b')!
    expect(atBoundary).toHaveLength(MAX_COMPOSE_LENGTH - 1)
    // A pair that ends exactly at the limit is kept whole.
    expect(composeQueryText('a'.repeat(MAX_COMPOSE_LENGTH - 2) + '\u{1F600}')).toHaveLength(MAX_COMPOSE_LENGTH)
  })

  it('drops only the compose key from the route query', () => {
    expect(withoutComposeQuery({ compose: 'x', profile: 'work' })).toEqual({ profile: 'work' })
    expect(withoutComposeQuery({ compose: 'x' })).toEqual({})
  })
})
