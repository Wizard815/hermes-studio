// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { createI18n } from 'vue-i18n'
import { homelabToolsMessages } from '../../packages/client/src/i18n/homelab-tools-messages'
import { directoryServerName, directorySetupPrompt } from '../../packages/client/src/api/hermes/extensions'
import { packedRepoFile } from '../../packages/client/src/api/studio/repo-pack'

function keys(value: unknown, prefix = ''): string[] {
  if (typeof value === 'string') return [prefix]
  return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) => keys(item, prefix ? `${prefix}.${key}` : key))
}

describe('TestHomelabTools_messages', () => {
  it('has the same keys in all 12 locales and every string compiles', () => {
    const table = homelabToolsMessages as Record<string, unknown>
    expect(Object.keys(table).sort()).toEqual(['ar', 'de', 'en', 'es', 'fr', 'ja', 'ko', 'pt', 'ru', 'tr', 'zh', 'zh-TW'])
    const english = keys(table.en).sort()
    for (const locale of Object.keys(table)) {
      expect(keys(table[locale]).sort(), locale).toEqual(english)
      const i18n = createI18n({ legacy: false, locale, messages: { [locale]: table[locale] as any }, missingWarn: false, fallbackWarn: false })
      for (const key of english) {
        let out = ''
        expect(() => { out = i18n.global.t(key, { name: 'X', shown: 1, total: 2, time: 'now' }) }, `${locale} ${key}`).not.toThrow()
        expect(out, `${locale} ${key}`).not.toBe(key)
      }
    }
  })
})

describe('TestMcpDirectory_client', () => {
  it('makes a Hermes server name from a list name', () => {
    expect(directoryServerName('tevonsb/homeassistant-mcp')).toBe('homeassistant')
    expect(directoryServerName('@octocrawl/mcp')).toBe('mcp')
    expect(directoryServerName('Some Org/Weather MCP Server')).toBe('weather')
  })

  it('asks Hermes to read the README and to ask before installing', () => {
    const text = directorySetupPrompt({ name: 'x/y', url: 'https://github.com/x/y', description: 'Does things.', install: 'npx -y y' })
    expect(text).toContain('https://github.com/x/y')
    expect(text).toContain('npx -y y')
    expect(text).toMatch(/ask me before you install/)
    expect(text).toMatch(/secrets in \.env only/)
  })
})

describe('TestRepoPack_client', () => {
  it('attaches the packed repo as a Markdown file', async () => {
    const file = packedRepoFile({ name: 'a_b.repomix.md', content: '# Directory Structure', bytes: 21, repo: 'a/b' })
    expect(file.name).toBe('a_b.repomix.md')
    expect(file.type).toBe('text/markdown')
    expect(file.size).toBe(21)
  })
})
