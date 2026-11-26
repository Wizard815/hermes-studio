import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import YAML from 'js-yaml'

let base = ''
vi.mock('../../packages/server/src/modules/hermes/services/profiles/profile', async (orig) => ({
  ...(await orig<any>()),
  getProfileDir: (name: string) => (!name || name === 'default' ? base : join(base, 'profiles', name)),
  listProfileNamesFromDisk: () => ['default', 'work', 'empty'],
}))
vi.mock('../../packages/server/src/modules/hermes/services/profiles/config', async (orig) => {
  const { safeFileStore } = await import('../../packages/server/src/modules/studio/public/safe-file-store')
  return {
    ...(await orig<any>()),
    updateConfigYamlForProfile: (profile: string, updater: any) =>
      safeFileStore.updateYaml(join(profile === 'default' ? base : join(base, 'profiles', profile), 'config.yaml'), updater),
  }
})

import { applyJobPostDefaults, applyJobPostDefaultsToAllProfiles } from '../../packages/server/src/modules/hermes/services/cron/job-post-defaults'

const read = (dir: string) => YAML.load(readFileSync(join(dir, 'config.yaml'), 'utf8')) as any

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'cron-defaults-'))
  mkdirSync(join(base, 'profiles', 'work'), { recursive: true })
  mkdirSync(join(base, 'profiles', 'empty'), { recursive: true })
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

describe('job post defaults', () => {
  it('turns the Hermes header/footer off when nothing is set, keeping other cron settings', async () => {
    writeFileSync(join(base, 'config.yaml'), 'model:\n  default: x\ncron:\n  max_parallel: 2\n')
    expect(await applyJobPostDefaults('default')).toBe(true)
    const cfg = read(base)
    expect(cfg.cron).toEqual({ max_parallel: 2, wrap_response: false })
    expect(cfg.model.default).toBe('x')
  })

  it('keeps a choice already made, on or off', async () => {
    writeFileSync(join(base, 'config.yaml'), 'cron:\n  wrap_response: true\n')
    expect(await applyJobPostDefaults('default')).toBe(false)
    expect(read(base).cron.wrap_response).toBe(true)
  })

  it('does not create a config for a profile that has none, and covers every profile', async () => {
    writeFileSync(join(base, 'config.yaml'), '{}\n')
    writeFileSync(join(base, 'profiles', 'work', 'config.yaml'), 'cron: null\n')
    await applyJobPostDefaultsToAllProfiles()
    expect(read(base).cron.wrap_response).toBe(false)
    expect(read(join(base, 'profiles', 'work')).cron.wrap_response).toBe(false)
    expect(() => readFileSync(join(base, 'profiles', 'empty', 'config.yaml'))).toThrow()
  })
})
