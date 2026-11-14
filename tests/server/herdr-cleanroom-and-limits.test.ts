import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server, type Socket } from 'node:net'
import { chmodSync, mkdtempSync, readlinkSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HerdrSocketClient } from '../../packages/server/src/modules/coding-agents/services/herdr/socket-client'
import { cleanRoomTerminalDocker } from '../../packages/server/src/modules/coding-agents/services/cleanroom'
import { chatSpaceRows } from '../../packages/server/src/bootstrap/herdr'

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
