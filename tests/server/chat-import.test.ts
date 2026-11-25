import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import AdmZip from 'adm-zip'
import * as tar from 'tar'
import { buildFixtureHome, CLAUDE_ID, CODEX_ID, SECRET, writeHermesStateDb } from './fixtures/chat-import/home'

const fixtures = join(__dirname, 'fixtures', 'chat-import')
const limits = { maxFileBytes: 1024 * 1024, maxToolOutputChars: 1000, maxMessagesPerChat: 1000 }

let dir: string
let db: DatabaseSync

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'chat-import-test-')))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  vi.resetModules()
  vi.doUnmock('../../packages/server/src/modules/studio/infrastructure/database/index')
})

async function studio() {
  vi.resetModules()
  db = new DatabaseSync(':memory:')
  vi.doMock('../../packages/server/src/modules/studio/infrastructure/database/index', () => ({ getDb: () => db, isSqliteAvailable: () => true }))
  const schema = await import('../../packages/server/src/modules/studio/infrastructure/database/schemas')
  schema.initAllHermesTables()
  const service = await import('../../packages/server/src/modules/studio/services/chat-import/service')
  const sessions = await import('../../packages/server/src/modules/studio/repositories/session-store')
  const categories = await import('../../packages/server/src/modules/studio/repositories/session-category-store')
  return { service, sessions, categories }
}

function dump(): string {
  const rows = [...db.prepare('SELECT * FROM sessions').all(), ...db.prepare('SELECT * FROM messages').all()]
  return JSON.stringify(rows)
}

describe('parsers', () => {
  it('reads a Claude Code session: title, folder, tool steps and thinking; skips noise and side chains', async () => {
    const { parseClaudeSession } = await import('../../packages/server/src/modules/studio/services/chat-import/parse-jsonl')
    const chat = await parseClaudeSession(join(fixtures, 'claude.jsonl'), limits)
    expect(chat).toMatchObject({ kind: 'claude-code', originalId: CLAUDE_ID, title: 'Fix the flaky login test', cwd: '__CWD__', model: 'claude-sonnet-4-5' })
    expect(chat.messages.map(m => [m.role, m.content])).toEqual([
      ['user', 'Why does the login test fail?'],
      ['assistant', 'Let me read it.'],
      ['tool', 'expect(await login()).toBe(true) // API_KEY=sk-test-kept-as-is'],
      ['assistant', 'The test races the session cookie.'],
    ])
    expect(chat.messages[1]).toMatchObject({ reasoning: 'Look at the test first.', tool_calls: [{ id: 'toolu_1', function: { name: 'Read', arguments: '{"file_path":"tests/login.test.ts"}' } }] })
    expect(chat.messages[2]).toMatchObject({ tool_call_id: 'toolu_1', tool_name: 'Read' })
    expect(chat.startedAt).toBe(Date.parse('2026-05-01T10:00:00.000Z') / 1000)
  })

  it('reads a Codex rollout: id and folder from its header, shell calls and their output', async () => {
    const { parseCodexSession } = await import('../../packages/server/src/modules/studio/services/chat-import/parse-jsonl')
    const chat = await parseCodexSession(join(fixtures, 'codex.jsonl'), limits)
    expect(chat).toMatchObject({ kind: 'codex', originalId: CODEX_ID, cwd: '__CWD__', model: 'gpt-5-codex', title: 'List the files' })
    expect(chat.messages.map(m => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant'])
    expect(chat.messages[1]).toMatchObject({ reasoning: 'Use ls.', tool_calls: [{ id: 'call_1', function: { name: 'shell' } }] })
    expect(chat.messages[2]).toMatchObject({ tool_call_id: 'call_1', tool_name: 'shell', content: 'README.md\nsrc\n' })
  })

  it('reads an OpenClaw session', async () => {
    const { parseOpenClawSession } = await import('../../packages/server/src/modules/studio/services/chat-import/parse-jsonl')
    const chat = await parseOpenClawSession(join(fixtures, 'openclaw.jsonl'), limits)
    expect(chat).toMatchObject({ kind: 'openclaw', originalId: 'oc-session-1', model: 'claude-opus-4', title: "What's on my calendar?" })
    expect(chat.messages.map(m => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant'])
    expect(chat.messages[2]).toMatchObject({ tool_call_id: 'tc1', tool_name: 'calendar_list', content: '10:00 Dentist' })
  })

  it('cuts very long tool output and refuses files over the size cap', async () => {
    const { parseClaudeSession } = await import('../../packages/server/src/modules/studio/services/chat-import/parse-jsonl')
    const file = join(dir, 'big.jsonl')
    writeFileSync(file, [
      { type: 'user', sessionId: 's', message: { content: 'go' } },
      { type: 'assistant', sessionId: 's', message: { id: 'm', content: [{ type: 'tool_use', id: 't', name: 'Bash', input: {} }] } },
      { type: 'user', sessionId: 's', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'x'.repeat(5000) }] } },
    ].map(line => JSON.stringify(line)).join('\n'))
    const chat = await parseClaudeSession(file, limits)
    expect(chat.messages[2].content).toMatch(/^x{1000}\n\[… 4000 more characters not imported\]$/)
    await expect(parseClaudeSession(file, { ...limits, maxFileBytes: 100 })).rejects.toMatchObject({ code: 'chat_import_too_large' })
  })

  it('reads a Hermes state.db: merges compression chains, skips inactive and summary rows', async () => {
    const { listHermesChats, readHermesChat } = await import('../../packages/server/src/modules/studio/services/chat-import/parse-hermes')
    const path = join(dir, 'state.db')
    writeHermesStateDb(path, { cwd: '/work/garden' })
    const chats = await listHermesChats(path)
    expect(chats.map(chat => [chat.originalId, chat.title, chat.messageCount, chat.userMessages])).toEqual([
      ['h-plain', 'Plan the garden', 4, 1],
      ['h-root', 'The fox story', 4, 2],
      ['h-empty', 'Hermes chat', 0, 0],
    ])
    expect(chats[0].cwd).toBe('/work/garden')
    expect(chats[1].sessionIds).toEqual(['h-root', 'h-cont'])
    const messages = await readHermesChat(path, chats[1].sessionIds, { maxMessagesPerChat: 100, maxToolOutputChars: 100 })
    expect(messages.map(m => m.content)).toEqual(['Write a long story about a fox', 'Chapter one.', 'Continue', 'Chapter two.'])
    const plain = await readHermesChat(path, ['h-plain'], { maxMessagesPerChat: 100, maxToolOutputChars: 100 })
    expect(plain[1]).toMatchObject({ role: 'assistant', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'web_search' } }] })
    expect(plain[2]).toMatchObject({ role: 'tool', tool_call_id: 'c1', tool_name: 'web_search' })
  })
})

