import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, readlink, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configWithHiddenSidebar, herdrEndpointHash, studioClientView } from '../../packages/server/src/modules/coding-agents/services/herdr/client-view'

describe('Studio\'s embedded herdr view', () => {
  let dir: string
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'herdr-view-')) })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  it('hashes socket paths like herdr (FNV-1a 64, 16 hex digits)', () => {
    expect(herdrEndpointHash('')).toBe('cbf29ce484222325')
    expect(herdrEndpointHash('a')).toBe('af63dc4c8601ec8c')
  })

  it('connects through its own links; herdr\'s sidebar hides under Studio\'s Spaces and shows when picked', async () => {
    const env = { XDG_STATE_HOME: join(dir, 'state'), XDG_CONFIG_HOME: join(dir, 'config') }
    await mkdir(join(dir, 'config', 'herdr'), { recursive: true })
    await writeFile(join(dir, 'config', 'herdr', 'config.toml'), '[keys]\nprefix = "ctrl+a"\n\n[ui]\nsidebar_collapsed_mode = "compact"\nmobile_width_threshold = 80\n')
    const api = '/run/user/1000/herdr/herdr.sock'
    const view = studioClientView(api, { env, platform: 'linux', baseDir: dir })!
    const socket = view.env.HERDR_SOCKET_PATH
    expect(view.args).toEqual([])
    expect(await readlink(socket)).toBe(api)
    expect(await readlink(socket.replace(/herdr\.sock$/, 'herdr-client.sock'))).toBe('/run/user/1000/herdr/herdr-client.sock')
    const prefs = join(dir, 'state', 'herdr', 'client-shell', `local-${herdrEndpointHash(socket.replace(/herdr\.sock$/, 'herdr-client.sock'))}.json`)
    // Studio's Spaces sidebar: herdr's starts collapsed, and collapsed means hidden (not a rail).
    expect(JSON.parse(await readFile(prefs, 'utf8'))).toEqual({ sidebar_collapsed: true })
    const copy = await readFile(view.env.HERDR_CONFIG_PATH, 'utf8')
    expect(copy).toContain('prefix = "ctrl+a"')
    expect(copy).toContain('sidebar_collapsed_mode = "hidden"')
    expect(copy).not.toContain('"compact"')
    expect(copy).toContain('mobile_width_threshold = 80')
    // The user's own config is untouched.
    expect(await readFile(join(dir, 'config', 'herdr', 'config.toml'), 'utf8')).toContain('"compact"')
    // herdr's own sidebar picked: shown, the user's config as is; other preferences are kept.
    await writeFile(prefs, '{"sidebar_collapsed":true,"sidebar_width":30}')
    const own = studioClientView(api, { env, platform: 'linux', baseDir: dir, sidebar: 'herdr' })!
    expect(own.env.HERDR_SOCKET_PATH).toBe(socket)
    expect(own.env.HERDR_CONFIG_PATH).toBeUndefined()
    expect(JSON.parse(await readFile(prefs, 'utf8'))).toEqual({ sidebar_collapsed: false, sidebar_width: 30 })
    expect(existsSync(join(dir, 'state', 'herdr', 'client-shell'))).toBe(true)
  })

  it('hides the collapsed sidebar in a config with or without a [ui] table', () => {
    expect(configWithHiddenSidebar('')).toBe('[ui]\nsidebar_collapsed_mode = "hidden"\n')
    expect(configWithHiddenSidebar('theme = "x"\n[keys]\na = "b"\n')).toBe('theme = "x"\n[keys]\na = "b"\n\n[ui]\nsidebar_collapsed_mode = "hidden"\n')
    expect(configWithHiddenSidebar('[ui]\nsidebar_collapsed_mode = "compact"\n[keys]\nsidebar_collapsed_mode = "x"\n'))
      .toBe('[ui]\nsidebar_collapsed_mode = "hidden"\n[keys]\nsidebar_collapsed_mode = "x"\n')
  })

  it('falls back to herdr as usual where it cannot link sockets', () => {
    expect(studioClientView('\\\\.\\pipe\\herdr', { platform: 'win32', baseDir: dir })).toBeNull()
    expect(studioClientView('', { platform: 'linux', baseDir: dir })).toBeNull()
  })
})
