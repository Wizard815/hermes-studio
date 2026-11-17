import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface HomeAssistantSshKey {
  /** Private key file Hermes's home-assistant-builder uses (HA_BUILD_SSH_KEY). */
  keyPath: string
  /** One line for the SSH add-on's authorized_keys option. */
  publicKey: string
  created: boolean
}

export const HA_SSH_KEY_NAME = 'ha_builder_ed25519'
const COMMENT = 'hermes-studio-home-assistant'

const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b }
const sshString = (value: Buffer | string) => { const b = Buffer.from(value); return Buffer.concat([u32(b.length), b]) }

/**
 * A new ed25519 key pair in OpenSSH's own formats (what ssh-keygen writes), made with Node's
 * crypto so no ssh-keygen is needed on the Studio machine.
 */
export function newOpenSshEd25519(comment = COMMENT): { privateKey: string; publicKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const pub = Buffer.from(publicKey.export({ format: 'jwk' }).x as string, 'base64url')
  const seed = Buffer.from(privateKey.export({ format: 'jwk' }).d as string, 'base64url')
  const blob = Buffer.concat([sshString('ssh-ed25519'), sshString(pub)])
  const check = randomBytes(4)
  let section = Buffer.concat([check, check, sshString('ssh-ed25519'), sshString(pub), sshString(Buffer.concat([seed, pub])), sshString(comment)])
  const pad: number[] = []
  for (let i = 1; (section.length + pad.length) % 8 !== 0; i++) pad.push(i)
  section = Buffer.concat([section, Buffer.from(pad)])
  const body = Buffer.concat([
    Buffer.from('openssh-key-v1\0'), sshString('none'), sshString('none'), sshString(''), u32(1), sshString(blob), sshString(section),
  ]).toString('base64')
  const lines = body.match(/.{1,70}/g) || []
  return {
    privateKey: `-----BEGIN OPENSSH PRIVATE KEY-----\n${lines.join('\n')}\n-----END OPENSSH PRIVATE KEY-----\n`,
    publicKey: `ssh-ed25519 ${blob.toString('base64')} ${comment}`,
  }
}

/**
 * The key pair Hermes signs in to Home Assistant's SSH add-on with: <profile>/ssh/ha_builder_ed25519,
 * made once (no passphrase, so jobs can use it). The private key never leaves the machine;
 * Studio only shows the public half.
 */
export async function ensureHomeAssistantSshKey(profileDir: string): Promise<HomeAssistantSshKey> {
  const dir = join(profileDir, 'ssh')
  const keyPath = join(dir, HA_SSH_KEY_NAME)
  if (existsSync(keyPath)) {
    const publicKey = (await readFile(`${keyPath}.pub`, 'utf8')).trim()
    return { keyPath, publicKey, created: false }
  }
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const key = newOpenSshEd25519()
  await writeFile(keyPath, key.privateKey, { mode: 0o600, flag: 'wx' })
  await writeFile(`${keyPath}.pub`, key.publicKey + '\n', { mode: 0o644 })
  return { keyPath, publicKey: key.publicKey, created: true }
}
