import { describe, expect, it } from 'vitest'
import { createI18n } from 'vue-i18n'
import { projectCommitsMessages } from '../../packages/client/src/i18n/project-commits-messages'
import { projectsMessages } from '../../packages/client/src/i18n/projects-messages'

// The board's commit strings: every locale has every key, each compiles
// (vue-i18n treats @ | { } as syntax) and projects-messages carries them.
describe('TestProjects_commitMessages', () => {
  it('compiles in all 12 locales, with the same keys, under projects.commits', () => {
    const english = Object.keys(projectCommitsMessages.en).sort()
    expect(Object.keys(projectCommitsMessages).sort()).toEqual(['ar', 'de', 'en', 'es', 'fr', 'ja', 'ko', 'pt', 'ru', 'tr', 'zh', 'zh-TW'])
    for (const [locale, table] of Object.entries(projectCommitsMessages)) {
      expect(Object.keys(table).sort(), locale).toEqual(english)
      expect((projectsMessages[locale].projects as any).commits, locale).toBe(table)
      const i18n = createI18n({ legacy: false, locale, messages: { [locale]: { projects: { commits: table } } as any }, missingWarn: false, fallbackWarn: false })
      for (const key of english) {
        let out = ''
        expect(() => { out = i18n.global.t(`projects.commits.${key}`, { n: 2, error: 'e' }, 2) }, `${locale} ${key}`).not.toThrow()
        expect(out, `${locale} ${key}`).not.toBe(`projects.commits.${key}`)
      }
    }
  })
})
