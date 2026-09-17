import { readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import type { AgentTool, AgentToolContext, AgentToolResult } from './types'
import { resolveUnrestrictedToolPath } from './path-safety'

export const DEFAULT_SEARCH_MAX_RESULTS = 200
export const DEFAULT_SEARCH_MAX_FILES_SCANNED = 5_000
export const DEFAULT_SEARCH_MAX_FILE_BYTES = 2 * 1024 * 1024

// Directories that are near-never useful to search into and can be huge —
// skipped unconditionally, not configurable, to keep a search fast by default.
const SKIPPED_DIRECTORY_NAMES = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', '.next',
  '.nuxt', '.turbo', '.ekko-tmp', 'coverage', '.venv', 'venv', '__pycache__',
])

export interface SearchFilesInput extends Record<string, unknown> {
  pattern: string
  path?: string
  glob?: string
  caseSensitive?: boolean
  regex?: boolean
  maxResults?: number
}

export interface SearchMatch {
  file: string
  line: number
  text: string
}

/**
 * Recursive text search over files, structured results instead of a
 * hand-built grep/rg/findstr invocation through terminal_exec — the shell
 * quoting and cross-platform command differences are a well-known place for
 * a model to get the invocation subtly wrong.
 *
 * Pure Node, no bundled ripgrep binary: this is a fallback-shape
 * implementation (walk + per-line substring/regex test), not a speed
 * optimization. Bounded on every axis (files scanned, file size, results)
 * so a search over a huge tree degrades to "stopped early", never hangs.
 */
export class SearchFilesTool implements AgentTool<SearchFilesInput> {
  readonly concurrency = 'parallel' as const

  readonly definition: AgentTool['definition'] = {
    name: 'search_files',
    description: [
      'Search file contents recursively for a pattern and return structured {file, line, text} matches — use this instead of grep/rg/findstr through terminal_exec.',
      'pattern is a plain substring by default; set regex=true to use it as a JavaScript regular expression instead.',
      'glob optionally filters which files are searched (e.g. "*.ts", "src/**/*.py"); without it, common non-source directories (node_modules, .git, dist, build, venv, __pycache__, ...) are still skipped automatically.',
      `Stops after ${DEFAULT_SEARCH_MAX_RESULTS} matches or ${DEFAULT_SEARCH_MAX_FILES_SCANNED} files scanned, whichever comes first — a result set at either cap means there is more the search did not reach; narrow path or glob and search again.`,
      'Binary-looking and oversized files are skipped, not garbled into results.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Text to search for. Plain substring unless regex is true.' },
        path: { type: 'string', description: 'Directory (or single file) to search under. Defaults to the current workspace.' },
        glob: { type: 'string', description: 'Optional filename filter, e.g. "*.ts" or "src/**/*.py". Supports * (any run of characters within a segment), ** (any depth), and ? (one character).' },
        caseSensitive: { type: 'boolean', description: 'Defaults to false (case-insensitive).' },
        regex: { type: 'boolean', description: 'Treat pattern as a JavaScript regular expression instead of a plain substring. Defaults to false.' },
        maxResults: { type: 'number', description: `Maximum matches to return. Defaults to and cannot exceed ${DEFAULT_SEARCH_MAX_RESULTS}.` },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
  }

