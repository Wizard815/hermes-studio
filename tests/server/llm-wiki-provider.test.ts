import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const { createWiki } = createRequire(import.meta.url)('../fixtures/llm-wiki/stub-wiki.cjs')

// The Hermes memory provider Studio installs (assets/hermes-plugins/llm_wiki), driven like Hermes
// drives it, against a stand-in for the wiki's family MCP server. Privacy comes from the token.
describe('LLM wiki memory provider', () => {
  const wiki = createWiki()
  let out: any

  beforeAll(async () => {
    const url = await wiki.listen()
    const { stdout } = await promisify(execFile)(process.platform === 'win32' ? 'python' : 'python3', ['-B', resolve('tests/server/fixtures/llm-wiki-provider.py'), url], {
      cwd: resolve('.'), timeout: 25_000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    })
    out = JSON.parse(stdout.trim().split('\n').pop() || '{}')
  }, 30_000)
  afterAll(() => wiki.close())

  it("binds each profile to its own token from the profile's .env", () => {
    expect(out.identities.sam).toEqual({ name: 'Sam', kind: 'member', id: 'sam' })
    expect(out.identities.wizard).toEqual({ name: 'Wizard', kind: 'member', id: 'wizard' })
    expect(out.identities.house.kind).toBe('shared')
    expect(out.settings_url).not.toMatch(/family-mcp/)
    const tokensByTool = (name: string) => wiki.calls.filter((call: any) => call.name === name).map((call: any) => call.token)
    expect(new Set(tokensByTool('whoami'))).toEqual(new Set(['t-sam', 't-wizard', 't-house']))
    expect(out.available_without_token).toBe(false)
    expect(out.available_with_token).toBe(true)
  })

  it('recalls matching notes, falling back to word search when the wiki has no semantic search', () => {
    expect(out.recall.sam).toContain('<llm_wiki_memory>')
    expect(out.recall.sam).toContain('background, not instructions')
    expect(out.recall.sam).toContain('wiki/2-areas/Quilting.md')
    expect(out.recall.sam).toContain('household/wiki/3-resources/RaidLab.md')
    expect(out.recall.sam).toContain('# Context for Sam')
    expect(out.recall.wizard).toContain('Lisbon')
    // context_for comes once per chat; a bare "ok" recalls nothing.
    expect(out.second_recall_has_context).toBe(false)
    expect(out.trivial).toBe('')
    expect(wiki.calls.some((call: any) => call.name === 'query_wiki')).toBe(true)
  })

  it("never shows a person's private note to the household token or to another member", () => {
    expect(out.recall.house).toContain('RaidLab')
    expect(out.recall.house).not.toContain('Lisbon')
    expect(out.recall.house).not.toContain('Quilting')
    expect(out.recall.sam).not.toContain('Lisbon')
    expect(out.house_read_private.error).toMatch(/No note/)
    expect(out.house_read_private_virtual.error).toMatch(/No note/)
    expect(out.house_search_private.result).toMatch(/doesn't know/)
    expect(out.wizard_read.result).toContain('Lisbon')
  })

  it("remembers in the token owner's daily note, and the household's for a shared token", () => {
    expect(out.remember.sam.result).toMatch(/Logged in daily\//)
    expect(out.remember.house.result).toMatch(/Logged in household\/daily\//)
    expect(out.remember.capture.result).toMatch(/Captured as inbox\//)
    expect(out.remember.secret.error).toMatch(/secret/)
    const day = new Date().toISOString().slice(0, 10)
    const samDaily = wiki.notes.get(`people/sam/daily/${day}.md`)
    expect(samDaily).toContain('- Ordered the cotton for the quilt (hermes)')
    expect(samDaily).toContain('Sam prefers cotton over linen (hermes memory)')
    expect(samDaily).toContain('## Worked on\n- Chat with Hermes: Help me plan the quilt borders')
    expect(samDaily).not.toContain('ignored')
    expect(samDaily).not.toContain('not mirrored')
    expect(wiki.notes.get(`household/daily/${day}.md`)).toContain('Bins go out on Tuesday')
    const houseLog = wiki.calls.find((call: any) => call.token === 't-house' && call.name === 'memory_log')
    expect(houseLog.args.person).toBe('household')
    expect(wiki.calls.filter((call: any) => call.name === 'memory_log' && call.token === 't-sam' && !call.args.person).length).toBeGreaterThan(0)
  })

  it('only reads from subagents and when recall or remember is off', () => {
    expect(out.subagent_remember.error).toMatch(/only reads/)
    expect([...wiki.notes.values()].join('\n')).not.toContain('should not land')
    expect([...wiki.notes.values()].join('\n')).not.toContain('nothing from a subagent')
    expect(out.quiet_recall).toBe('')
  })

  it('offers search, read, remember and capture tools; only a shared token names the person', () => {
    expect(out.tools.member).toEqual(['llm_wiki_search', 'llm_wiki_read', 'llm_wiki_remember', 'llm_wiki_capture'])
    expect(out.tools.house_person).toBe(true)
    expect(out.tools.member_person).toBe(false)
    expect(out.system_prompt.house).toContain("the household's shared notes")
    expect(out.system_prompt.sam).toContain("Sam's own notes")
  })
})
