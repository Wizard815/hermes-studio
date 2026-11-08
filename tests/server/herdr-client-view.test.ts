import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, readlink, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { herdrEndpointHash, studioClientView } from '../../packages/server/src/modules/coding-agents/services/herdr/client-view'

describe('Studio\'s embedded herdr view', () => {
  let dir: string
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'herdr-view-')) })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  it('hashes socket paths like herdr (FNV-1a 64, 16 hex digits)', () => {
    expect(herdrEndpointHash('')).toBe('cbf29ce484222325')
    expect(herdrEndpointHash('a')).toBe('af63dc4c8601ec8c')
  })

  it('connects through its own links, so herdr keeps a separate sidebar setting for Studio', async () => {
    const env = { XDG_STATE_HOME: join(dir, 'state') }
    const api = '/run/user/1000/herdr/herdr.sock'
    const view = studioClientView(api, { env, platform: 'linux', baseDir: dir })!
    const socket = view.env.HERDR_SOCKET_PATH
    expect(view.args).toEqual([])
    expect(await readlink(socket)).toBe(api)
    expect(await readlink(socket.replace(/herdr\.sock$/, 'herdr-client.sock'))).toBe('/run/user/1000/herdr/herdr-client.sock')
    const prefs = join(dir, 'state', 'herdr', 'client-shell', `local-${herdrEndpointHash(socket.replace(/herdr\.sock$/, 'herdr-client.sock'))}.json`)
    expect(JSON.parse(await readFile(prefs, 'utf8'))).toEqual({ sidebar_collapsed: true })
    // A choice made later in Studio's herdr view is kept.
    await writeFile(prefs, '{"sidebar_collapsed":false}')
    expect(studioClientView(api, { env, platform: 'linux', baseDir: dir })!.env.HERDR_SOCKET_PATH).toBe(socket)
    expect(JSON.parse(await readFile(prefs, 'utf8'))).toEqual({ sidebar_collapsed: false })
    expect(existsSync(join(dir, 'state', 'herdr', 'client-shell'))).toBe(true)
  })

  it('falls back to herdr as usual where it cannot link sockets', () => {
    expect(studioClientView('\\\\.\\pipe\\herdr', { platform: 'win32', baseDir: dir })).toBeNull()
    expect(studioClientView('', { platform: 'linux', baseDir: dir })).toBeNull()
  })
})
