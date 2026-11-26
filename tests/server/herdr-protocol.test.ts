import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile, appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  herdrChatMode,
  herdrKindForStudioAgent,
  nativeSessionIdOf,
  normalizeSnapshot,
  studioAgentForHerdrAgent,
} from '../../packages/server/src/modules/coding-agents/services/herdr/protocol'
import { parseTranscriptLine, readTranscriptFrom } from '../../packages/server/src/modules/coding-agents/services/herdr/transcript'
import { NdjsonReader } from '../../packages/server/src/modules/coding-agents/services/herdr/socket-client'
import { sanitizeHerdrSettings, herdrArgs } from '../../packages/server/src/modules/coding-agents/services/herdr/runtime'
import { pluginCommand, pluginTokenMatches, readOrCreatePluginToken, renderPluginManifest } from '../../packages/server/src/modules/coding-agents/services/herdr/plugin'

describe('herdr protocol helpers', () => {
  it('stores a herdr chat as Studio-routed only when launched with a real provider', () => {
    expect(herdrChatMode('openrouter')).toBe('scoped')
    // Native launches report 'global': those chats must resume with the agent's own configuration.
    expect(herdrChatMode('global')).toBe('global')
    expect(herdrChatMode('')).toBe('global')
    expect(herdrChatMode(undefined)).toBe('global')
  })

  it('maps agent names in both directions', () => {
    expect(herdrKindForStudioAgent('claude-code')).toBe('claude')
    expect(herdrKindForStudioAgent('qoder')).toBe('qodercli')
    expect(herdrKindForStudioAgent('dsh')).toBeNull()
    expect(studioAgentForHerdrAgent('Claude')).toBe('claude-code')
    expect(studioAgentForHerdrAgent('antigravity-cli')).toBe('antigravity')
    expect(studioAgentForHerdrAgent('amp')).toBeNull()
  })

  it('reads native session ids from id and path references', () => {
    expect(nativeSessionIdOf({ pane_id: 'p', workspace_id: 'w', agent_session: { kind: 'id', value: 'abc-123' } })).toBe('abc-123')
    expect(nativeSessionIdOf({ pane_id: 'p', workspace_id: 'w', agent_session: { kind: 'path', value: '/h/.codex/sessions/2026/rollout-2026-01-01T00-00-00-0199aaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl' } }))
      .toBe('0199aaaa-bbbb-cccc-dddd-eeeeeeeeeeee')
    expect(nativeSessionIdOf({ pane_id: 'p', workspace_id: 'w' })).toBeNull()
  })

  it('drops malformed panes from a snapshot', () => {
    const snapshot = normalizeSnapshot({ snapshot: { panes: [{ pane_id: 'w1:p1', workspace_id: 'w1' }, { pane_id: 3 }], workspaces: [{ workspace_id: 'w1' }, {}] } })
    expect(snapshot.panes).toHaveLength(1)
    expect(snapshot.workspaces).toHaveLength(1)
  })

  it('splits NDJSON across chunk boundaries', () => {
    const reader = new NdjsonReader()
    expect(reader.push('{"a":1}\n{"b"')).toEqual([{ a: 1 }])
    expect(reader.push(':2}\nnot json\n')).toEqual([{ b: 2 }])
  })

  it('validates settings and builds session args', () => {
    expect(() => sanitizeHerdrSettings({ session: 'bad name;rm' })).toThrow()
    const settings = sanitizeHerdrSettings({ enabled: true, session: 'work', profile: ' dev ' })
    expect(settings).toMatchObject({ enabled: true, session: 'work', profile: 'dev', autoImport: true })
    expect(herdrArgs(settings, ['status', '--json'])).toEqual(['--session', 'work', 'status', '--json'])
    expect(herdrArgs({ session: '' }, ['status'])).toEqual(['status'])
  })
})

describe('agent transcripts', () => {
  let dir = ''
  afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }) })

  it('parses Claude Code and Codex records and skips tool and system noise', () => {
    expect(parseTranscriptLine(JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' }, timestamp: '2026-01-01T00:00:00Z' })))
      .toEqual({ role: 'user', content: 'hello', timestamp: 1767225600 })
    expect(parseTranscriptLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }, { type: 'tool_use', name: 'Bash' }] } }))?.content).toBe('hi')
    expect(parseTranscriptLine(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'x' }] } }))).toBeNull()
    expect(parseTranscriptLine(JSON.stringify({ type: 'user', message: { content: '<command-name>/clear</command-name>' } }))).toBeNull()
    expect(parseTranscriptLine(JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] } }))?.content).toBe('done')
    expect(parseTranscriptLine(JSON.stringify({ type: 'response_item', payload: { type: 'function_call' } }))).toBeNull()
    expect(parseTranscriptLine('{broken')).toBeNull()
  })

  it('reads appended lines once and leaves partial lines for later', async () => {
    dir = await mkdtemp(join(tmpdir(), 'herdr-transcript-'))
    const file = join(dir, 't.jsonl')
    const line = (text: string) => JSON.stringify({ role: 'user', content: text })
    await writeFile(file, `${line('one')}\n${line('two')}`)
    const first = await readTranscriptFrom(file, 0)
    expect(first.messages.map(m => m.content)).toEqual(['one'])
    await appendFile(file, `\n${line('three')}\n`)
    const second = await readTranscriptFrom(file, first.offset)
    expect(second.messages.map(m => m.content)).toEqual(['two', 'three'])
    expect((await readTranscriptFrom(file, second.offset)).messages).toEqual([])
    // A truncated (rewritten) file restarts from the top.
    await writeFile(file, `${line('fresh')}\n`)
    expect((await readTranscriptFrom(file, second.offset)).messages.map(m => m.content)).toEqual(['fresh'])
  })
})

describe('herdr plugin', () => {
  let dir = ''
  afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }) })

  it('creates one stable token and compares it safely', async () => {
    dir = await mkdtemp(join(tmpdir(), 'herdr-plugin-'))
    const file = join(dir, 'token')
    const token = await readOrCreatePluginToken(file)
    expect(token).toMatch(/^[a-f0-9]{64}$/)
    expect(await readOrCreatePluginToken(file)).toBe(token)
    expect(pluginTokenMatches(token, token)).toBe(true)
    expect(pluginTokenMatches(token, `${token}x`)).toBe(false)
    expect(pluginTokenMatches(token, '')).toBe(false)
  })

  it('declares the Studio actions and popups with argv commands', () => {
    const manifest = renderPluginManifest('/usr/bin/node', '/opt/studio/bin/herdr-plugin/studio-herdr.mjs', '/usr/local/bin/herdr')
    expect(manifest).toContain('id = "studio.hermes"')
    for (const id of ['open-in-studio', 'chats', 'launch', 'settings']) expect(manifest).toContain(`id = "${id}"`)
    expect(manifest).toContain('["/usr/bin/node", "/opt/studio/bin/herdr-plugin/studio-herdr.mjs", "chats"]')
    expect(pluginCommand('/Applications/Ekko Studio.app/Contents/MacOS/Ekko Studio', '/s.mjs', 'chats')[1]).toBe(process.platform === 'win32' ? '/s.mjs' : 'ELECTRON_RUN_AS_NODE=1')
  })
})
