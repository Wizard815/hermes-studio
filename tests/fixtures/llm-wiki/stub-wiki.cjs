// A tiny stand-in for the LLM wiki's family MCP server (Wizard815/LLM-will-remember-this,
// .obsidian/plugins/llmwiki-mcp-bridge): POST /family-mcp, one Bearer token per person or
// shared agent, the same answer shapes, and the same visibility rule. A member sees their own
// folder (people/<id>/, shown as the vault root) and household/; a shared agent sees only
// household/ and must name whose memory it writes. No semantic search (query_wiki fails like a
// vault without the Second Brain extension), so clients fall back to notes_search.
const http = require('node:http')

const TOKENS = {
  't-wizard': { kind: 'member', id: 'wizard', name: 'Wizard', role: 'admin', as: 'member' },
  't-sam': { kind: 'member', id: 'sam', name: 'Sam', role: 'member' },
  't-house': { kind: 'shared', id: 'house', name: 'House assistant', role: 'shared' },
}
const SECTIONS = { worked_on: 'Worked on', decisions: 'Decisions / facts worth keeping', follow_ups: 'Follow-ups' }

function createWiki() {
  const notes = new Map(Object.entries({
    'people/wizard/profile.md': '# Wizard\n\n## Shared with the family\n\nRuns the homelab.\n',
    'people/wizard/wiki/1-projects/Surprise trip.md': '# Surprise trip\n\nBooking the Lisbon anniversary trip for Sam in March. Private.\n',
    'people/sam/profile.md': '# Sam\n\n## Shared with the family\n\nSews.\n',
    'people/sam/wiki/2-areas/Quilting.md': '# Quilting\n\nThe wedding quilt is cotton, blue and gold.\n',
    'household/wiki/3-resources/RaidLab.md': '# RaidLab\n\nRaidLab has two MI50 GPUs for local models.\n',
  }))
  const calls = []
  const day = () => new Date().toISOString().slice(0, 10)
  const home = (p) => (p.kind === 'member' ? `people/${p.id}` : 'household')
  const toVirtual = (real, p) => {
    if (real.startsWith('household/')) return real
    if (p.kind === 'member' && real.startsWith(`${home(p)}/`)) return real.slice(home(p).length + 1)
    return null
  }
  const toReal = (path, p) => {
    const clean = String(path || '').replace(/^\/+/, '')
    if (clean.startsWith('household/')) return clean
    if (clean.startsWith('people/') || clean.startsWith('groups/')) return null
    return p.kind === 'member' ? `${home(p)}/${clean}` : null
  }
  const rootFor = (p, person) => {
    if (p.kind === 'member') return person && person !== 'household' && person.toLowerCase() !== p.id ? null : person === 'household' ? 'household' : home(p)
    if (!person) throw new Error('A shared agent must name the person (or household) on every write.')
    return person === 'household' ? 'household' : null // the stub's shared agent writes only the household's memory
  }
  const tools = {
    whoami: (a, p) => `You are acting for: ${p.name} (${p.kind === 'member' ? (p.as || p.role) : p.kind}, id ${p.id}).\n${p.kind === 'shared' ? 'You are a shared agent.' : 'Your view of the vault.'}`,
    context_for: (a, p) => {
      if (p.kind === 'shared' && a.person && a.person !== 'household') throw new Error('stub: only household')
      const profile = p.kind === 'member' ? notes.get(`${home(p)}/profile.md`) || '' : ''
      return `# Context for ${p.kind === 'member' ? p.name : 'the household'}\n\n${profile}\n## Today (${day()})\n\n${notes.get(`${home(p)}/daily/${day()}.md`) || '(nothing logged yet)'}`
    },
    query_wiki: () => { throw new Error('the Second Brain extension is not enabled, so semantic search is unavailable') },
    notes_search: (a, p) => {
      const q = String(a.query || '').toLowerCase()
      const hits = []
      for (const [real, text] of notes) {
        const v = toVirtual(real, p)
        if (v === null || !text.toLowerCase().includes(q)) continue
        const at = text.toLowerCase().indexOf(q)
        hits.push({ path: v, count: text.toLowerCase().split(q).length - 1, snippet: text.slice(Math.max(0, at - 40), at + q.length + 40).replace(/\s+/g, ' ').trim() })
      }
      return hits.length ? JSON.stringify(hits, null, 2) : `Nothing you can see contains "${a.query}".`
    },
    note_read: (a, p) => {
      const real = toReal(a.path, p)
      if (!real || !notes.has(real)) throw new Error(`No note at ${a.path} that you can read.`)
      return notes.get(real)
    },
    memory_log: (a, p) => {
      const root = rootFor(p, a.person)
      if (!root) throw new Error("You can't write another person's memory.")
      if (/\b(password|token|api[_-]?key)\s*[:=]\s*\S{6,}/i.test(a.text)) throw new Error('That looks like a secret (rule 9), so nothing was written.')
      const path = `${root}/daily/${day()}.md`
      const heading = SECTIONS[a.section || 'decisions'] || SECTIONS.decisions
      notes.set(path, `${notes.get(path) || ''}## ${heading}\n- ${a.text}${a.source ? ` (${a.source})` : ''}\n`)
      return `Logged in ${toVirtual(path, p)} under "${heading}".`
    },
    memory_capture: (a, p) => {
      const root = rootFor(p, a.person)
      if (!root) throw new Error("You can't write another person's memory.")
      const path = `${root}/inbox/${day()} - ${a.title}.md`
      notes.set(path, String(a.content))
      return `Captured as ${toVirtual(path, p)}.`
    },
  }
  const server = http.createServer((req, res) => {
    const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)) }
    if (req.url !== '/family-mcp') return send(404, { message: 'Not found' })
    const token = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '')?.[1]
    const p = token && TOKENS[token]
    if (!p) return send(401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'A family token is required (Authorization: Bearer <token>).' } })
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      const msg = JSON.parse(raw || '{}')
      const ok = (result) => send(200, { jsonrpc: '2.0', id: msg.id, result })
      if (msg.method !== 'tools/call') return ok({})
      const { name, arguments: args = {} } = msg.params || {}
      calls.push({ token, name, args })
      const tool = tools[name]
      if (!tool) return send(200, { jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: `Unknown tool: ${name}` } })
      try { ok({ content: [{ type: 'text', text: String(tool(args, p)) }] }) } catch (e) { ok({ content: [{ type: 'text', text: e.message }], isError: true }) }
    })
  })
  return {
    notes, calls, server,
    listen: () => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`))),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}

module.exports = { createWiki, TOKENS }

if (require.main === module) {
  const wiki = createWiki()
  wiki.server.listen(Number(process.argv[2] || 0), '127.0.0.1', () => console.log(`stub wiki on http://127.0.0.1:${wiki.server.address().port}/family-mcp`))
}
