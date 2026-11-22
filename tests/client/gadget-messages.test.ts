import { describe, expect, it } from 'vitest'
import { baseCompile } from '@intlify/message-compiler'
import { gadgetMessages } from '../../packages/client/src/i18n/gadget-messages'

describe('Hermes Gadget status messages', () => {
  it('has every message in every locale, and each compiles with the same placeholders', () => {
    const en = gadgetMessages.en.gadget as Record<string, string>
    const placeholders = (text: string) => (text.match(/\{\w+\}/g) || []).sort()
    for (const [locale, messages] of Object.entries(gadgetMessages)) {
      const local = messages.gadget as Record<string, string>
      expect(Object.keys(local).sort(), locale).toEqual(Object.keys(en).sort())
      for (const [key, text] of Object.entries(local)) {
        const errors: string[] = []
        baseCompile(text, { onError: () => errors.push(key) })
        expect(errors, `${locale}.${key}`).toEqual([])
        expect(placeholders(text), `${locale}.${key}`).toEqual(placeholders(en[key]))
      }
    }
    expect(Object.keys(gadgetMessages).sort()).toEqual(['ar', 'de', 'en', 'es', 'fr', 'ja', 'ko', 'pt', 'ru', 'tr', 'zh', 'zh-TW'].sort())
  })
})
