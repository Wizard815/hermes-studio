import { describe, expect, it } from 'vitest'
import { loadNaiveLocale, naiveLocaleFor, naiveLocaleKey } from '../../packages/client/src/constants/naiveLocale'

describe('naive locale', () => {
  it('picks the Studio language for a locale', () => {
    expect(naiveLocaleKey('zh_TW')).toBe('zh-tw')
    expect(naiveLocaleKey('zh-HK')).toBe('zh-tw')
    expect(naiveLocaleKey('de-AT')).toBe('de')
    expect(naiveLocaleKey('xx')).toBe('en')
  })

  it('uses English until a language loads, then the loaded one', async () => {
    expect(naiveLocaleFor('de').locale.name).toBe('en-US')
    const de = await loadNaiveLocale('de')
    expect(de.locale.name).toBe('de-DE')
    expect(de.dateLocale.name).toBe('de-DE')
    expect(naiveLocaleFor('de')).toBe(de)
    expect((await loadNaiveLocale('xx')).locale.name).toBe('en-US')
  })
})
