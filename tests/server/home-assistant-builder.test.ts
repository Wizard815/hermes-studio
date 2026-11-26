import { execFile, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// The home-assistant-builder skill's tool against a stand-in for Home Assistant OS's SSH add-on:
// `ssh` runs the command here, `ha` answers `ha core check` like the Supervisor CLI, and a small
// HTTP server plays Home Assistant's API.
const SCRIPT = resolve(__dirname, '../../packages/skills/home-assistant-builder/scripts/ha_build.py')
const python = process.env.PYTHON || 'python3'
const hasPython = spawnSync(python, ['--version']).status === 0

let root: string
let bin: string
let server: Server
let url: string
const calls: string[] = []
const scripts = new Set<string>()
let checkOk = true

function sh(path: string, body: string) {
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'ha-build-'))
  bin = join(root, 'bin')
  mkdirSync(bin)
  // ssh [options] user@host sh -c '<script>': run the script here, as the add-on would.
  sh(join(bin, 'ssh'), 'while [ "$1" != "sh" ]; do shift; done; shift; shift; eval "exec sh -c $1"')
  sh(join(bin, 'ha'), `[ "$SUPERVISOR_TOKEN" = "sup" ] || { echo '{"result":"error","message":"Unauthorized"}'; exit 1; }
if [ -f "${root}/check-fails" ]; then echo '{"result":"error","message":"Invalid config for script"}'; exit 1; fi
echo '{"result":"ok","data":{}}'`)
  server = createServer((req, res) => {
    calls.push(`${req.method} ${req.url}`)
    res.setHeader('Content-Type', 'application/json')
    const state = /^\/api\/states\/(script\.\w+)$/.exec(req.url || '')
    if (state) {
      res.statusCode = scripts.has(state[1]) ? 200 : 404
      res.end(JSON.stringify({ entity_id: state[1] }))
      return
    }
    if (req.url === '/api/config/core/check_config') res.end(JSON.stringify({ result: checkOk ? 'valid' : 'invalid', errors: checkOk ? null : 'bad' }))
    else if (req.url === '/api/') res.end(JSON.stringify({ message: 'API running.' }))
    else res.end('[]')
  })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(() => {
  server?.close()
  if (root) rmSync(root, { recursive: true, force: true })
})

function run(configDir: string, ...args: string[]): Promise<{ code: number; out: string }> {
  return new Promise(done => {
    execFile(python, [SCRIPT, ...args], {
      env: {
        PATH: `${bin}:${process.env.PATH}`, HERMES_HOME: join(root, 'no-hermes'), SUPERVISOR_TOKEN: 'sup',
        HA_BUILD_URL: url, HA_BUILD_TOKEN: 'tok', HA_BUILD_SSH_HOST: 'homeassistant.local', HA_BUILD_CONFIG_DIR: configDir,
      },
    }, (err, stdout, stderr) => done({ code: err ? (err as any).code ?? 1 : 0, out: stdout + stderr }))
  })
}

function config(name: string, text: string) {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'configuration.yaml'), text)
  return dir
}

const PACKAGE = 'script:\n  hermes_porch:\n    alias: "Porch (Hermes)"\n    sequence:\n      - action: light.turn_on\n        target: { entity_id: light.porch }\n'

describe.skipIf(!hasPython)('home-assistant-builder on Home Assistant OS', () => {
  it('without packages, tells the user the one line to add and never edits configuration.yaml', async () => {
    const bare = config('bare', 'default_config:\n')
    const status = await run(bare, 'status')
    expect(status.out).toContain('Packages: NOT READY')
    expect(status.out).toContain('homeassistant:\n  packages: !include_dir_named packages')
    expect(status.out).toContain('`ha core check`')

    const withCore = config('core', 'homeassistant:\n  name: Home\ndefault_config:\n')
    const setup = await run(withCore, 'setup')
    expect(setup.code).toBe(2)
    expect(setup.out).toContain('under the homeassistant: section that is already there')
    expect(setup.out).toMatch(/\npackages: !include_dir_named packages\n/)

    writeFileSync(join(root, 'p.yaml'), PACKAGE)
    const code = /CONFIRM=(\w+)/.exec((await run(bare, 'show', join(root, 'p.yaml'))).out)![1]
    const deploy = await run(bare, 'deploy', join(root, 'p.yaml'), '--name', 'porch', '--confirm', code)
    expect(deploy.code).toBe(2)
    expect(readFileSync(join(bare, 'configuration.yaml'), 'utf8')).toBe('default_config:\n')
    expect(existsSync(join(bare, 'packages'))).toBe(false)
  })

  it('deploys into packages/hermes, checks with `ha core check`, reloads, and says when Home Assistant did not load it', async () => {
    const dir = config('ready', 'homeassistant:\n  packages: !include_dir_named packages\n')
    writeFileSync(join(root, 'p.yaml'), PACKAGE)
    const code = /CONFIRM=(\w+)/.exec((await run(dir, 'show', join(root, 'p.yaml'))).out)![1]
    calls.length = 0
    let deploy = await run(dir, 'deploy', join(root, 'p.yaml'), '--name', 'porch', '--confirm', code)
    expect(deploy.code).toBe(0)
    expect(readFileSync(join(dir, 'packages/hermes/porch.yaml'), 'utf8')).toBe(PACKAGE)
    expect(calls).not.toContain('POST /api/config/core/check_config')
    expect(calls).toContain('POST /api/services/script/reload')
    expect(deploy.out).toContain('did not load script.hermes_porch')

    scripts.add('script.hermes_porch')
    deploy = await run(dir, 'deploy', join(root, 'p.yaml'), '--name', 'porch', '--confirm', code)
    expect(deploy.out).toContain('config check passed')
    expect(deploy.out).not.toContain('WARNING')

    writeFileSync(join(root, 'check-fails'), '')
    const broken = PACKAGE.replace('Porch', 'Broken')
    writeFileSync(join(root, 'b.yaml'), broken)
    const code2 = /CONFIRM=(\w+)/.exec((await run(dir, 'show', join(root, 'b.yaml'))).out)![1]
    deploy = await run(dir, 'deploy', join(root, 'b.yaml'), '--name', 'porch', '--confirm', code2)
    rmSync(join(root, 'check-fails'))
    expect(deploy.code).toBe(1)
    expect(deploy.out).toContain('Invalid config for script')
    expect(readFileSync(join(dir, 'packages/hermes/porch.yaml'), 'utf8')).toBe(PACKAGE)
  })

  it('uses a packages folder that is already there, and refuses ones it cannot add to', async () => {
    const custom = config('custom', 'homeassistant:\n  packages: !include_dir_named my_packages  # mine\n')
    expect((await run(custom, 'status')).out).toContain(`Hermes's files go in ${custom}/my_packages/hermes`)
    const merged = config('merged', 'homeassistant:\n  packages: !include_dir_merge_named packages\n')
    expect((await run(merged, 'status')).out).toContain('Packages: NOT READY')
  })
})
