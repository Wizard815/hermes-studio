// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { createI18n } from 'vue-i18n'
import { sandboxMessages } from '../../packages/client/src/i18n/sandbox-messages'

function keys(value: unknown, prefix = ''): string[] {
  if (!value || typeof value !== 'object') return [prefix]
  return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) => keys(item, prefix ? `${prefix}.${key}` : key))
}

describe('sandbox card messages', () => {
  it('has the same keys in all 12 locales and every string compiles', () => {
    const table = sandboxMessages as Record<string, unknown>
    expect(Object.keys(table).sort()).toEqual(['ar', 'de', 'en', 'es', 'fr', 'ja', 'ko', 'pt', 'ru', 'tr', 'zh', 'zh-TW'])
    const english = keys(table.en).sort()
    for (const locale of Object.keys(table)) {
      expect(keys(table[locale]).sort(), locale).toEqual(english)
      const i18n = createI18n({ legacy: false, locale, messages: { [locale]: table[locale] as any }, missingWarn: false, fallbackWarn: false })
      for (const key of english) expect(i18n.global.t(key, { time: '10:00', error: 'x' }), `${locale} ${key}`).not.toBe(key)
    }
  })
})
