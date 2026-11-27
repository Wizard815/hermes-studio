import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { config } from '../../../studio/public/config'
import { logger } from '../../../studio/public/logging'

/**
 * MCP directory (docs/mcp-directory.md): the community list
 * punkpeye/awesome-mcp-servers (MIT), fetched by the server, cached for a day
 * in Web UI state and searched here, plus a few recommended servers with a
 * ready config. Nothing is installed from the list without the person's click.
 */

export const MCP_DIRECTORY_SOURCE = {
  repo: 'https://github.com/punkpeye/awesome-mcp-servers',
  raw: 'https://raw.githubusercontent.com/punkpeye/awesome-mcp-servers/main/README.md',
  licence: 'MIT',
}
const CACHE_TTL_MS = 24 * 3600 * 1000

export type McpDirectoryScope = 'local' | 'cloud' | 'embedded'

export interface McpDirectoryConfig { command: string; args: string[] }

export interface McpDirectoryEntry {
  name: string
  url: string
  category: string
  description: string
  official: boolean
  languages: string[]
  scopes: McpDirectoryScope[]
  os: string[]
  /** An install line the list gives, e.g. `npx -y @x/mcp`. */
  install?: string
  /** A stdio config built from that line when it is a plain npx/uvx run. */
  config?: McpDirectoryConfig
}

export interface McpRecommendedEntry {
  name: string
  title: string
  url: string
  description: string
  licence: string
  config: McpDirectoryConfig
  /** What has to be on the Hermes host first; shown before Add. */
  needs: string
}

/** Servers the homelab uses, pinned. Their tools are explained by the bundled skills (docs/homelab-skills.md). */
export const MCP_RECOMMENDED: McpRecommendedEntry[] = [
  {
    name: 'tokensave',
    title: 'tokensave',
    url: 'https://github.com/aovestdipaperino/tokensave',
    description: 'A local code graph: symbols, callers and impact in one call instead of many file reads. Best for small local models.',
    licence: 'MIT',
    config: { command: 'tokensave', args: ['serve'] },
    needs: 'The tokensave binary on the Hermes host (cargo install tokensave --version 7.16.0), and tokensave init in each repo.',
  },
  {
    name: 'markitdown',
    title: 'MarkItDown',
    url: 'https://github.com/microsoft/markitdown/tree/main/packages/markitdown-mcp',
    description: 'Converts PDF, Office, HTML, EPUB and more to Markdown (tool convert_to_markdown), so text-only models can read them.',
    licence: 'MIT',
    config: { command: 'uvx', args: ['markitdown-mcp==0.0.1a8'] },
    needs: 'uv on the Hermes host (the Hermes image has it).',
  },
  {
    name: 'repomix',
    title: 'Repomix',
    url: 'https://github.com/yamadashy/repomix',
    description: 'Packs a local folder or a GitHub repo into one AI-friendly file the model can read, with tree-sitter compression.',
    licence: 'MIT',
    config: { command: 'npx', args: ['-y', 'repomix@1.19.0', '--mcp'] },
    needs: 'Node.js 18+ on the Hermes host.',
  },
]

const LANGUAGES: Array<[string, string]> = [
  ['🐍', 'Python'], ['📇', 'TypeScript'], ['🏎️', 'Go'], ['🦀', 'Rust'], ['#️⃣', 'C#'], ['☕', 'Java'], ['🌊', 'C/C++'], ['💎', 'Ruby'],
]
const SCOPES: Array<[string, McpDirectoryScope]> = [['☁️', 'cloud'], ['🏠', 'local'], ['📟', 'embedded']]
const OS: Array<[string, string]> = [['🍎', 'macOS'], ['🪟', 'Windows'], ['🐧', 'Linux']]

const SETUP_WORDS = new Set(['setup', 'install', 'init', 'login', 'auth', 'add', 'configure', 'onboard'])
const ITEM_RE = /^\s*[-*]\s+\[([^\]]+)\]\(([^)\s]+)\)(.*)$/
const BADGE_RE = /\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)|!\[[^\]]*\]\([^)]*\)/g
const LINK_RE = /\[([^\]]+)\]\([^)]*\)/g
const INSTALL_RE = /`((?:npx|uvx|pipx|bunx|docker run|pip install|uv tool install|go install|cargo install|npm install -g|brew install)\s[^`]+)`/

/** The list writes some marks with and some without the emoji variation selector. */
const has = (marks: string, mark: string) => marks.replace(/\uFE0F/g, '').includes(mark.replace(/\uFE0F/g, ''))
const clean = (text: string) => text.replace(BADGE_RE, '').replace(LINK_RE, '$1').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()

/** A plain `npx [-y] pkg [args]` or `uvx pkg [args]` line becomes a stdio config; anything else stays a hint. */
export function configFromInstall(line: string): McpDirectoryConfig | undefined {
  const words = line.trim().split(/\s+/)
  if (words.some(word => /[|&;<>$`]/.test(word))) return undefined
  // `npx x setup` or `uvx x install` sets something up once; it is not the server.
  if (words.some(word => SETUP_WORDS.has(word.toLowerCase()))) return undefined
  if (words[0] === 'npx' || words[0] === 'uvx') {
    const args = words.slice(1)
    if (words[0] === 'npx' && !args.includes('-y')) args.unshift('-y')
    return args.some(arg => !arg.startsWith('-')) ? { command: words[0], args } : undefined
  }
  return undefined
}

