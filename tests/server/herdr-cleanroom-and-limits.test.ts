import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server, type Socket } from 'node:net'
import { chmodSync, mkdtempSync, readlinkSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HerdrSocketClient } from '../../packages/server/src/modules/coding-agents/services/herdr/socket-client'
import { cleanRoomTerminalDocker } from '../../packages/server/src/modules/coding-agents/services/cleanroom'
import { chatSpaceRows, findChatTranscript } from '../../packages/server/src/bootstrap/herdr'
import { newTranscriptSince } from '../../packages/server/src/modules/coding-agents/services/herdr/transcript'

describe('herdr subscriptions', () => {
  let dir: string
  let server: Server
  const sockets: Socket[] = []

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'herdr-sub-'))
    // A stuck herdr: it takes the connection and never answers.
    server = createServer(socket => { sockets.push(socket); socket.on('error', () => {}) })
    await new Promise<void>(resolve => server.listen(join(dir, 'herdr.sock'), resolve))
  })

  afterEach(async () => {
    for (const socket of sockets) socket.destroy()
    await new Promise<void>(resolve => server.close(() => resolve()))
    rmSync(dir, { recursive: true, force: true })
  })

  it('gives up on a subscription herdr never confirms, so the bridge retries', async () => {
    const client = new HerdrSocketClient(join(dir, 'herdr.sock'))
    const closed: string[] = []
    const subscription = client.subscribe([{ type: 'workspace.created' }], () => {}, reason => closed.push(reason), 200)
    const started = Date.now()
    await expect(subscription.ready).rejects.toThrow('subscribe_timeout')
    expect(Date.now() - started).toBeLessThan(2000)
    expect(closed).toEqual(['subscribe_timeout'])
  })
})

describe('clean-room panes in herdr', () => {
  let dir: string
  const previous = process.env.HERMES_WEB_UI_HOME

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'herdr-room-'))
    process.env.HERMES_WEB_UI_HOME = join(dir, 'home')
  })

  afterEach(() => {
    if (previous === undefined) delete process.env.HERMES_WEB_UI_HOME
    else process.env.HERMES_WEB_UI_HOME = previous
    rmSync(dir, { recursive: true, force: true })
  })

  it('runs the docker client under the agent\'s name, so herdr sees the agent', () => {
    if (process.platform === 'win32') return
    const bin = join(dir, 'bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'docker'), '#!/bin/sh\n')
    chmodSync(join(bin, 'docker'), 0o755)
    const link = cleanRoomTerminalDocker('claude', bin)
    expect(link).toBe(join(dir, 'home', 'coding-agent', 'cleanroom', 'bin', 'claude'))
    expect(readlinkSync(link)).toBe(join(bin, 'docker'))
    // Again: the same link, kept.
    expect(cleanRoomTerminalDocker('claude', bin)).toBe(link)
    // No docker on the path, or a name that is not an agent's: plain docker.
    expect(cleanRoomTerminalDocker('claude', join(dir, 'nowhere'))).toBe('docker')
    expect(cleanRoomTerminalDocker('../x', bin)).toBe('docker')
  })
})

describe('chats for herdr spaces', () => {
  it('reads every chat in pages, so chats past one page keep their spaces', () => {
    const all = Array.from({ length: 12 }, (_, i) => ({ id: `c${i}`, parent_session_id: i === 3 ? 'c0' : null, is_archived: i === 4 ? 1 : 0, source: i === 5 ? 'group_chat' : 'cli' })) as any[]
    const pages: Array<[number, number]> = []
    const rows = chatSpaceRows((limit, offset) => { pages.push([limit, offset]); return all.slice(offset, offset + limit) }, 5)
    expect(pages).toEqual([[5, 0], [5, 5], [5, 10]])
    expect(rows.map(row => row.id)).toEqual(['c0', 'c1', 'c2', 'c6', 'c7', 'c8', 'c9', 'c10', 'c11'])
  })
})

