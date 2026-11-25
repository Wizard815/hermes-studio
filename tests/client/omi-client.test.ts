// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { baseCompile } from '@intlify/message-compiler'
import { omiMessages } from '../../packages/client/src/i18n/omi-messages'
import { buildOmiServer, HomeServerFormError, toolIncluded } from '../../packages/client/src/api/hermes/extensions'
import { appendSharedText, parseStudioOwnShare } from '../../packages/client/src/utils/studio-own-share'

function strings(value: unknown, path: string[] = []): Array<[string, string]> {
  if (typeof value === 'string') return [[path.join('.'), value]]
  return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => strings(v, [...path, k]))
}

describe('Omi messages', () => {
  it('have every key in every locale and all compile', () => {
    const keys = strings(omiMessages.en).map(([key]) => key).sort()
    expect(Object.keys(omiMessages).sort()).toEqual(['ar', 'de', 'en', 'es', 'fr', 'ja', 'ko', 'pt', 'ru', 'tr', 'zh', 'zh-TW'])
    for (const [locale, messages] of Object.entries(omiMessages)) {
      expect(strings(messages).map(([key]) => key).sort(), locale).toEqual(keys)
      const bad: string[] = []
      for (const [key, message] of strings(messages)) baseCompile(message, { onError: () => bad.push(`${locale}:${key}`) })
      expect(bad).toEqual([])
    }
  })
})

describe("Omi's MCP card", () => {
  it("builds Omi's /v1/mcp server with the key in .env and no delete tools", () => {
    const draft = buildOmiServer({ address: 'omi.lan', key: ' Bearer omi_mcp_abc123 ' })
    expect(draft).toEqual({
      name: 'omi',
      config: {
        url: 'http://omi.lan:8000/v1/mcp',
        headers: { Authorization: 'Bearer ${MCP_OMI_API_KEY}' },
        timeout: 120,
        connect_timeout: 30,
        tools: { exclude: ['delete_action_item', 'delete_memory', 'dismiss_person'], resources: false, prompts: false },
      },
      secrets: { MCP_OMI_API_KEY: 'omi_mcp_abc123' },
    })
    expect(toolIncluded('delete_memory', draft.config.tools!.exclude!)).toBe(true)
    expect(toolIncluded('get_day_review', draft.config.tools!.exclude!)).toBe(false)
  })

  it('keeps a typed scheme, port and the /v1/mcp suffix once, and wants an omi_mcp_ key', () => {
    expect(buildOmiServer({ address: 'https://omi.example.com/v1/mcp/', key: 'omi_mcp_x', name: 'Omi Robin' }).config.url).toBe('https://omi.example.com/v1/mcp')
    expect(buildOmiServer({ address: 'http://10.0.0.5:9000', key: 'omi_mcp_x', name: 'Omi Robin' }))
      .toMatchObject({ name: 'omi-robin', config: { url: 'http://10.0.0.5:9000/v1/mcp' }, secrets: { MCP_OMI_ROBIN_API_KEY: 'omi_mcp_x' } })
    expect(() => buildOmiServer({ address: 'omi.lan', key: 'omi_dev_x' })).toThrow(HomeServerFormError)
    expect(() => buildOmiServer({ address: '', key: 'omi_mcp_x' })).toThrow(HomeServerFormError)
  })
})

describe('Share to Studio (Studio Own app)', () => {
  it('takes text and images, and drops anything malformed', () => {
    expect(parseStudioOwnShare({ mode: 'current', text: 'Look at https://example.com', files: [] }))
      .toEqual({ mode: 'current', text: 'Look at https://example.com', files: [] })
    const share = parseStudioOwnShare({
      text: '',
      files: [
        { name: 'a/b.png', type: 'image/png', data: 'iVBORw0KGgo=' },
        { name: 'x.sh', type: 'text/x-shellscript', data: 'ZWNobw==' },
        { name: 'bad.png', type: 'image/png', data: 'not base64!' },
      ],
    })
    expect(share).toEqual({ mode: 'new', text: '', files: [{ name: 'a_b.png', type: 'image/png', data: 'iVBORw0KGgo=' }] })
    expect(parseStudioOwnShare({ text: '   ', files: [] })).toBeNull()
    expect(parseStudioOwnShare('text')).toBeNull()
  })

  it('adds shared text after what is already typed', () => {
    expect(appendSharedText('', ' hello ')).toBe('hello')
    expect(appendSharedText('Summarise this:  ', 'https://example.com')).toBe('Summarise this:\n\nhttps://example.com')
    expect(appendSharedText('draft', '')).toBe('draft')
  })
})
