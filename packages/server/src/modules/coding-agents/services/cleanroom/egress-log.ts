import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * A clean room's egress log: one JSON line per connection the room tried to
 * open to the outside (through its allowlist proxy). Each line carries the
 * hash of the line before it, so a removed or edited line breaks the chain.
 */
export interface EgressEntry {
  time: string
  host: string
  port: number
  allowed: boolean
  /** Why it was refused, or that the allowed host could not be reached. */
  reason?: string
  /** sha256 of the previous line's hash and this entry. */
  prev?: string
  hash?: string
}

/** A log grows to this size, then moves to `<file>.1` (one old file is kept). */
export const EGRESS_LOG_MAX_BYTES = 2 * 1024 * 1024
const GENESIS = '0'.repeat(64)

const lastHash = new Map<string, string>()

function entryHash(prev: string, entry: EgressEntry): string {
  const { prev: _prev, hash: _hash, ...body } = entry
  return createHash('sha256').update(prev).update(JSON.stringify(body)).digest('hex')
}

function readLines(file: string): string[] {
  try { return readFileSync(file, 'utf8').split('\n').filter(Boolean) } catch { return [] }
}

function previousHash(file: string): string {
  const cached = lastHash.get(file)
  if (cached) return cached
  const lines = readLines(file)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try { const hash = (JSON.parse(lines[index]) as EgressEntry).hash; if (hash) return hash } catch { /* skip a broken line */ }
  }
  return GENESIS
}

/** Append one attempt; `chain` adds the hash link (the audit chain). */
export function appendEgress(file: string, entry: Omit<EgressEntry, 'time' | 'prev' | 'hash'> & { time?: string }, options: { chain?: boolean; maxBytes?: number } = {}): EgressEntry {
  mkdirSync(dirname(file), { recursive: true })
  try {
    if (existsSync(file) && statSync(file).size > (options.maxBytes ?? EGRESS_LOG_MAX_BYTES)) renameSync(file, `${file}.1`)
  } catch { /* keep appending to the same file */ }
  const line: EgressEntry = { time: entry.time || new Date().toISOString(), host: entry.host, port: entry.port, allowed: entry.allowed, ...(entry.reason ? { reason: entry.reason } : {}) }
  if (options.chain !== false) {
    // The chain goes on across a rotation: the first line of the new file links to the old file's last line.
    line.prev = previousHash(file)
    line.hash = entryHash(line.prev, line)
    lastHash.set(file, line.hash)
  }
  appendFileSync(file, `${JSON.stringify(line)}\n`, { mode: 0o600 })
  return line
}

/** The newest entries (newest last), at most `limit`. */
export function readEgress(file: string, limit = 200): EgressEntry[] {
  const lines = readLines(file)
  const out: EgressEntry[] = []
  for (const line of lines.slice(-Math.max(1, Math.min(limit, 5000)))) {
    try { out.push(JSON.parse(line) as EgressEntry) } catch { /* skip */ }
  }
  return out
}

/**
 * Check the hash chain of a log file. `ok` is false at the first line whose
 * link or hash does not match (its 1-based line number is `brokenAt`).
 * Lines without a hash (written with the chain off) are counted as unchained.
 */
export function verifyEgressChain(file: string): { ok: boolean; lines: number; chained: number; brokenAt?: number } {
  const lines = readLines(file)
  let prev = ''
  let chained = 0
  for (let index = 0; index < lines.length; index += 1) {
    let entry: EgressEntry
    try { entry = JSON.parse(lines[index]) as EgressEntry } catch { return { ok: false, lines: lines.length, chained, brokenAt: index + 1 } }
    if (!entry.hash) { prev = ''; continue }
    // The first chained line links to whatever came before (a rotated file); after that each line links to the last.
    if ((prev && entry.prev !== prev) || entryHash(entry.prev || '', entry) !== entry.hash) return { ok: false, lines: lines.length, chained, brokenAt: index + 1 }
    prev = entry.hash
    chained += 1
  }
  return { ok: true, lines: lines.length, chained }
}

/** Forget cached chain heads (a room's log was deleted). */
export function forgetEgressLog(file: string): void {
  lastHash.delete(file)
}
