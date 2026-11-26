import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

// hy4-flash ended Studio Hermes turns on "I'll find the Studio phone tool and read the screen." with
// no tool call. Hermes's own bounded re-prompt for that is off by default outside Codex providers.
it("turns Hermes's intent-ack re-prompt on for Studio's chats unless the profile set it", async () => {
  const { stdout } = await promisify(execFile)(process.platform === 'win32' ? 'python' : 'python3', ['-B', resolve('tests/server/fixtures/hermes-bridge-turn-guards.py')], {
    cwd: resolve('.'), timeout: 25_000, maxBuffer: 1024 * 1024, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  })
  expect(stdout).toContain('Hermes bridge turn guards verified')
}, 30_000)

it('applies the guard to every agent the bridge builds', () => {
  const pool = readFileSync(resolve('packages/server/src/modules/hermes/services/bridge/python/bridge_pool.py'), 'utf8')
  const built = pool.split('agent = AIAgent(').length - 1
  expect(built).toBe(1)
  expect(pool).toMatch(/agent = AIAgent\([\s\S]*?\n\s+\)\n[\s\S]{0,600}apply_turn_guards\(agent, cfg\)/)
})
