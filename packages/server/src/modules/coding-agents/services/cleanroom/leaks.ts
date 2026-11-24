import { lstatSync, openSync, readSync, closeSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'

/**
 * Leak check: before a clean room mounts a chat's folder, look for files that
 * usually hold secrets (the agent may read everything in the folder). Only
 * names are reported, never contents; Studio warns and still mounts.
 */
export interface LeakFinding {
  /** Path relative to the chat's folder. */
  path: string
  /** What kind of secret the name (or, for .npmrc-like files, a token line) suggests. */
  kind: 'env' | 'ssh-key' | 'private-key' | 'credentials' | 'token-config' | 'keystore'
}

export interface LeakReport {
  at: string
  workspace: string
  findings: LeakFinding[]
  /** The scan stopped early (too many files); there may be more. */
  truncated: boolean
  scanned: number
}

const SKIP_DIRS = new Set(['node_modules', '.git', '.hg', '.svn', '.venv', 'venv', '__pycache__', '.next', '.nuxt', 'dist', 'build', 'target', '.cache', '.gradle', '.terraform'])
const ENV_SAFE = /\.(example|sample|template|dist|defaults?)$/i
const SSH_KEY = /^id_(rsa|dsa|ecdsa|ed25519)(_sk)?$/
const PRIVATE_KEY_EXT = /\.(pem|key|p8|ppk)$/i
const KEYSTORE_EXT = /\.(p12|pfx|jks|keystore|kdbx)$/i
const CREDENTIAL_NAMES = new Set(['credentials.json', 'credentials', '.git-credentials', '.netrc', '_netrc', '.pgpass', 'secrets.json', 'secrets.yaml', 'secrets.yml', 'client_secret.json', 'service-account.json', '.htpasswd'])
const TOKEN_CONFIGS = new Set(['.npmrc', '.yarnrc.yml', '.pypirc', 'config.json'])
/** A token line in .npmrc, .yarnrc.yml, .pypirc or a docker config.json. */
const TOKEN_LINE = /(_authToken|_auth\b|_password|npmAuthToken|password\s*[:=]|"auth"\s*:\s*"[^"]+")/

function head(file: string, bytes = 16 * 1024): string {
  let fd = -1
  try {
    fd = openSync(file, 'r')
    const buffer = Buffer.alloc(bytes)
    const read = readSync(fd, buffer, 0, bytes, 0)
    return buffer.subarray(0, read).toString('utf8')
  } catch { return '' } finally { if (fd >= 0) try { closeSync(fd) } catch { /* ignore */ } }
}

/** What a file name says about its contents (null: nothing that looks secret). */
export function classifyLeak(name: string, parent: string, readHead: () => string): LeakFinding['kind'] | null {
  const lower = name.toLowerCase()
  if ((lower === '.env' || lower.startsWith('.env.') || lower.endsWith('.env')) && !ENV_SAFE.test(lower)) return 'env'
  if (SSH_KEY.test(name)) return 'ssh-key'
  if (PRIVATE_KEY_EXT.test(lower)) return 'private-key'
  if (KEYSTORE_EXT.test(lower)) return 'keystore'
  if (CREDENTIAL_NAMES.has(lower) || /^service[-_]account.*\.json$/.test(lower)) {
    // "credentials" without an extension is only interesting in a cloud tool folder (.aws, .docker, ...).
    if (lower === 'credentials' && !/^\.(aws|gem|config)$/.test(parent)) return null
    return 'credentials'
  }
  if (TOKEN_CONFIGS.has(lower)) {
    if (lower === 'config.json' && parent !== '.docker') return null
    return TOKEN_LINE.test(readHead()) ? 'token-config' : null
  }
  return null
}

/** Scan a chat's folder (a few levels deep, skipping dependency/build folders). */
export function scanForLeaks(workspace: string, options: { maxDepth?: number; maxEntries?: number } = {}): LeakReport {
  const maxDepth = options.maxDepth ?? 4
  const maxEntries = options.maxEntries ?? 20000
  const findings: LeakFinding[] = []
  let scanned = 0
  let truncated = false
  const walk = (dir: string, depth: number) => {
    if (truncated) return
    let entries: import('node:fs').Dirent[]
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    const parent = dir === workspace ? '' : dir.split('/').pop() || ''
    for (const entry of entries) {
      if (++scanned > maxEntries) { truncated = true; return }
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (depth < maxDepth && !SKIP_DIRS.has(entry.name)) walk(path, depth + 1)
        continue
      }
      // Links can point anywhere on the host; their names still count, their targets are not read.
      if (!entry.isFile() && !entry.isSymbolicLink()) continue
      const kind = classifyLeak(entry.name, parent, () => {
        try { return lstatSync(path).isFile() ? head(path) : '' } catch { return '' }
      })
      if (kind) findings.push({ path: relative(workspace, path), kind })
      if (findings.length >= 200) { truncated = true; return }
    }
  }
  walk(workspace, 0)
  return { at: new Date().toISOString(), workspace, findings, truncated, scanned: Math.min(scanned, maxEntries) }
}
