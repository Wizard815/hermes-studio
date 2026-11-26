import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'
import AdmZip from 'adm-zip'
import * as tar from 'tar'
import { isChatSourceFile } from './guard'
import { ChatImportError, type ChatImportLimits } from './types'

export type ArchiveFormat = 'zip' | 'tar'

export function archiveFormat(name: string): ArchiveFormat | null {
  const lower = name.toLowerCase()
  if (lower.endsWith('.zip')) return 'zip'
  if (lower.endsWith('.tar') || lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) return 'tar'
  return null
}

function unsafe(): ChatImportError {
  return new ChatImportError('The archive has a file path that points outside it, so it was not opened', 400, 'chat_import_unsafe_archive')
}

/** Archive entry path as safe segments; refuses absolute paths, drive letters and `..`. */
export function safeEntrySegments(value: string): string[] {
  const path = String(value || '').replace(/\\/g, '/')
  if (!path || path.startsWith('/') || /^[a-zA-Z]:/.test(path) || path.includes('\0')) throw unsafe()
  const segments = path.split('/').filter(segment => segment.length > 0 && segment !== '.')
  if (!segments.length || segments.some(segment => segment === '..')) throw unsafe()
  return segments
}

function within(target: string, root: string): boolean {
  const rel = relative(root, target)
  return !!rel && !rel.startsWith('..') && !rel.startsWith(sep) && !resolve(root, rel).startsWith('..')
}

export interface ExtractResult {
  files: number
  bytes: number
  /** Entries left out: credentials, links, everything that is not a chat source. */
  skipped: number
}

/**
 * Unpack only chat sources (Hermes state.db, JSONL transcripts) from an
 * uploaded archive. Credential files and links are never written; unsafe
 * paths, too many entries or too many bytes refuse the whole archive.
 */
export async function extractChatArchive(file: string, format: ArchiveFormat, into: string, limits: Pick<ChatImportLimits, 'maxArchiveBytes' | 'maxArchiveEntries' | 'maxFileBytes'>): Promise<ExtractResult> {
  const root = resolve(into)
  const result: ExtractResult = { files: 0, bytes: 0, skipped: 0 }
  let entries = 0
  const count = (size: number) => {
    entries += 1
    if (entries > limits.maxArchiveEntries) throw new ChatImportError(`The archive has more than ${limits.maxArchiveEntries} files`, 413, 'chat_import_too_large')
    result.bytes += Math.max(0, size)
    if (result.bytes > limits.maxArchiveBytes) throw new ChatImportError('The archive unpacks to more than the size limit', 413, 'chat_import_too_large')
  }

  if (format === 'zip') {
    let zip: AdmZip
    try { zip = new AdmZip(file) } catch { throw new ChatImportError('Could not read the ZIP file', 400, 'chat_import_bad_archive') }
    for (const entry of zip.getEntries()) {
      const segments = safeEntrySegments(entry.entryName)
      const target = resolve(root, ...segments)
      if (!within(target, root)) throw unsafe()
      if (entry.isDirectory) continue
      const size = Number(entry.header.size) || 0
      count(size)
      const unixType = (Number(entry.attr) >>> 16) & 0o170000
      const regular = unixType === 0 || unixType === 0o100000
      if (!regular || !isChatSourceFile(segments.join('/')) || size > limits.maxFileBytes) { result.skipped += 1; continue }
      const data = entry.getData()
      if (data.length > limits.maxFileBytes) { result.skipped += 1; continue }
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, data, { flag: 'wx' })
      result.files += 1
    }
    return result
  }

  try {
    await tar.list({
      file,
      strict: true,
      onReadEntry: entry => {
        const segments = safeEntrySegments(entry.path)
        if (!within(resolve(root, ...segments), root)) throw unsafe()
        if (entry.type !== 'Directory') count(Number(entry.size) || 0)
      },
    })
  } catch (error) {
    if (error instanceof ChatImportError) throw error
    throw new ChatImportError('Could not read the tar file', 400, 'chat_import_bad_archive')
  }
  try {
    await tar.extract({
      file,
      cwd: root,
      strict: true,
      preservePaths: false,
      filter: (path, entry) => {
        const type = 'type' in entry ? entry.type : ''
        if (type === 'Directory') return true
        const keep = (type === 'File' || type === 'OldFile') && isChatSourceFile(path) && (Number((entry as any).size) || 0) <= limits.maxFileBytes
        if (keep) result.files += 1
        else result.skipped += 1
        return keep
      },
    })
  } catch {
    throw new ChatImportError('Could not unpack the tar file', 400, 'chat_import_bad_archive')
  }
  return result
}
