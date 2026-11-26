/**
 * Bytes a terminal sends for a herdr key combo, so Studio buttons can press
 * herdr's keys (prefix mode, then the action key). Returns null for combos a
 * terminal cannot express plainly (cmd/super, unknown names); such buttons hide.
 */
const NAMED: Record<string, string> = { space: ' ', enter: '\r', tab: '\t', esc: '\x1b', escape: '\x1b', backspace: '\x7f' }

export function comboBytes(combo: string): string | null {
  const parts = combo.trim().toLowerCase().split('+').filter(Boolean)
  if (!parts.length) return null
  // "?" and "+" can be the key itself.
  let base = parts.pop()!
  if (combo.trim().endsWith('++')) base = '+'
  const mods = new Set(parts)
  if (mods.has('cmd') || mods.has('super') || mods.has('prefix')) return null
  let key = NAMED[base] ?? (base.length === 1 ? base : null)
  if (key == null) return null
  if (mods.has('shift')) key = key.toUpperCase()
  if (mods.has('ctrl')) {
    if (base === 'space') key = '\x00'
    else if (/^[a-z]$/.test(base)) key = String.fromCharCode(base.charCodeAt(0) - 96)
    else if (base === '[') key = '\x1b'
    else if (base === '\\') key = '\x1c'
    else if (base === ']') key = '\x1d'
    else return null
  }
  return mods.has('alt') ? `\x1b${key}` : key
}

/** `prefix+g` with prefix `ctrl+b` → "\x02g"; a combo without prefix is sent as is. */
export function herdrKeyBytes(combo: string, prefix: string): string | null {
  const value = combo.trim()
  if (!value) return null
  if (!/^prefix\+/i.test(value)) return comboBytes(value)
  const lead = comboBytes(prefix)
  const rest = comboBytes(value.replace(/^prefix\+/i, ''))
  return lead != null && rest != null ? lead + rest : null
}
