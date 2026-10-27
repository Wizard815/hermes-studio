import { describe, expect, it } from 'vitest'
import { normalizeGeneratedTitle, SESSION_TITLE_MAX_WORDS } from '../../packages/server/src/modules/studio/services/chat-run/session-title'

describe('normalizeGeneratedTitle', () => {
  it('strips quotes, labels and trailing punctuation', () => {
    expect(normalizeGeneratedTitle('"Plan a weekend trip to Lisbon."')).toBe('Plan a weekend trip to Lisbon')
    expect(normalizeGeneratedTitle('Title: Fix login bug\nbecause...')).toBe('Fix login bug')
  })

  it('caps the title at 15 words', () => {
    const long = Array.from({ length: 30 }, (_, i) => `w${i}`).join(' ')
    expect(normalizeGeneratedTitle(long).split(' ')).toHaveLength(SESSION_TITLE_MAX_WORDS)
  })

  it('returns empty for empty replies', () => {
    expect(normalizeGeneratedTitle('  \n ')).toBe('')
  })
})