describe('message pairing', () => {
  it('drops tool results whose call is not in the chat', async () => {
    const { pairedMessages } = await import('../../packages/server/src/modules/studio/services/chat-import/service')
    const kept = pairedMessages([
      { role: 'tool', content: 'orphan', tool_call_id: 'x', timestamp: 1 },
      { role: 'assistant', content: '', tool_calls: [{ id: 'a', type: 'function', function: { name: 'f', arguments: '{}' } }], timestamp: 2 },
      { role: 'tool', content: 'answer', tool_call_id: 'a', timestamp: 3 },
      { role: 'tool', content: 'no id', timestamp: 4 },
    ])
    expect(kept.map(m => m.content)).toEqual(['', 'answer'])
  })
})

describe('credentials', () => {
  it('never opens credential files', async () => {
    const { readJsonl, isCredentialFile, isChatSourceFile } = await import('../../packages/server/src/modules/studio/services/chat-import/guard')
    for (const name of ['.env', 'auth.json', '.credentials.json', 'credentials.json', 'cli-config.json', '.env.local', 'id_rsa', 'key.pem']) {
      expect(isCredentialFile(`/x/${name}`)).toBe(true)
      expect(isChatSourceFile(`/x/${name}`)).toBe(false)
    }
    const file = join(dir, 'auth.json')
    writeFileSync(file, '{"token":"x"}\n')
    await expect(readJsonl(file, 1024).next()).rejects.toMatchObject({ code: 'chat_import_credential' })
  })
})

