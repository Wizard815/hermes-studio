import { execFile } from 'node:child_process'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

// A slow or broken MCP server (rea's npx that cannot download) used to hold every new
// Hermes chat for Hermes's 60 s connect timeout. The bridge now waits a bounded time.
it('starts a Hermes chat without waiting for a slow MCP server', async () => {
  const { stdout } = await promisify(execFile)(process.platform === 'win32' ? 'python' : 'python3', ['-B', resolve('tests/server/fixtures/hermes-bridge-mcp-wait.py')], {
    cwd: resolve('.'), timeout: 25_000, maxBuffer: 1024 * 1024, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  })
  expect(stdout).toContain('Hermes bridge bounded MCP discovery verified')
}, 30_000)
