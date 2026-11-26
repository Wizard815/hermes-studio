import type { FileEntry } from '@/api/studio/workspace-files'
import { getFilePreviewKind } from '@/utils/hermes/file-preview'

/** Files tab helpers (Roundup's file list), pure for the tests. */

const quote = (cell: string) => (/[",\n\r]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell)

/** Tab-separated text as CSV, so Studio's CSV table can show it. */
export function tsvToCsv(text: string): string {
  return String(text || '').replace(/\r\n/g, '\n').split('\n').map(line => line.split('\t').map(quote).join(',')).join('\n')
}

export function canPreview(name: string): boolean {
  return /\.tsv$/i.test(name) || getFilePreviewKind(name) !== null
}

/** Folders first, then by name; hidden files only when asked. */
export function sortEntries(entries: FileEntry[], options: { query?: string; hidden?: boolean } = {}): FileEntry[] {
  const query = (options.query || '').trim().toLowerCase()
  return entries
    .filter(entry => (options.hidden || !entry.name.startsWith('.')) && (!query || entry.name.toLowerCase().includes(query)))
    .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1))
}

/** The path's crumbs: [{ name, path }], the root first ('' = the chat's folder). */
export function crumbs(path: string, rootName: string): Array<{ name: string; path: string }> {
  const parts = String(path || '').split('/').filter(Boolean)
  return [{ name: rootName, path: '' }, ...parts.map((name, index) => ({ name, path: parts.slice(0, index + 1).join('/') }))]
}

export function parentPath(path: string): string {
  const parts = String(path || '').split('/').filter(Boolean)
  return parts.slice(0, -1).join('/')
}

export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