describe('scan and import', () => {
  it('previews a home folder, imports into the chosen profile and folder, and is safe to run again', async () => {
    const { service, sessions, categories } = await studio()
    const home = join(dir, 'home')
    const project = join(dir, 'project')
    mkdirSync(project)
    buildFixtureHome(home, project)
    const imports = new service.ChatImportService({ agentHomes: () => ({ claude: [join(home, '.claude')], codex: [join(home, '.codex')] }) })

    const scan = await imports.scanPath(home, '1')
    expect(scan.counts).toEqual({ hermes: 6, 'claude-code': 2, codex: 1, openclaw: 1 })
    expect(JSON.stringify(scan)).not.toContain(SECRET)
    const byKey = Object.fromEntries(scan.candidates.map(c => [c.key, c]))
    expect(byKey[`claude-code:${CLAUDE_ID}`]).toMatchObject({ title: 'Fix the flaky login test', cwd: project, cwdExists: true, resumable: true, messageCount: 4, skipReason: null })
    expect(byKey[`codex:${CODEX_ID}`]).toMatchObject({ resumable: true, cwdExists: true })
    expect(byKey['hermes:h-empty'].skipReason).toBe('empty')
    expect(byKey['hermes:work-h-plain'].sourceProfile).toBe('work')
    expect(byKey['openclaw:oc-session-1']).toMatchObject({ cwdExists: false, resumable: false })

    const folder = categories.createSessionCategory('Imported')
    const job = await imports.waitForJob(imports.startImport(scan.id, '1', { profile: 'default', categoryId: folder.id }).id)
    expect(job.status).toBe('done')
    expect(job.failed).toEqual([])
    expect(job.imported).toHaveLength(7)
    expect(job.skipped.map(item => item.reason).sort()).toEqual(['empty', 'empty', 'empty'])

    const claude = sessions.getSession(service.importedChatId('claude-code', CLAUDE_ID))!
    expect(claude).toMatchObject({ source: 'coding_agent', agent: 'claude', agent_native_session_id: CLAUDE_ID, workspace: project, category_id: folder.id, profile: 'default', title: 'Fix the flaky login test', message_count: 4, studio_user_id: '1' })
    expect(claude.started_at).toBe(Date.parse('2026-05-01T10:00:00.000Z') / 1000)
    expect(claude.last_active).toBe(Date.parse('2026-05-01T10:00:09.000Z') / 1000)
    const hermes = sessions.getSession(service.importedChatId('hermes', 'h-root'))!
    expect(hermes).toMatchObject({ source: 'cli', agent: 'hermes', agent_native_session_id: '', message_count: 4, title: 'The fox story' })
    const openclaw = sessions.getSession(service.importedChatId('openclaw', 'oc-session-1'))!
    expect(openclaw).toMatchObject({ source: 'cli', agent: 'hermes', workspace: null })
    const steps = sessions.getSessionDetail(service.importedChatId('hermes', 'h-plain'))!.messages
    expect(steps.map(m => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant'])
    expect(steps[1].tool_calls?.[0]).toMatchObject({ id: 'c1', function: { name: 'web_search' } })
    expect(dump()).not.toContain(SECRET)
    // Message text is kept as written, including key-like strings the user typed or a tool printed.
    expect(dump()).toContain('sk-test-kept-as-is')

    const again = await imports.scanPath(home, '1')
    expect(again.candidates.filter(c => !c.skipReason).every(c => c.existingSessionId)).toBe(true)
    const second = await imports.waitForJob(imports.startImport(again.id, '1', { profile: 'default', categoryId: null }).id)
    expect(second.imported).toEqual([])
    expect(second.skipped.filter(item => item.reason === 'duplicate')).toHaveLength(7)
    expect(db.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 7 })
  })

  it('imports only the chosen chats, and coding chats from elsewhere start with a recap (no agent session)', async () => {
    const { service, sessions } = await studio()
    const home = join(dir, 'home')
    buildFixtureHome(home, join(dir, 'gone'))
    const imports = new service.ChatImportService({ agentHomes: () => ({ claude: ['/nowhere/.claude'], codex: ['/nowhere/.codex'] }) })
    const scan = await imports.scanPath(home, '1')
    const job = await imports.waitForJob(imports.startImport(scan.id, '1', { keys: [`claude-code:${CLAUDE_ID}`], profile: 'default', categoryId: null }).id)
    expect(job.imported.map(item => item.key)).toEqual([`claude-code:${CLAUDE_ID}`])
    expect(sessions.getSession(service.importedChatId('claude-code', CLAUDE_ID))).toMatchObject({ agent: 'claude', agent_native_session_id: '', workspace: null })
    await expect(Promise.resolve().then(() => imports.getScan(scan.id, '2'))).rejects.toMatchObject({ code: 'chat_import_scan_missing' })
  })

  it('treats chats Studio already has (its own Hermes and coding chats) as duplicates', async () => {
    const { service, sessions } = await studio()
    const home = join(dir, 'home')
    buildFixtureHome(home, dir)
    // A Studio Hermes chat runs in Hermes under its Studio id; a Studio Claude chat keeps Claude's session id.
    sessions.createSession({ id: 'h-plain', source: 'cli', title: 'Studio chat' })
    sessions.createSession({ id: 'studio-claude', source: 'coding_agent', agent: 'claude', agent_native_session_id: CLAUDE_ID })
    const imports = new service.ChatImportService()
    const scan = await imports.scanPath(home, '1')
    const byKey = Object.fromEntries(scan.candidates.map(c => [c.key, c]))
    expect(byKey['hermes:h-plain'].existingSessionId).toBe('h-plain')
    expect(byKey[`claude-code:${CLAUDE_ID}`].existingSessionId).toBe('studio-claude')
    const job = await imports.waitForJob(imports.startImport(scan.id, '1', { keys: ['hermes:h-plain', `claude-code:${CLAUDE_ID}`], profile: 'default', categoryId: null }).id)
    expect(job.skipped.map(item => `${item.sessionId}:${item.reason}`).sort()).toEqual(['h-plain:duplicate', 'studio-claude:duplicate'])
    expect(job.imported).toEqual([])
  })

  it('refuses relative and missing paths', async () => {
    const { service } = await studio()
    const imports = new service.ChatImportService()
    await expect(imports.scanPath('relative/path', '1')).rejects.toMatchObject({ status: 400 })
    await expect(imports.scanPath(join(dir, 'missing'), '1')).rejects.toMatchObject({ status: 404 })
  })
})

describe('uploads', () => {
  function zipOf(entries: Record<string, string>): Buffer {
    const zip = new AdmZip()
    for (const [name, text] of Object.entries(entries)) zip.addFile(name, Buffer.from(text))
    return zip.toBuffer()
  }

  it('unpacks only chat files from a zip (credentials are never written) and cleans up after import', async () => {
    const { service } = await studio()
    const home = join(dir, 'home')
    buildFixtureHome(home, '/elsewhere')
    const zip = new AdmZip()
    zip.addLocalFolder(home, 'backup')
    const imports = new service.ChatImportService()
    const scan = await imports.scanUpload(Readable.from(zip.toBuffer()), 'backup.zip', '1')
    expect(scan.upload).toBe(true)
    expect(scan.counts).toEqual({ hermes: 6, 'claude-code': 2, codex: 1, openclaw: 1 })
    expect(scan.skippedFiles).toBeGreaterThanOrEqual(6)
    // Uploaded coding chats cannot be resumed here: the agent's own session is not on this server.
    expect(scan.candidates.every(c => !c.resumable)).toBe(true)
    const temp = readdirSync(tmpdir()).filter(name => name.startsWith('studio-chat-import-'))
    const unpacked = temp.map(name => join(tmpdir(), name, 'files')).filter(existsSync)
    const files = unpacked.flatMap(root => walk(root))
    expect(files.some(file => file.endsWith('.jsonl'))).toBe(true)
    expect(files.filter(file => /(\.env|auth\.json|credentials\.json|oauth\.json|config\.toml)$/.test(file))).toEqual([])
    const job = await imports.waitForJob(imports.startImport(scan.id, '1', { profile: 'default', categoryId: null }).id)
    expect(job.imported).toHaveLength(7)
    expect(dump()).not.toContain(SECRET)
    for (const root of unpacked) expect(existsSync(root)).toBe(false)
  })

  it('refuses zip-slip paths, oversized uploads and archives with too many files', async () => {
    const { service } = await studio()
    const imports = new service.ChatImportService({ limits: { maxUploadBytes: 4096, maxArchiveEntries: 3 } })
    const slip = new AdmZip()
    slip.addFile('ok.jsonl', Buffer.from('{}'))
    slip.getEntries()[0].entryName = '../../evil.jsonl'
    await expect(imports.scanUpload(Readable.from(slip.toBuffer()), 'evil.zip', '1')).rejects.toMatchObject({ code: 'chat_import_unsafe_archive' })
    expect(existsSync(join(tmpdir(), 'evil.jsonl'))).toBe(false)
    await expect(imports.scanUpload(Readable.from(Buffer.alloc(10_000)), 'big.zip', '1')).rejects.toMatchObject({ status: 413 })
    await expect(imports.scanUpload(Readable.from(zipOf({ 'a.jsonl': '', 'b.jsonl': '', 'c.jsonl': '', 'd.jsonl': '' })), 'many.zip', '1')).rejects.toMatchObject({ code: 'chat_import_too_large' })
    await expect(imports.scanUpload(Readable.from(Buffer.from('x')), 'notes.txt', '1')).rejects.toMatchObject({ status: 400 })
    expect(readdirSync(tmpdir()).filter(name => name.startsWith('studio-chat-import-') && !statSync(join(tmpdir(), name)).isFile())
      .filter(name => existsSync(join(tmpdir(), name, 'upload.zip')))).toEqual([])
  })

  it('skips links in a tar and reads its sessions', async () => {
    const { service } = await studio()
    const src = join(dir, 'src')
    mkdirSync(join(src, '.codex', 'sessions', '2026'), { recursive: true })
    writeFileSync(join(src, '.codex', 'sessions', '2026', `rollout-x-${CODEX_ID}.jsonl`), (await import('node:fs')).readFileSync(join(fixtures, 'codex.jsonl')))
    writeFileSync(join(src, '.codex', 'config.toml'), '')
    symlinkSync('/etc/passwd', join(src, '.codex', 'sessions', 'link.jsonl'))
    const file = join(dir, 'codex.tgz')
    await tar.create({ cwd: src, file, gzip: true }, ['.codex'])
    const imports = new service.ChatImportService()
    const scan = await imports.scanUpload(Readable.from((await import('node:fs')).readFileSync(file)), 'codex.tgz', '1')
    expect(scan.counts.codex).toBe(1)
    expect(scan.candidates[0]).toMatchObject({ originalId: CODEX_ID, messageCount: 4 })
    await imports.discardScan(scan.id, '1')
  })
})

describe('API', () => {
  let server: Server | null = null
  afterEach(() => { server?.close(); server = null })

  async function app(role: string) {
    const loaded = await studio()
    vi.doMock('../../packages/server/src/modules/studio/public/profile-config', () => ({ listProfileNamesFromDisk: () => ['default'] }))
    const { default: Koa } = await import('koa')
    const { createRequestBodyParser } = await import('../../packages/server/src/modules/studio/middleware/request-body-parser')
    const { chatImportRoutes } = await import('../../packages/server/src/modules/studio/routes/chat-import')
    const koa = new Koa()
    koa.use(async (ctx, next) => { ctx.state.user = { id: 1, role }; await next() })
    koa.use(createRequestBodyParser())
    koa.use(chatImportRoutes.routes())
    server = createServer(koa.callback())
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
    const address = server.address() as { port: number }
    return { base: `http://127.0.0.1:${address.port}`, ...loaded }
  }

  it('is for super admins only', async () => {
    const { base } = await app('admin')
    const response = await fetch(`${base}/api/studio/chat-import/scan`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: dir }) })
    expect(response.status).toBe(403)
  })

  it('scans a path, uploads an archive, imports and reports the job', async () => {
    const { base, service } = await app('super_admin')
    const home = join(dir, 'home')
    buildFixtureHome(home, dir)
    const bad = await fetch(`${base}/api/studio/chat-import/scan`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: 'nope' }) })
    expect(bad.status).toBe(400)
    expect((await bad.json()).error).toMatch(/full path/)
    const zip = new AdmZip()
    zip.addLocalFolder(join(home, '.openclaw'), '.openclaw')
    const upload = await fetch(`${base}/api/studio/chat-import/upload?name=openclaw.zip`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: zip.toBuffer() })
    expect(upload.status).toBe(200)
    const scan = await upload.json()
    expect(scan.counts.openclaw).toBe(1)
    const badProfile = await fetch(`${base}/api/studio/chat-import/scans/${scan.id}/import`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ profile: 'missing' }) })
    expect(badProfile.status).toBe(400)
    const started = await (await fetch(`${base}/api/studio/chat-import/scans/${scan.id}/import`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ profile: 'default' }) })).json()
    await service.chatImportService.waitForJob(started.id)
    const job = await (await fetch(`${base}/api/studio/chat-import/jobs/${started.id}`)).json()
    expect(job).toMatchObject({ status: 'done', total: 1, done: 1, imported: [{ key: 'openclaw:oc-session-1', sessionId: service.importedChatId('openclaw', 'oc-session-1') }] })
  })
})

function walk(root: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) out.push(...walk(path))
    else out.push(path)
  }
  return out
}