  async execute(input: SearchFilesInput, context: AgentToolContext = {}): Promise<AgentToolResult> {
    if (!input.pattern) {
      return { ok: false, content: 'pattern is required.', error: 'missing pattern' }
    }
    const root = resolveUnrestrictedToolPath(input.path || '.', context)
    const maxResults = clampPositive(input.maxResults, DEFAULT_SEARCH_MAX_RESULTS, DEFAULT_SEARCH_MAX_RESULTS)
    const caseSensitive = input.caseSensitive === true
    const globMatcher = input.glob ? globToRegExp(input.glob) : undefined

    let matcher: (line: string) => boolean
    if (input.regex) {
      let compiled: RegExp
      try {
        compiled = new RegExp(input.pattern, caseSensitive ? '' : 'i')
      } catch (error) {
        return { ok: false, content: `Invalid regular expression: ${error instanceof Error ? error.message : String(error)}`, error: 'invalid regex' }
      }
      matcher = line => compiled.test(line)
    } else {
      const needle = caseSensitive ? input.pattern : input.pattern.toLowerCase()
      matcher = caseSensitive
        ? line => line.includes(needle)
        : line => line.toLowerCase().includes(needle)
    }

    const matches: SearchMatch[] = []
    let filesScanned = 0
    let filesSkippedBinaryOrTooLarge = 0
    let stoppedEarly = false

    const rootInfo = await stat(root).catch(() => undefined)
    const files = rootInfo?.isFile() ? [root] : await collectFiles(root, globMatcher, () => filesScanned < DEFAULT_SEARCH_MAX_FILES_SCANNED)

    for (const filePath of files) {
      if (matches.length >= maxResults) { stoppedEarly = true; break }
      if (filesScanned >= DEFAULT_SEARCH_MAX_FILES_SCANNED) { stoppedEarly = true; break }
      filesScanned += 1

      const info = await stat(filePath).catch(() => undefined)
      if (!info || info.size > DEFAULT_SEARCH_MAX_FILE_BYTES) { filesSkippedBinaryOrTooLarge += 1; continue }

      let text: string
      try {
        const buffer = await readFile(filePath)
        if (looksBinary(buffer)) { filesSkippedBinaryOrTooLarge += 1; continue }
        text = buffer.toString('utf8')
      } catch {
        filesSkippedBinaryOrTooLarge += 1
        continue
      }

      const lines = text.split('\n')
      for (let i = 0; i < lines.length; i++) {
        if (matcher(lines[i])) {
          matches.push({ file: filePath, line: i + 1, text: lines[i].slice(0, 500) })
          if (matches.length >= maxResults) { stoppedEarly = true; break }
        }
      }
    }

    const content = matches.length === 0
      ? `No matches for "${input.pattern}" under ${root}${filesScanned ? ` (${filesScanned} files scanned)` : ''}.`
      : matches.map(m => `${m.file}:${m.line}: ${m.text}`).join('\n')
        + (stoppedEarly ? `\n\n[search_files stopped early: ${matches.length} matches / ${filesScanned} files scanned. Narrow path or glob and search again to see more.]` : '')

    return {
      ok: true,
      content,
      data: { matches, filesScanned, filesSkippedBinaryOrTooLarge, stoppedEarly, root },
    }
  }
}

async function collectFiles(
  root: string,
  globMatcher: RegExp | undefined,
  shouldContinue: () => boolean,
): Promise<string[]> {
  const results: string[] = []
  const stack: string[] = [root]
  while (stack.length && shouldContinue()) {
    const current = stack.pop()!
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!shouldContinue()) break
      if (entry.isDirectory()) {
        if (SKIPPED_DIRECTORY_NAMES.has(entry.name)) continue
        stack.push(path.join(current, entry.name))
        continue
      }
      if (!entry.isFile()) continue
      const filePath = path.join(current, entry.name)
      if (globMatcher && !globMatcher.test(path.relative(root, filePath).split(path.sep).join('/'))) continue
      results.push(filePath)
      if (results.length >= DEFAULT_SEARCH_MAX_FILES_SCANNED) return results
    }
  }
  return results
}

function looksBinary(buffer: Buffer): boolean {
  const sampleLength = Math.min(buffer.length, 8_000)
  for (let i = 0; i < sampleLength; i++) {
    if (buffer[i] === 0) return true
  }
  return false
}

function clampPositive(value: number | undefined, fallback: number, max: number): number {
  if (!Number.isFinite(value) || (value as number) <= 0) return fallback
  return Math.min(Math.floor(value as number), max)
}

/** Minimal glob: * within a segment, ** across segments, ? one character. Matched against a forward-slash-joined relative path. */
function globToRegExp(glob: string): RegExp {
  let out = ''
  const normalized = glob.split(path.sep).join('/')
  for (let i = 0; i < normalized.length; i++) {
    const char = normalized[i]
    if (char === '*') {
      if (normalized[i + 1] === '*') {
        out += '.*'
        i += 1
      } else {
        out += '[^/]*'
      }
    } else if (char === '?') {
      out += '[^/]'
    } else {
      out += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`(^|/)${out}$`)
}

export function createSearchTools(): AgentTool[] {
  return [new SearchFilesTool()]
}
