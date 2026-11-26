import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

// Small models call ekko_studio_use_orb_board (or _phone) by name; in Hermes those sit behind
// the use toolset, and three unknown names end the run. The bridge routes them to the toolset.
it('routes Studio catalog tools called by name to their toolset in Hermes chats', async () => {
  const { stdout } = await promisify(execFile)(process.platform === 'win32' ? 'python' : 'python3', ['-B', resolve('tests/server/fixtures/hermes-bridge-studio-toolsets.py')], {
    cwd: resolve('.'), timeout: 25_000, maxBuffer: 1024 * 1024, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  })
  expect(stdout).toContain('Hermes bridge Studio toolsets verified')
}, 30_000)

it('builds each Hermes agent after keeping Studio\'s toolsets out of tool search', () => {
  const pool = readFileSync(resolve('packages/server/src/modules/hermes/services/bridge/python/bridge_pool.py'), 'utf8')
  expect(pool).toMatch(/keep_studio_tools_visible\(\)\n\s+agent = AIAgent\(/)
})
