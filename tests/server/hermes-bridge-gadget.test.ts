import { execFile } from 'node:child_process'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

// Studio's Hermes chats run in the bridge, not the gateway that holds the gadget hub:
// gadget_display / gadget_action / gadget_devices go through the plugin's desk folder.
it('lets Studio Hermes chats use gadget_display, gadget_action and gadget_devices', async () => {
  const { stdout } = await promisify(execFile)(process.platform === 'win32' ? 'python' : 'python3', ['-B', resolve('tests/server/fixtures/hermes-bridge-gadget.py')], {
    cwd: resolve('.'), timeout: 25_000, maxBuffer: 1024 * 1024, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  })
  expect(stdout).toContain('Hermes bridge Gadget tools verified')
}, 30_000)
