import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Required env names a plugin manifest lists (strings or {name: ...}). */
export function requiredEnvNames(requiresEnv: Array<string | Record<string, unknown>> | undefined): string[] {
  return (requiresEnv || [])
    .map(item => typeof item === 'string' ? item : String((item as any)?.name || ''))
    .map(name => name.trim())
    .filter(Boolean)
}

function parseEnvFile(text: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    let value = trimmed.slice(eq + 1).trim()
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.endsWith(value[0])) value = value.slice(1, -1)
    env[trimmed.slice(0, eq).replace(/^export\s+/, '').trim()] = value
  }
  return env
}

/** Which of `names` are set neither in the profile's .env nor in Studio's environment. */
export function missingEnvFor(profileDir: string, names: string[], env: NodeJS.ProcessEnv = process.env): string[] {
  if (!names.length) return []
  const file = join(profileDir, '.env')
  let saved: Record<string, string> = {}
  try { if (existsSync(file)) saved = parseEnvFile(readFileSync(file, 'utf-8')) } catch { /* unreadable: treat as unset */ }
  return names.filter(name => !String(saved[name] || env[name] || '').trim())
}
