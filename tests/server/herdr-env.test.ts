import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { herdrEnv } from '../../packages/server/src/modules/coding-agents/services/herdr/runtime'

const originalPath = process.env.PATH
const originalNvmDir = process.env.NVM_DIR
const fakeNvm = join(tmpdir(), `herdr-env-nvm-${process.pid}`)

afterEach(() => {
  process.env.PATH = originalPath
  if (originalNvmDir === undefined) delete process.env.NVM_DIR
  else process.env.NVM_DIR = originalNvmDir
  rmSync(fakeNvm, { recursive: true, force: true })
})

describe('herdrEnv', () => {
  it("puts Studio's node bin directory on herdr's PATH", () => {
    process.env.NVM_DIR = join(fakeNvm, 'missing')
    process.env.PATH = ['/usr/local/bin', '/usr/bin'].join(delimiter)
    const env = herdrEnv()
    expect(env.PATH!.split(delimiter)[0]).toBe(dirname(process.execPath))
    expect(env.PATH).toContain('/usr/bin')
  })

  it('adds every nvm node version bin, newest first', () => {
    for (const version of ['v23.11.1', 'v24.21.0']) mkdirSync(join(fakeNvm, 'versions', 'node', version, 'bin'), { recursive: true })
    process.env.NVM_DIR = fakeNvm
    process.env.PATH = '/usr/bin'
    const entries = herdrEnv().PATH!.split(delimiter)
    const v24 = entries.indexOf(join(fakeNvm, 'versions', 'node', 'v24.21.0', 'bin'))
    const v23 = entries.indexOf(join(fakeNvm, 'versions', 'node', 'v23.11.1', 'bin'))
    expect(v24).toBeGreaterThan(-1)
    expect(v23).toBeGreaterThan(v24)
  })

  it('leaves PATH alone when every directory is already on it', () => {
    process.env.NVM_DIR = join(fakeNvm, 'missing')
    process.env.PATH = [dirname(process.execPath), '/usr/bin'].join(delimiter)
    expect(herdrEnv()).toBe(process.env)
  })

  it('handles an empty PATH', () => {
    process.env.NVM_DIR = join(fakeNvm, 'missing')
    process.env.PATH = ''
    expect(herdrEnv().PATH).toBe(dirname(process.execPath))
  })
})