describe('clean-room transcripts', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'herdr-room-home-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('mirrors a clean-room agent\'s transcript from the room\'s home folder', async () => {
    const id = '56565656-2222-3333-4444-555555555555'
    const home = join(dir, 'homes', 'abc')
    mkdirSync(join(home, '.claude', 'projects', '-work'), { recursive: true })
    writeFileSync(join(home, '.claude', 'projects', '-work', `${id}.jsonl`), '{}\n')
    await expect(findChatTranscript('claude-code', id, () => [join(dir, 'homes', 'empty'), home])).resolves.toBe(join(home, '.claude', 'projects', '-work', `${id}.jsonl`))
    await expect(findChatTranscript('claude-code', '78787878-2222-3333-4444-555555555555', () => [home])).resolves.toBeNull()
  })

  it('finds the session an agent started in a home folder after a launch, not older ones', async () => {
    const old = '11111111-2222-3333-4444-555555555555'
    const fresh = '22222222-2222-3333-4444-555555555555'
    mkdirSync(join(dir, '.codex', 'sessions', '2026', '11', '14'), { recursive: true })
    writeFileSync(join(dir, '.codex', 'sessions', '2026', '11', '14', `rollout-2026-11-14T10-00-00-${old}.jsonl`), '{}\n')
    await new Promise(resolve => setTimeout(resolve, 1100))
    const since = Date.now()
    await expect(newTranscriptSince('codex', dir, since)).resolves.toBeNull()
    writeFileSync(join(dir, '.codex', 'sessions', '2026', '11', '14', `rollout-2026-11-14T10-05-00-${fresh}.jsonl`), '{}\n')
    await expect(newTranscriptSince('codex', dir, since)).resolves.toMatchObject({ id: fresh })
  })
})

describe('the chat so far stays out of the mirrored chat', async () => {
  const { withoutRecap } = await import('../../packages/server/src/modules/coding-agents/services/herdr/bridge')
  const recap = 'Here is our chat so far:\nuser: book a table\nassistant: which day?\nContinue from here.'
  const m = (role: 'user' | 'assistant', content: string) => ({ role, content, timestamp: 1 })

  it('drops the recap and the answer to it, keeps the next real turn', () => {
    const out = withoutRecap([m('user', recap), m('assistant', 'Got it, continuing.'), m('user', 'Friday please'), m('assistant', 'Booked.')], { text: recap })
    expect(out.messages.map(x => x.content)).toEqual(['Friday please', 'Booked.'])
    expect(out.marker).toBeNull()
  })

  it('handles a recap typed line by line and an answer split across reads', () => {
    const first = withoutRecap([m('user', 'Here is our chat so far:'), m('assistant', 'ok'), m('user', 'user: book a table')], { text: recap })
    expect(first.messages).toEqual([])
    expect(first.marker).toMatchObject({ replying: true })
    const second = withoutRecap([m('assistant', 'still reading'), m('user', 'what time?')], first.marker!)
    expect(second.messages.map(x => x.content)).toEqual(['what time?'])
    expect(second.marker).toBeNull()
  })

  it('keeps everything when the first message is not the recap', () => {
    const out = withoutRecap([m('user', 'hello'), m('assistant', 'hi')], { text: recap })
    expect(out.messages).toHaveLength(2)
    expect(out.marker).toBeNull()
  })
})

describe("Studio-provider agents' transcripts", async () => {
  const { findChatTranscript, studioAgentConfigHomes } = await import('../../packages/server/src/bootstrap/herdr')
  const { configHomeEnv } = await import('../../packages/server/src/modules/coding-agents/services/herdr/bridge')
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')

  it('finds a Codex session kept in a provider config folder (and its runs)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cfg-'))
    try {
      const id = '01a1db8c-a38a-73a3-afb2-dfe9ddc2c776'
      const sessions = join(root, 'default', 'custom_fake', 'codex', 'runs', 'abc', 'sessions', '2026', '11', '14')
      mkdirSync(sessions, { recursive: true })
      writeFileSync(join(sessions, `rollout-2026-11-14T19-33-09-${id}.jsonl`), '{}\n')
      const homes = studioAgentConfigHomes('codex', root)
      expect(homes).toContain(join(root, 'default', 'custom_fake', 'codex', 'runs', 'abc'))
      expect(studioAgentConfigHomes('cursor', root)).toEqual([])
      await expect(findChatTranscript('codex', id, () => [], () => homes)).resolves.toBe(join(sessions, `rollout-2026-11-14T19-33-09-${id}.jsonl`))
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it("passes only the agent's config home on to session detection", () => {
    expect(configHomeEnv({ CODEX_HOME: '/c', PATH: '/bin', OPENAI_API_KEY: 'x' })).toEqual({ CODEX_HOME: '/c' })
    expect(configHomeEnv(undefined)).toEqual({})
  })
})