export function parseMcpDirectory(markdown: string): McpDirectoryEntry[] {
  const entries: McpDirectoryEntry[] = []
  let inServers = false
  let category = ''
  for (const line of markdown.split(/\r?\n/)) {
    if (/^##\s/.test(line)) { inServers = /Server Implementations/i.test(line); continue }
    if (!inServers) continue
    const heading = line.match(/^###\s+(.*)$/)
    if (heading) {
      category = clean(heading[1]).replace(/^[^\p{L}\p{N}]+/u, '').trim()
      continue
    }
    const item = line.match(ITEM_RE)
    if (!item || item[2].startsWith('#')) continue
    const rest = item[3].replace(BADGE_RE, '')
    const dash = rest.search(/\s[-–—]\s/)
    const marks = dash >= 0 ? rest.slice(0, dash) : ''
    const description = clean(dash >= 0 ? rest.slice(dash + 3) : rest)
    const install = description.match(INSTALL_RE)?.[1] || item[3].match(INSTALL_RE)?.[1]
    const entry: McpDirectoryEntry = {
      name: clean(item[1]),
      url: item[2],
      category,
      description: description.replace(/`/g, ''),
      official: marks.includes('🎖'),
      languages: LANGUAGES.filter(([mark]) => marks.includes(mark)).map(([, name]) => name),
      scopes: SCOPES.filter(([mark]) => marks.includes(mark.replace('️', ''))).map(([, name]) => name),
      os: OS.filter(([mark]) => marks.includes(mark)).map(([, name]) => name),
    }
    if (install) {
      entry.install = install.trim()
      const parsed = configFromInstall(entry.install)
      if (parsed) entry.config = parsed
    }
    entries.push(entry)
  }
  return entries
}

// ---- fetch and cache ---------------------------------------------------------

export function mcpDirectoryCacheFile(): string {
  return join(config.appHome, 'mcp-directory', 'awesome-mcp-servers.md')
}

let memo: { at: number; fetchedAt: string; entries: McpDirectoryEntry[] } | null = null

export function forgetMcpDirectory(): void { memo = null }

async function download(): Promise<string> {
  const res = await fetch(MCP_DIRECTORY_SOURCE.raw, { signal: AbortSignal.timeout(30_000), headers: { 'User-Agent': 'hermes-studio-mcp-directory' } })
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`)
  const text = await res.text()
  if (!text.includes('Server Implementations')) throw new Error('The list did not look like awesome-mcp-servers')
  return text
}

/** The list, from memory, the day-old cache, or GitHub. A failed download falls back to any cache. */
export async function loadMcpDirectory(options: { refresh?: boolean; fetcher?: () => Promise<string>; now?: () => number } = {}) {
  const now = options.now || Date.now
  if (memo && !options.refresh && now() - memo.at < CACHE_TTL_MS) return memo
  const file = mcpDirectoryCacheFile()
  const cached = await stat(file).then(s => s.mtimeMs, () => 0)
  let text = ''
  let fetchedAt = cached ? new Date(cached).toISOString() : ''
  if (!options.refresh && cached && now() - cached < CACHE_TTL_MS) {
    text = await readFile(file, 'utf8')
  } else {
    try {
      text = await (options.fetcher || download)()
      await mkdir(join(file, '..'), { recursive: true })
      await writeFile(file, text, 'utf8')
      fetchedAt = new Date(now()).toISOString()
    } catch (err: any) {
      if (!cached) throw new Error(`Could not download the MCP list from GitHub: ${err?.message || err}`)
      logger.warn('[mcp-directory] download failed, using the cached list: %s', err?.message || err)
      text = await readFile(file, 'utf8')
    }
  }
  memo = { at: now(), fetchedAt, entries: parseMcpDirectory(text) }
  return memo
}

export interface McpDirectoryQuery {
  q?: string
  category?: string
  scope?: McpDirectoryScope | ''
  official?: boolean
  ready?: boolean
  offset?: number
  limit?: number
}

function rank(entry: McpDirectoryEntry, terms: string[]): number {
  const name = entry.name.toLowerCase()
  const text = `${entry.category} ${entry.description}`.toLowerCase()
  let score = 0
  for (const term of terms) {
    const word = new RegExp(`(^|[^a-z0-9])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`)
    const inName = word.test(name) ? 4 : name.includes(term) ? 2 : 0
    const inText = word.test(text) ? 1.5 : text.includes(term) ? 0.5 : 0
    if (!inName && !inText) return 0
    score += inName + inText
  }
  return score + (entry.official ? 0.5 : 0)
}

export function searchMcpDirectory(entries: McpDirectoryEntry[], query: McpDirectoryQuery) {
  const terms = String(query.q || '').toLowerCase().split(/\s+/).filter(Boolean)
  let hits = entries.filter(entry => (!query.category || entry.category === query.category)
    && (!query.scope || entry.scopes.includes(query.scope))
    && (!query.official || entry.official)
    && (!query.ready || !!entry.config))
  if (terms.length) {
    hits = hits.map(entry => ({ entry, score: rank(entry, terms) }))
      .filter(hit => hit.score > 0)
      .sort((a, b) => b.score - a.score)
      .map(hit => hit.entry)
  }
  const offset = Math.max(0, Number(query.offset) || 0)
  const limit = Math.min(200, Math.max(1, Number(query.limit) || 60))
  return { total: hits.length, entries: hits.slice(offset, offset + limit) }
}

export function mcpDirectoryCategories(entries: McpDirectoryEntry[]): Array<{ name: string; count: number }> {
  const counts = new Map<string, number>()
  for (const entry of entries) counts.set(entry.category, (counts.get(entry.category) || 0) + 1)
  return [...counts].map(([name, count]) => ({ name, count }))
}
