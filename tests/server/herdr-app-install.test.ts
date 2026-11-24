import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readlink, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/** scripts/install-herdr-app-layout.sh, against a throwaway HOME and a local copy of herdr-space-folders. */
const SCRIPT = resolve('scripts/install-herdr-app-layout.sh')

describe('installing the Space Folders layout into Herdr App', () => {
  let dir: string
  let home: string
  let repo: string
  const env = () => ({ ...process.env, HOME: home, HERDR_SPACE_FOLDERS_REPO: repo, HERDR_APP_CONFIG: '', HERDR_SPACE_FOLDERS_DIR: '', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' })
  const run = (...args: string[]) => execFileSync('bash', [SCRIPT, ...args], { env: Object.fromEntries(Object.entries(env()).filter(([, value]) => value !== '')), encoding: 'utf8' })

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'herdr-app-install-'))
    home = join(dir, 'home')
    repo = join(dir, 'herdr-space-folders')
    await mkdir(join(repo, 'mods', 'space-folders'), { recursive: true })
    await mkdir(join(repo, 'layouts'), { recursive: true })
    await mkdir(home, { recursive: true })
    await writeFile(join(repo, 'mods', 'space-folders', 'mod.json'), '{"place":"none"}\n')
    await writeFile(join(repo, 'layouts', 'main-folders.json'), '{"id":"root"}\n')
    await writeFile(join(repo, 'keys.json'), JSON.stringify({ 'layout:main-folders': { 'alt-down': 'space-folders.next', 'alt-up': 'space-folders.prev' } }))
    execFileSync('git', ['init', '-q'], { cwd: repo })
    execFileSync('git', ['add', '.'], { cwd: repo })
    execFileSync('git', ['commit', '-qm', 'mod'], { cwd: repo, env: env() })
  })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  it('clones the mod, links it, copies the layout and merges the keys, keeping the user\'s own', async () => {
    const config = join(home, '.config', 'herdr-app')
    await mkdir(config, { recursive: true })
    await writeFile(join(config, 'keys.json'), JSON.stringify({ global: { 'ctrl-k': 'palette.open' }, 'layout:main-folders': { 'alt-up': 'mine' } }))
    const out = run()
    const checkout = join(home, '.local', 'share', 'herdr-space-folders')
    expect(await readlink(join(config, 'mods', 'space-folders'))).toBe(join(checkout, 'mods', 'space-folders'))
    expect(await readFile(join(config, 'layouts', 'main-folders.json'), 'utf8')).toBe('{"id":"root"}\n')
    expect(JSON.parse(await readFile(join(config, 'keys.json'), 'utf8'))).toEqual({
      global: { 'ctrl-k': 'palette.open' },
      'layout:main-folders': { 'alt-down': 'space-folders.next', 'alt-up': 'mine' },
    })
    expect(existsSync(join(config, 'keys.json.bak'))).toBe(true)
    expect(out).toContain('herdr-space-folders.json')
    // Again: nothing changes, nothing breaks.
    const again = run()
    expect(again).toContain('Mod already linked')
    expect(again).toContain('Keys already set')
  })

  it('uses a checkout given with --from, and only says what it would do with --dry-run', async () => {
    const out = run('--from', repo, '--dry-run')
    expect(out).toContain('would run: ln -sfn')
    expect(existsSync(join(home, '.config', 'herdr-app', 'layouts', 'main-folders.json'))).toBe(false)
    run('--from', repo)
    expect(await readlink(join(home, '.config', 'herdr-app', 'mods', 'space-folders'))).toBe(join(repo, 'mods', 'space-folders'))
  })
})
