import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The page as Markdown for models that read text rather than images
 * (ekko_studio_browser_read_page). Microsoft's markitdown does the conversion
 * when it is installed on this host (or runs through uvx), the same tool
 * Studio uses for attachments (docs/markitdown.md). Without it a small
 * built-in converter keeps headings, links, lists, tables and text.
 */

export const MARKITDOWN_VERSION = '0.1.9'
const TIMEOUT_MS = 60_000

const run = (command, args) => new Promise((resolve, reject) => {
  execFile(command, args, { timeout: TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 }, (error, stdout) => error ? reject(error) : resolve(String(stdout)))
})

let resolved = null
/** `markitdown`, else `uvx` with the pinned version; null when neither runs. Off with STUDIO_MARKITDOWN=0. */
export function markitdownCommand(runner = run, env = process.env) {
  if (/^(0|false|no|off)$/i.test(String(env.STUDIO_MARKITDOWN || '').trim())) return Promise.resolve(null)
  resolved ||= (async () => {
    for (const candidate of [
      { command: 'markitdown', prefix: [] },
      { command: 'uvx', prefix: ['--from', `markitdown[all]==${MARKITDOWN_VERSION}`, 'markitdown'] },
    ]) {
      try {
        await runner(candidate.command, [...candidate.prefix, '--version'])
        return candidate
      } catch { /* try the next one */ }
    }
    return null
  })()
  return resolved
}
export function forgetMarkitdownCommand() { resolved = null }

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', copy: '©', reg: '®', trade: '™' }
function decode(text) {
  return text.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (whole, code) => {
    if (code[0] === '#') {
      const value = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10)
      return Number.isFinite(value) && value > 0 && value < 0x110000 ? String.fromCodePoint(value) : whole
    }
    return ENTITIES[code.toLowerCase()] ?? whole
  })
}

const inline = text => decode(text.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim()

function absolute(href, base) {
  try { return new URL(decode(href), base || undefined).href } catch { return decode(href) }
}

/** A plain converter for when markitdown is missing: structure over fidelity. */
export function htmlToMarkdownBasic(html, baseUrl = '') {
  let text = String(html || '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|template|svg|canvas|iframe|head)\b[\s\S]*?<\/\1\s*>/gi, '')
  text = text.replace(/<title\b[\s\S]*?<\/title>/gi, '')
  // Tables: one Markdown row per <tr>, a separator after the first.
  text = text.replace(/<table\b[\s\S]*?<\/table\s*>/gi, table => {
    const rows = [...table.matchAll(/<tr\b[\s\S]*?<\/tr\s*>/gi)].map(row =>
      [...row[0].matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]\s*>/gi)].map(cell => inline(cell[1]).replace(/\|/g, '\\|')))
      .filter(cells => cells.length)
    if (!rows.length) return '\n'
    const width = Math.max(...rows.map(cells => cells.length))
    const line = cells => `| ${[...cells, ...Array(width - cells.length).fill('')].join(' | ')} |`
    return `\n\n${[line(rows[0]), line(Array(width).fill('---')), ...rows.slice(1).map(line)].join('\n')}\n\n`
  })
  text = text
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi, (_, level, body) => `\n\n${'#'.repeat(Number(level))} ${inline(body)}\n\n`)
    .replace(/<a\b[^>]*?href\s*=\s*("([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a\s*>/gi, (whole, _q, dq, sq, body) => {
      const label = inline(body)
      const href = dq ?? sq ?? ''
      if (!label || /^javascript:/i.test(href)) return label
      return `[${label}](${absolute(href, baseUrl)})`
    })
    .replace(/<img\b[^>]*?alt\s*=\s*("([^"]*)"|'([^']*)')[^>]*>/gi, (_, _q, dq, sq) => (dq ?? sq) ? `![${decode(dq ?? sq)}]` : '')
    .replace(/<(button)\b[^>]*>([\s\S]*?)<\/button\s*>/gi, (_, _tag, body) => inline(body) ? `[button: ${inline(body)}]` : '')
    .replace(/<input\b([^>]*)>/gi, (_, attrs) => {
      const attr = name => (attrs.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i')) || [])
      const type = (attr('type')[2] ?? attr('type')[3] ?? 'text').toLowerCase()
      if (['hidden', 'password'].includes(type)) return type === 'password' ? '[password field]' : ''
      const label = attr('aria-label')[2] ?? attr('placeholder')[2] ?? attr('name')[2] ?? ''
      return `[${type} field${label ? `: ${decode(label)}` : ''}]`
    })
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi, (_, _tag, body) => inline(body) ? `**${inline(body)}**` : '')
    .replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi, (_, _tag, body) => inline(body) ? `*${inline(body)}*` : '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(p|div|section|article|main|header|footer|nav|aside|ul|ol|form|fieldset|figure|blockquote|pre|dl|dt|dd|tr)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
  return decode(text)
    .split('\n')
    .map(line => line.replace(/[ \t\f\v ]+/g, ' ').trim())
    .reduce((lines, line) => {
      if (line || (lines.length && lines[lines.length - 1])) lines.push(line)
      return lines
    }, [])
    .join('\n')
    .trim()
}

/** Relative Markdown links and images made absolute, so a model can open them. */
export function absoluteLinks(markdown, baseUrl) {
  if (!baseUrl) return markdown
  return markdown.replace(/(\]\()([^)\s]+)/g, (whole, open, href) =>
    /^(?:[a-z][a-z\d+.-]*:|#)/i.test(href) ? whole : `${open}${absolute(href, baseUrl)}`)
}

/**
 * Markdown for a page's HTML. Uses markitdown when it runs here, else the
 * built-in converter. Never throws.
 */
export async function pageMarkdown(html, { url = '', runner = run, env = process.env } = {}) {
  const command = await markitdownCommand(runner, env).catch(() => null)
  if (command) {
    let dir = ''
    try {
      dir = await mkdtemp(join(tmpdir(), 'studio-page-'))
      const file = join(dir, 'page.html')
      await writeFile(file, String(html))
      const markdown = String(await runner(command.command, [...command.prefix, file])).trim()
      if (markdown) return { markdown: absoluteLinks(markdown, url), converter: 'markitdown' }
    } catch { /* fall back below */ } finally {
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  }
  return { markdown: htmlToMarkdownBasic(html, url), converter: 'built-in' }
}
