import { describe, expect, it } from 'vitest'
import { normalizeGeneratedTitle, SESSION_TITLE_MAX_CHARS } from '../../packages/server/src/modules/studio/services/chat-run/session-title'

describe('normalizeGeneratedTitle', () => {
  it('strips quotes, labels and trailing punctuation', () => {
    expect(normalizeGeneratedTitle('"Plan a weekend trip to Lisbon."')).toBe('Plan a weekend trip to Lisbon')
    expect(normalizeGeneratedTitle('Title: Fix login bug\nbecause...')).toBe('Fix login bug')
  })

  it('caps the title at 25 characters, preferring word boundaries', () => {
    // Test with 25 character limit
    expect(normalizeGeneratedTitle('Plan a weekend trip to Lisbon')).toBe('Plan a weekend trip to')
    
    // Test with very long text
    expect(normalizeGeneratedTitle('Supercalifragilisticexpialidocious')).toHaveLength(SESSION_TITLE_MAX_CHARS)
    
    // Test with long text that should be truncated at word boundary
    const longTitle = 'How to fix the login bug in the authentication system'
    const result = normalizeGeneratedTitle(longTitle)
    expect(result.length).toBeLessThanOrEqual(SESSION_TITLE_MAX_CHARS)
    expect(result).toBe('How to fix the login bug in')
  })

  it('handles punctuation-aware truncation', () => {
    // Should prefer ending on punctuation if near the limit (last 30%)
    const result = normalizeGeneratedTitle('How to fix this bug? Let me explain.')
    expect(result.length).toBeLessThanOrEqual(SESSION_TITLE_MAX_CHARS)
  })

  it('returns empty for empty replies', () => {
    expect(normalizeGeneratedTitle('  \n ')).toBe('')
  })
  
  it('handles Unicode characters properly', () => {
    const result = normalizeGeneratedTitle('日本語のタイトルがとても長い場合でも収める')
    expect(Array.from(result).length).toBeLessThanOrEqual(SESSION_TITLE_MAX_CHARS)
  })
})

describe('session-title-integration', () => {
  it('has correct max character limit', () => {
    expect(SESSION_TITLE_MAX_CHARS).toBe(25)
  })
})
