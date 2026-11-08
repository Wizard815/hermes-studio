/** Formatting and history helpers for the System page. */

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']

export function formatBytes(bytes: number | null | undefined, digits = 1): string {
  if (bytes == null || !Number.isFinite(bytes)) return '–'
  let value = Math.max(0, bytes)
  let unit = 0
  while (value >= 1024 && unit < UNITS.length - 1) { value /= 1024; unit += 1 }
  return `${value.toFixed(unit === 0 ? 0 : digits)} ${UNITS[unit]}`
}

export function formatRate(bytesPerSec: number | null | undefined): string {
  return bytesPerSec == null ? '–' : `${formatBytes(bytesPerSec)}/s`
}

export function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`
}

/** Appends to a fixed-length history, dropping the oldest sample. */
export function pushHistory(history: number[], value: number, size = 60): number[] {
  const next = [...history, Number.isFinite(value) ? value : 0]
  return next.length > size ? next.slice(next.length - size) : next
}

export type ProcessSortKey = 'cpuPercent' | 'memRssBytes' | 'pid' | 'name'

export function sortProcesses<T extends { cpuPercent: number; memRssBytes: number; pid: number; name: string; command: string; user: string }>(
  list: T[], key: ProcessSortKey, descending: boolean, filter = '',
): T[] {
  const needle = filter.trim().toLowerCase()
  const rows = needle
    ? list.filter(p => p.name.toLowerCase().includes(needle) || p.command.toLowerCase().includes(needle) || String(p.pid) === needle || p.user.toLowerCase() === needle)
    : [...list]
  const sign = descending ? -1 : 1
  return rows.sort((a, b) => {
    const order = key === 'name' ? a.name.localeCompare(b.name) : (a[key] as number) - (b[key] as number)
    return order * sign || a.pid - b.pid
  })
}
