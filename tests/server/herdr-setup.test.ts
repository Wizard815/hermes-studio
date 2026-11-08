import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import AdmZip from 'adm-zip'
import { herdrTarget, installHerdrRelease } from '../../packages/server/src/modules/coding-agents/services/herdr/install'
import {
  boundKeys,
  chooseStudioKey,
  existingStudioKey,
  herdrConfigPath,
  normalizeKey,
  renderStudioBinding,
} from '../../packages/server/src/modules/coding-agents/services/herdr/keybind'

const DEFAULT_CONFIG = readFileSync(join(__dirname, 'fixtures/herdr-default-config.toml'), 'utf8')

function fakeFetch(files: Record<string, Buffer | object>): typeof fetch {
  return (async (url: string) => {
    const body = files[url]
    if (!body) return new Response('missing', { status: 404 })
    return Buffer.isBuffer(body) ? new Response(body) : new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
}

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

describe('herdr installer', () => {
  let dir = ''
  afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }) })

  it('maps this machine to a herdr release target', () => {
    expect(herdrTarget('linux', 'x64')).toBe('linux-x86_64')
    expect(herdrTarget('darwin', 'arm64')).toBe('macos-aarch64')
    expect(herdrTarget('win32', 'arm64')).toBe('windows-x86_64')
    expect(herdrTarget('freebsd', 'x64')).toBeNull()
  })

  it('installs a verified binary and refuses a tampered one', async () => {
    dir = await mkdtemp(join(tmpdir(), 'herdr-install-'))
    const binary = Buffer.from('#!/bin/sh\necho herdr\n')
    const manifest = (hash: string) => ({ version: '0.9.5', assets: { 'linux-x86_64': 'https://example.test/herdr' }, sha256: { 'linux-x86_64': hash } })
    const installDir = join(dir, 'bin')
    const ok = await installHerdrRelease({ installDir, manifestUrl: 'https://example.test/latest.json', platform: 'linux', arch: 'x64', fetcher: fakeFetch({ 'https://example.test/latest.json': manifest(sha(binary)), 'https://example.test/herdr': binary }) })
    expect(ok).toEqual({ version: '0.9.5', binary: join(installDir, 'herdr') })
    expect(await readFile(ok.binary)).toEqual(binary)
    expect((await stat(ok.binary)).mode & 0o111).not.toBe(0)

    const bad = installHerdrRelease({ installDir: join(dir, 'bin2'), manifestUrl: 'https://example.test/latest.json', platform: 'linux', arch: 'x64', fetcher: fakeFetch({ 'https://example.test/latest.json': manifest('0'.repeat(64)), 'https://example.test/herdr': binary }) })
    await expect(bad).rejects.toThrow(/checksum/)
    await expect(stat(join(dir, 'bin2', 'herdr'))).rejects.toThrow()
  })

  it('extracts the Windows archive and rejects unsafe paths', async () => {
    dir = await mkdtemp(join(tmpdir(), 'herdr-install-'))
    const zip = new AdmZip()
    zip.addFile('herdr-windows-x86_64/herdr.exe', Buffer.from('exe'))
    zip.addFile('herdr-windows-x86_64/conpty.dll', Buffer.from('dll'))
    const archive = zip.toBuffer()
    const files = { 'https://example.test/latest.json': { version: '1.0.0', assets: { 'windows-x86_64': 'https://example.test/herdr.zip' }, sha256: { 'windows-x86_64': sha(archive) } }, 'https://example.test/herdr.zip': archive }
    const result = await installHerdrRelease({ installDir: join(dir, 'bin'), manifestUrl: 'https://example.test/latest.json', platform: 'win32', arch: 'x64', fetcher: fakeFetch(files) })
    expect(result.binary).toBe(join(dir, 'bin', 'herdr-windows-x86_64', 'herdr.exe'))
    expect(await readFile(join(dir, 'bin', 'herdr-windows-x86_64', 'conpty.dll'), 'utf8')).toBe('dll')
  })
})

describe('Studio keybinding in herdr', () => {
  it('knows herdr already uses prefix+s for Settings', () => {
    const used = boundKeys(DEFAULT_CONFIG, true)
    expect(used.has('prefix+s')).toBe(true)
    expect(used.has('prefix+shift+r')).toBe(true)
    expect(used.has(normalizeKey('prefix+S'))).toBe(false)
  })

  it('picks the first free key, skipping the user’s own bindings', () => {
    expect(chooseStudioKey(DEFAULT_CONFIG, '')).toBe('prefix+shift+s')
    const userConfig = '[[keys.command]]\nkey = "prefix+S"\ntype = "popup"\ncommand = "lazygit"\n'
    expect(chooseStudioKey(DEFAULT_CONFIG, userConfig)).toBe('prefix+alt+s')
    // Commented-out lines in the user's own config are not active bindings.
    expect(chooseStudioKey(DEFAULT_CONFIG, '# [[keys.command]]\n# key = "prefix+shift+s"\n')).toBe('prefix+shift+s')
  })

  it('recognizes its own binding so setup is idempotent', () => {
    const config = `[ui]\nsidebar = true\n${renderStudioBinding('prefix+shift+s')}`
    expect(existingStudioKey(config)).toBe('prefix+shift+s')
  })

  it('resolves the config file like herdr does', () => {
    expect(herdrConfigPath({ HERDR_CONFIG_PATH: '/x/c.toml' }, 'linux')).toBe('/x/c.toml')
    expect(herdrConfigPath({ XDG_CONFIG_HOME: '/xdg', HOME: '/h' }, 'linux')).toBe(join('/xdg', 'herdr', 'config.toml'))
    expect(herdrConfigPath({ HOME: '/h' }, 'darwin')).toBe(join('/h', '.config', 'herdr', 'config.toml'))
    expect(herdrConfigPath({ APPDATA: 'C:/Users/a/AppData/Roaming', HOME: '/h' }, 'win32')).toBe(join('C:/Users/a/AppData/Roaming', 'herdr', 'config.toml'))
  })
})

describe('herdr keys for Studio buttons', () => {
  it('uses herdr defaults and the user\'s [keys] overrides', async () => {
    const { herdrKeys } = await import('../../packages/server/src/modules/coding-agents/services/herdr/keybind')
    expect(herdrKeys('')).toEqual({ prefix: 'ctrl+b', search: 'prefix+g', workspaces: 'prefix+w', settings: 'prefix+s', help: 'prefix+?', sidebar: 'prefix+b' })
    const user = '[ui]\nsettings = "nope"\n\n[keys]\nprefix = "ctrl+a"  # screen habits\ngoto = "prefix+/"\n# settings = "prefix+x"\n\n[[keys.command]]\nkey = "prefix+shift+s"\n'
    expect(herdrKeys(user)).toEqual({ prefix: 'ctrl+a', search: 'prefix+/', workspaces: 'prefix+w', settings: 'prefix+s', help: 'prefix+?', sidebar: 'prefix+b' })
  })
})
