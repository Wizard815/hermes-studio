import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const SECRET = 'SECRET-DO-NOT-IMPORT-7f3a'
export const CLAUDE_ID = '11111111-2222-3333-4444-555555555555'
export const CODEX_ID = '0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee'

const here = dirname(new URL(import.meta.url).pathname)

function write(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

/** A Hermes state.db with the columns Studio reads: one plain chat, one compressed chain, one empty session. */
export function writeHermesStateDb(path: string, options: { cwd?: string; prefix?: string } = {}) {
  mkdirSync(dirname(path), { recursive: true })
  const p = options.prefix ?? ''
  const db = new DatabaseSync(path)
  db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT NOT NULL, user_id TEXT, model TEXT, parent_session_id TEXT,
    started_at REAL NOT NULL, ended_at REAL, end_reason TEXT, message_count INTEGER DEFAULT 0, title TEXT, cwd TEXT)`)
  db.exec(`CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT,
    tool_call_id TEXT, tool_calls TEXT, tool_name TEXT, timestamp REAL NOT NULL, token_count INTEGER, finish_reason TEXT, reasoning TEXT,
    active INTEGER NOT NULL DEFAULT 1, _compressed_summary INTEGER NOT NULL DEFAULT 0)`)
  const session = db.prepare('INSERT INTO sessions (id, source, model, parent_session_id, started_at, ended_at, end_reason, title, cwd) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
  const message = db.prepare('INSERT INTO messages (session_id, role, content, tool_call_id, tool_calls, tool_name, timestamp, active, _compressed_summary) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
  session.run(`${p}h-plain`, 'cli', 'hermes-4', null, 1767225600, 1767225700, null, 'Plan the garden', options.cwd ?? null)
  message.run(`${p}h-plain`, 'user', 'Help me plan the garden', null, null, null, 1767225601, 1, 0)
  message.run(`${p}h-plain`, 'assistant', '', null, JSON.stringify([{ id: 'c1', type: 'function', function: { name: 'web_search', arguments: '{"q":"tomatoes"}' } }]), null, 1767225602, 1, 0)
  message.run(`${p}h-plain`, 'tool', 'Tomatoes need sun.', 'c1', null, 'web_search', 1767225603, 1, 0)
  message.run(`${p}h-plain`, 'assistant', 'Plant tomatoes where the sun is.', null, null, null, 1767225604, 1, 0)
  message.run(`${p}h-plain`, 'assistant', 'superseded draft', null, null, null, 1767225605, 0, 0)
  session.run(`${p}h-root`, 'telegram', 'hermes-4', null, 1767312000, 1767312100, 'compression', null, null)
  message.run(`${p}h-root`, 'user', 'Write a long story about a fox', null, null, null, 1767312001, 1, 0)
  message.run(`${p}h-root`, 'assistant', 'Chapter one.', null, null, null, 1767312002, 1, 0)
  session.run(`${p}h-cont`, 'telegram', 'hermes-4', `${p}h-root`, 1767312101, 1767312200, null, 'The fox story', null)
  message.run(`${p}h-cont`, 'user', '[summary of earlier turns]', null, null, null, 1767312101, 1, 1)
  message.run(`${p}h-cont`, 'user', 'Continue', null, null, null, 1767312102, 1, 0)
  message.run(`${p}h-cont`, 'assistant', 'Chapter two.', null, null, null, 1767312103, 1, 0)
  session.run(`${p}h-empty`, 'cron', 'hermes-4', null, 1767398400, null, null, null, null)
  db.close()
}

/**
 * A home folder from "another machine": Hermes, Claude Code, Codex and
 * OpenClaw, each next to credential files that must never be read.
 */
export function buildFixtureHome(root: string, cwd: string) {
  const fixture = (name: string) => readFileSync(join(here, name), 'utf8').replaceAll('__CWD__', cwd)
  writeHermesStateDb(join(root, '.hermes', 'state.db'), { cwd })
  writeHermesStateDb(join(root, '.hermes', 'profiles', 'work', 'state.db'), { prefix: 'work-' })
  write(join(root, '.hermes', '.env'), `OPENROUTER_API_KEY=${SECRET}\n`)
  write(join(root, '.hermes', 'auth.json'), JSON.stringify({ token: SECRET }))
  write(join(root, '.hermes', 'profiles', 'work', '.env'), `KEY=${SECRET}\n`)
  write(join(root, '.claude', 'projects', '-home-project', `${CLAUDE_ID}.jsonl`), fixture('claude.jsonl'))
  write(join(root, '.claude', 'projects', '-home-project', 'empty.jsonl'), '{"type":"summary","summary":"nothing"}\n')
  write(join(root, '.claude', '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: SECRET } }))
  write(join(root, '.codex', 'sessions', '2026', '06', '02', `rollout-2026-06-02T08-00-00-${CODEX_ID}.jsonl`), fixture('codex.jsonl'))
  write(join(root, '.codex', 'auth.json'), JSON.stringify({ OPENAI_API_KEY: SECRET }))
  write(join(root, '.codex', 'config.toml'), 'model = "gpt-5-codex"\n')
  write(join(root, '.openclaw', 'agents', 'main', 'sessions', 'oc-session-1.jsonl'), fixture('openclaw.jsonl'))
  write(join(root, '.openclaw', 'credentials', 'oauth.json'), JSON.stringify({ token: SECRET }))
}
