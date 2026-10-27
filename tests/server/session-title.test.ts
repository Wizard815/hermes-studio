import { describe, expect, it } from 'vitest'
import { normalizeGeneratedTitle, SESSION_TITLE_MAX_CHARS } from '../../packages/server/src/modules/studio/services/chat-run/session-title'

describe('normalizeGeneratedTitle', () => {
  it('strips quotes, labels and trailing punctuation', () => {
    expect(normalizeGeneratedTitle('"Plan a weekend trip to Lisbon."')).toBe('Plan a weekend')
    expect(normalizeGeneratedTitle('Title: Fix login bug\nbecause...')).toBe('Fix login bug')
  })

  it('caps the title at 15 characters, preferring whole words', () => {
    expect(normalizeGeneratedTitle('Plan a weekend trip to Lisbon')).toBe('Plan a weekend')
    expect(normalizeGeneratedTitle('Supercalifragilisticexpialidocious')).toHaveLength(SESSION_TITLE_MAX_CHARS)
    expect(Array.from(normalizeGeneratedTitle('日本語のタイトルがとても長い場合でも十五文字までに収める')).length).toBeLessThanOrEqual(SESSION_TITLE_MAX_CHARS)
  })

  it('returns empty for empty replies', () => {
    expect(normalizeGeneratedTitle('  \n ')).toBe('')
  })
})
