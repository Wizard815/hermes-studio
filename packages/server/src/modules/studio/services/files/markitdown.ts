import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { rm, stat } from 'node:fs/promises'
import { extname } from 'node:path'
import { logger } from '../../public/logging'

/**
 * Markdown copies of attachments (docs/markitdown.md): when markitdown is on the
 * Studio host, an uploaded PDF, Office, HTML or EPUB file gets a `<file>.md`
 * next to it, and the chat tells the model to read that copy. Text-only models
 * can then read documents, and vision models get a text check of what they see.
 * Without markitdown nothing changes. Off with STUDIO_MARKITDOWN=0.
 */

export const MARKITDOWN_VERSION = '0.1.9'
export const MARKITDOWN_EXTENSIONS = new Set(['.pdf', '.docx', '.pptx', '.xlsx', '.xls', '.html', '.htm', '.epub', '.msg', '.ipynb', '.rtf', '.odt'])
const TIMEOUT_MS = 120_000
const MAX_INPUT_BYTES = 50 * 1024 * 1024

type Runner = (command: string, args: string[], timeout: number) => Promise<void>

const run: Runner = (command, args, timeout) => new Promise((resolve, reject) => {
  execFile(command, args, { timeout, maxBuffer: 1024 * 1024 }, error => error ? reject(error) : resolve())
})

export function markitdownEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !/^(0|false|no|off)$/i.test(String(env.STUDIO_MARKITDOWN || '').trim())
}

export const markdownCopyPath = (path: string) => `${path}.md`

export function wantsMarkdownCopy(path: string): boolean {
  return MARKITDOWN_EXTENSIONS.has(extname(path).toLowerCase())
}

/** `markitdown` when it is installed, else `uvx` with the pinned version; null when neither runs. */
let resolved: Promise<{ command: string; prefix: string[] } | null> | null = null
export function forgetMarkitdownCommand(): void { resolved = null }

function resolveCommand(runner: Runner): Promise<{ command: string; prefix: string[] } | null> {
  if (!resolved) {
    resolved = (async () => {
      for (const candidate of [
        { command: 'markitdown', prefix: [] as string[], probe: ['--version'] },
        { command: 'uvx', prefix: ['--from', `markitdown[all]==${MARKITDOWN_VERSION}`, 'markitdown'], probe: ['--version'] },
      ]) {
        try {
          await runner(candidate.command, [...candidate.prefix, ...candidate.probe], TIMEOUT_MS)
          logger.info('[markitdown] using %s', [candidate.command, ...candidate.prefix].join(' '))
          return { command: candidate.command, prefix: candidate.prefix }
        } catch { /* try the next one */ }
      }
      logger.info('[markitdown] not installed; attachments are passed as they are')
      return null
    })()
  }
  return resolved
}

/** Writes `<path>.md` for a document; returns its path, or null when there is none. Never throws. */
export async function writeMarkdownCopy(path: string, runner: Runner = run): Promise<string | null> {
  if (!markitdownEnabled() || !wantsMarkdownCopy(path)) return null
  try {
    if ((await stat(path)).size > MAX_INPUT_BYTES) return null
    const command = await resolveCommand(runner)
    if (!command) return null
    const out = markdownCopyPath(path)
    await runner(command.command, [...command.prefix, path, '-o', out], TIMEOUT_MS)
    if (!existsSync(out) || (await stat(out)).size === 0) {
      await rm(out, { force: true })
      return null
    }
    return out
  } catch (err: any) {
    logger.warn('[markitdown] could not convert %s: %s', path, String(err?.message || err).slice(0, 200))
    return null
  }
}

/** The line the model gets under an attached file when a Markdown copy exists. */
export function markdownCopyNote(path: string): string {
  const copy = markdownCopyPath(path)
  return wantsMarkdownCopy(path) && existsSync(copy) ? `\nMarkdown copy for reading: ${copy}` : ''
}
