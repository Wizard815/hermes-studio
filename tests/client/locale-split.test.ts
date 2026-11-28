import { readdirSync } from 'fs'
import { resolve } from 'path'
import { describe, expect, it } from 'vitest'
import { localeSplitPlugin, pickLocale } from '../../scripts/vite-locale-split'

const i18nDir = resolve(__dirname, '../../packages/client/src/i18n')

describe('locale split', () => {
  it('keeps only the asked locale of each language map', () => {
    expect(pickLocale({
      fooMessages: { en: { a: 'A' }, de: { a: 'Ä' }, fr: { a: 'À' } },
      socialMessagesDe: { title: 'Titel' },
      list: ['x'],
    }, 'de')).toEqual({
      fooMessages: { de: { a: 'Ä' } },
      socialMessagesDe: { title: 'Titel' },
      list: ['x'],
    })
  })

  it('gives up on modules that are not plain data', () => {
    expect(pickLocale({ helper: () => 1 }, 'de')).toBeNull()
  })

  it('splits every message file the locale files import', async () => {
    const plugin = localeSplitPlugin(i18nDir)
    const load = plugin.load as (id: string) => string | null
    const files = readdirSync(i18nDir).filter(name => /-(messages|locales)\.ts$/.test(name))
    expect(files.length).toBeGreaterThan(20)
    for (const name of files) {
      const code = load.call({ addWatchFile() {} }, `${resolve(i18nDir, name)}?studio-locale=de`) || ''
      // A bail-out re-exports the whole module; every current file is plain data.
      expect(code, name).not.toContain('export *')
      expect(code.length, name).toBeGreaterThan(0)
    }
  })
})
