import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { createInterface } from 'node:readline'
import { ChatImportError } from './types'

/**
 * Credential stores the importer must never open or copy, wherever they are
 * (the same list as Hermes' agent-importers plus common key files).
 */
const CREDENTIAL_NAMES = new Set([
  '.env', 'auth.json', 'auth.lock', '.credentials.json', 'credentials.json', 'credentials', 'cli-config.json',
  'oauth.json', 'tokens.json', 'token.json', 'secrets.json', 'keychain', 'auth-profiles.json', '.netrc', '.npmrc', '.pypirc',
])
const CREDENTIAL_EXTENSIONS = ['.pem', '.key', '.p12', '.pfx', '.keychain', '.keychain-db', '.kdbx']

export function isCredentialFile(path: string): boolean {
  const name = basename(path.replace(/\\/g, '/')).toLowerCase()
  if (CREDENTIAL_NAMES.has(name)) return true
  if (name.startsWith('.env.') || name.endsWith('.env')) return true
  if (name.startsWith('id_rsa') || name.startsWith('id_ed25519') || name.startsWith('id_ecdsa')) return true
  return CREDENTIAL_EXTENSIONS.some(ext => name.endsWith(ext))
}

/** Files a source may hold that the importer reads. Everything else is left alone. */
export function isChatSourceFile(path: string): boolean {
  if (isCredentialFile(path)) return false
  const name = basename(path.replace(/\\/g, '/'))
  return name === 'state.db' || name === 'state.db-wal' || name === 'state.db-shm' || name.endsWith('.jsonl')
}

function assertReadable(path: string): void {
  if (isCredentialFile(path)) throw new ChatImportError('Credential files are never read', 400, 'chat_import_credential')
}

/** Stream a JSONL file line by line, refusing credential files and files over the size cap. */
export async function* readJsonl(path: string, maxBytes: number): AsyncGenerator<any> {
  assertReadable(path)
  const info = await stat(path)
  if (!info.isFile()) return
  if (info.size > maxBytes) throw new ChatImportError('File is too large to import', 413, 'chat_import_too_large')
  const lines = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try { yield JSON.parse(trimmed) } catch { /* partial or foreign line */ }
    }
  } finally {
    lines.close()
  }
}

export function checkedSourcePath(path: string): string {
  assertReadable(path)
  return path
}
