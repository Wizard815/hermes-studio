// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { baseCompile } from '@intlify/message-compiler'
import { llmWikiMessages } from '../../packages/client/src/i18n/llm-wiki-messages'
import { buildLlmWikiServer, HomeServerFormError } from '../../packages/client/src/api/hermes/extensions'

function strings(value: unknown, path: string[] = []): Array<[string, string]> {
  if (typeof value === 'string') return [[path.join('.'), value]]
  return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => strings(v, [...path, k]))
}

describe('LLM wiki messages', () => {
  it('have every key in every locale and all compile', () => {
    const keys = strings(llmWikiMessages.en).map(([key]) => key).sort()
    expect(Object.keys(llmWikiMessages).sort()).toEqual(['ar', 'de', 'en', 'es', 'fr', 'ja', 'ko', 'pt', 'ru', 'tr', 'zh', 'zh-TW'])
    for (const [locale, messages] of Object.entries(llmWikiMessages)) {
      expect(strings(messages).map(([key]) => key).sort(), locale).toEqual(keys)
      const bad: string[] = []
      for (const [key, message] of strings(messages)) baseCompile(message, { onError: () => bad.push(`${locale}:${key}`) })
      expect(bad).toEqual([])
    }
  })
})

describe("the LLM wiki's MCP card", () => {
  it('builds the /family-mcp server with the token in .env and without the rollover job', () => {
    expect(buildLlmWikiServer({ address: 'wiki.lan', token: ' Bearer llmw_abc ' })).toEqual({
      name: 'llm-wiki',
      config: {
        url: 'http://wiki.lan:27123/family-mcp',
        headers: { Authorization: 'Bearer ${MCP_LLM_WIKI_API_KEY}' },
        timeout: 120,
        connect_timeout: 30,
        tools: { exclude: ['memory_rollover'], resources: false, prompts: false },
      },
      secrets: { MCP_LLM_WIKI_API_KEY: 'llmw_abc' },
    })
    expect(buildLlmWikiServer({ name: 'Sam wiki', address: 'https://wiki.example/family-mcp', token: 'llmw_x' }).config.url).toBe('https://wiki.example/family-mcp')
  })

  it('refuses a missing address or a token with spaces', () => {
    expect(() => buildLlmWikiServer({ address: '', token: 'llmw_x' })).toThrow(HomeServerFormError)
    expect(() => buildLlmWikiServer({ address: 'wiki.lan', token: 'two words' })).toThrow(HomeServerFormError)
  })
})
