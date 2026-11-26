import { describe, expect, it } from 'vitest'
import { createI18n } from 'vue-i18n'
import { projectsMessages } from '../../packages/client/src/i18n/projects-messages'
import { studiosMessages } from '../../packages/client/src/i18n/studios-messages'
import { pinCommentMessages } from '../../packages/client/src/i18n/pin-comment-messages'
import { projectStageMessages } from '../../packages/client/src/i18n/project-stage-messages'

// vue-i18n treats @ | { } as syntax: a stray one (like "git@") throws while a
// dialog renders. Every Projects string must compile in every locale.
function keys(value: unknown, prefix = ''): string[] {
  if (typeof value === 'string') return [prefix]
  return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) => keys(item, prefix ? `${prefix}.${key}` : key))
}

describe('TestProjects_messagesCompile', () => {
  for (const [name, table] of Object.entries({ projectsMessages, studiosMessages, pinCommentMessages, projectStageMessages })) {
    it(`${name}: every string compiles in all 12 locales, with the same keys`, () => {
      const locales = Object.keys(table)
      expect(locales.sort()).toEqual(['ar', 'de', 'en', 'es', 'fr', 'ja', 'ko', 'pt', 'ru', 'tr', 'zh', 'zh-TW'])
      const english = keys(table.en).sort()
      for (const locale of locales) {
        expect(keys(table[locale]).sort(), locale).toEqual(english)
        const i18n = createI18n({ legacy: false, locale, messages: { [locale]: table[locale] as any }, missingWarn: false, fallbackWarn: false })
        for (const key of english) {
          let out = ''
          expect(() => { out = i18n.global.t(key, { n: 1, name: 'X', label: 'X', time: '5 PM', threads: 1, needsYou: 1, tasks: 1, error: 'e', id: 'i', title: 't' }) }, `${locale} ${key}`).not.toThrow()
          expect(out, `${locale} ${key}`).not.toBe(key)
        }
      }
    })
  }
})
