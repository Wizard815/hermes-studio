import { execFile } from 'node:child_process'
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
