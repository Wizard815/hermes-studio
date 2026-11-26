import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ensureHomeAssistantSshKey } from '../../packages/server/src/modules/hermes/services/home-assistant/ssh-key'

describe("Studio's SSH key for Home Assistant's SSH add-on", () => {
  const dirs: string[] = []
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

  it('makes the key once in <profile>/ssh and returns only the public line', async () => {
    const profile = mkdtempSync(join(tmpdir(), 'ha-key-'))
    dirs.push(profile)
    const first = await ensureHomeAssistantSshKey(profile)
    expect(first.created).toBe(true)
    expect(first.keyPath).toBe(join(profile, 'ssh', 'ha_builder_ed25519'))
    expect(first.publicKey).toMatch(/^ssh-ed25519 \S+ hermes-studio-home-assistant$/)
    expect(statSync(first.keyPath).mode & 0o077).toBe(0)
    expect(first.publicKey).not.toContain('PRIVATE')
    const again = await ensureHomeAssistantSshKey(profile)
    expect(again).toEqual({ ...first, created: false })
    expect(readFileSync(`${first.keyPath}.pub`, 'utf8').trim()).toBe(first.publicKey)
  })
})
