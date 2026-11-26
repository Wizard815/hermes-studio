import { readdir, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { isCredentialFile } from './guard'
import { isHermesStateDb } from './parse-hermes'
import type { ChatImportKind } from './types'

export interface SourceFile {
  kind: ChatImportKind
  path: string
  /** Hermes: the profile the state.db belongs to. */
  profile?: string
  /** The agent home the file was found in (`~/.claude`, `~/.codex`, a Hermes home…). */
  home: string
}

/** Folder names that hold another agent's data, looked for inside the chosen folder. */
const KNOWN_HOMES = ['.hermes', '.claude', '.codex', '.openclaw', '.clawdbot', '.moltbot', 'hermes', 'claude', 'codex', 'openclaw']
const SKIP_DIRS = new Set(['node_modules', '.git', '__pycache__', 'cache', 'image_cache', 'audio_cache', 'logs'])

async function dirs(path: string): Promise<string[]> {
  try {
    return (await readdir(path, { withFileTypes: true })).filter(entry => entry.isDirectory() && !entry.isSymbolicLink()).map(entry => entry.name)
  } catch {
    return []
  }
}

async function files(path: string, match: (name: string) => boolean): Promise<string[]> {
  try {
    return (await readdir(path, { withFileTypes: true }))
      .filter(entry => entry.isFile() && !isCredentialFile(entry.name) && match(entry.name))
      .map(entry => join(path, entry.name))
  } catch {
    return []
  }
}

async function isFile(path: string): Promise<boolean> {
  try { return (await stat(path)).isFile() } catch { return false }
}

const jsonl = (name: string) => name.endsWith('.jsonl')

async function hermesFiles(home: string): Promise<SourceFile[]> {
  const found: SourceFile[] = []
  const own = join(home, 'state.db')
  if (await isFile(own) && await isHermesStateDb(own)) found.push({ kind: 'hermes', path: own, profile: 'default', home })
  for (const name of await dirs(join(home, 'profiles'))) {
    const db = join(home, 'profiles', name, 'state.db')
    if (await isFile(db) && await isHermesStateDb(db)) found.push({ kind: 'hermes', path: db, profile: name, home })
  }
  return found
}

async function claudeFiles(home: string, limit: number): Promise<SourceFile[]> {
  const projects = basename(home) === 'projects' ? home : join(home, 'projects')
  const found: SourceFile[] = []
  for (const project of await dirs(projects)) {
    for (const path of await files(join(projects, project), jsonl)) {
      found.push({ kind: 'claude-code', path, home })
      if (found.length >= limit) return found
    }
  }
  return found
}

async function codexFiles(home: string, limit: number): Promise<SourceFile[]> {
  const found: SourceFile[] = []
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth < 0 || found.length >= limit) return
    for (const path of await files(dir, name => name.startsWith('rollout-') && jsonl(name))) {
      if (found.length >= limit) return
      found.push({ kind: 'codex', path, home })
    }
    for (const name of await dirs(dir)) await walk(join(dir, name), depth - 1)
  }
  for (const folder of ['sessions', 'archived_sessions']) await walk(join(home, folder), 4)
  return found
}

async function openClawFiles(home: string, limit: number): Promise<SourceFile[]> {
  const found: SourceFile[] = []
  for (const agent of await dirs(join(home, 'agents'))) {
    for (const path of await files(join(home, 'agents', agent, 'sessions'), jsonl)) {
      found.push({ kind: 'openclaw', path, home })
      if (found.length >= limit) return found
    }
  }
  return found
}

/**
 * Find chat sources under a folder: the folder itself, the agent homes inside
 * it (`.hermes`, `.claude`, `.codex`, `.openclaw`) and, for an unpacked upload
 * (`deep`), any folder up to three levels down. Only session files are listed;
 * credential files are never opened.
 */
export async function discoverSources(root: string, options: { deep: boolean; limit: number }): Promise<SourceFile[]> {
  if (await isFile(root)) {
    if (basename(root) === 'state.db' || root.endsWith('.db')) return await isHermesStateDb(root) ? [{ kind: 'hermes', path: root, profile: 'default', home: root }] : []
    return []
  }
  const found: SourceFile[] = []
  const seen = new Set<string>()
  const visit = async (dir: string, depth: number): Promise<void> => {
    if (seen.has(dir) || found.length >= options.limit) return
    seen.add(dir)
    const left = () => options.limit - found.length
    const before = found.length
    const names = new Set(await dirs(dir))
    if (names.has('profiles') || await isFile(join(dir, 'state.db'))) found.push(...await hermesFiles(dir))
    if (names.has('projects')) found.push(...await claudeFiles(dir, left()))
    else if (basename(dir) === 'projects') found.push(...await claudeFiles(dir, left()))
    if (names.has('sessions') || names.has('archived_sessions')) found.push(...await codexFiles(dir, left()))
    if (names.has('agents')) found.push(...await openClawFiles(dir, left()))
    const kinds = found.length > before
    if (kinds || depth <= 0) return
    for (const name of await dirs(dir)) {
      if (SKIP_DIRS.has(name)) continue
      if (!options.deep && !KNOWN_HOMES.includes(name)) continue
      await visit(join(dir, name), depth - 1)
    }
  }
  await visit(root, options.deep ? 3 : 1)
  return found.slice(0, options.limit)
}
