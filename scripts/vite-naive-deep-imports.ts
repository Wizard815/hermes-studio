import { existsSync, readFileSync } from 'fs'
import { dirname, resolve } from 'path'
import type { Plugin } from 'vite'

/**
 * Studio imports Naive UI from its package root, which re-exports every
 * component. The bundler follows those re-exports from App.vue, so every
 * component any page uses (data tables, date pickers, trees, uploads...)
 * counts as needed by the first page and lands in one 290 KB (gzipped) chunk
 * that every page loads before it can draw.
 *
 * In builds, this plugin rewrites `import { NButton, useMessage } from
 * 'naive-ui'` in Studio's own sources to imports of the modules that define
 * those names. Each page then pulls only the components it uses, and
 * components used only by later pages load with those pages.
 */
export interface NaiveExport { file: string; imported: string }

const REEXPORT = /export\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g
const STAR = /export\s*\*\s*from\s*["']([^"']+)["']/g
const LOCAL = /export\s+(?:const|let|var|function\*?|class|async\s+function)\s+([A-Za-z_$][\w$]*)/g

function moduleFile(from: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null
  const file = resolve(dirname(from), specifier)
  return existsSync(file) ? file : null
}

/** Every runtime name the package root exports, and the module that defines it. */
export function naiveExportMap(rootIndex: string): Map<string, NaiveExport> {
  const map = new Map<string, NaiveExport>()
  const visited = new Set<string>()
  function walk(file: string) {
    if (visited.has(file)) return
    visited.add(file)
    const source = readFileSync(file, 'utf8')
    for (const [, list, specifier] of source.matchAll(REEXPORT)) {
      const target = moduleFile(file, specifier)
      for (const part of list.split(',').map(item => item.trim()).filter(Boolean)) {
        const [imported, exported = imported] = part.split(/\s+as\s+/).map(item => item.trim())
        if (map.has(exported)) continue
        // A bare package (vooks, vdirs) keeps its own specifier.
        map.set(exported, { file: target || specifier, imported })
      }
    }
    for (const [, name] of source.matchAll(LOCAL)) if (!map.has(name)) map.set(name, { file, imported: name })
    for (const [, specifier] of source.matchAll(STAR)) {
      const target = moduleFile(file, specifier)
      if (target) walk(target)
    }
  }
  walk(rootIndex)
  return map
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')

/** The rewritten source, or null when it has no runtime import from the barrel. */
export function rewriteNaiveImports(code: string, exports: Map<string, NaiveExport>, barrel = 'naive-ui'): string | null {
  let changed = false
  const pattern = new RegExp(`import\\s+(type\\s+)?\\{([^}]*)\\}\\s*from\\s*(["'])${escape(barrel)}\\3;?`, 'g')
  const result = code.replace(pattern, (whole, typeOnly: string | undefined, list: string, quote: string) => {
    if (typeOnly) return whole
    const byFile = new Map<string, string[]>()
    const kept: string[] = []
    for (const part of list.split(',').map(item => item.trim()).filter(Boolean)) {
      if (/^type\s/.test(part)) { kept.push(part.replace(/^type\s+/, '')); continue }
      const [name, local = name] = part.split(/\s+as\s+/).map(item => item.trim())
      const found = exports.get(name)
      if (!found) return whole
      const specifiers = byFile.get(found.file) || []
      specifiers.push(found.imported === local ? local : `${found.imported} as ${local}`)
      byFile.set(found.file, specifiers)
    }
    changed = true
    const lines = [...byFile].map(([file, names]) => `import { ${names.join(', ')} } from ${quote}${file}${quote};`)
    // Type-only names stay on the package root, where the types live; type imports vanish from the build.
    if (kept.length) lines.push(`import type { ${kept.join(', ')} } from ${quote}${barrel}${quote};`)
    // Keep the line count, so later lines keep their numbers in errors.
    return lines.join(' ') + '\n'.repeat((whole.match(/\n/g) || []).length)
  })
  return changed ? result : null
}

interface Barrel { specifier: string; index: string; applies(id: string): boolean }

export function naiveDeepImportsPlugin(packageRoot: string, dateFnsRoot = resolve(packageRoot, '../date-fns')): Plugin {
  const barrels: Barrel[] = [
    { specifier: 'naive-ui', index: resolve(packageRoot, 'es/index.mjs'), applies: id => !id.includes('/node_modules/') },
    // Naive UI's date locales each import one locale from date-fns's barrel of all of them.
    { specifier: 'date-fns/locale', index: resolve(dateFnsRoot, 'locale.js'), applies: id => id.includes('/naive-ui/es/locales/date/') },
  ]
  const maps = new Map<string, Map<string, NaiveExport>>()
  return {
    name: 'studio-naive-deep-imports',
    apply: 'build',
    enforce: 'pre',
    transform(code, id) {
      if (!/\.(vue|ts|tsx|js|mjs)(\?|$)/.test(id)) return null
      let result: string | null = null
      for (const barrel of barrels) {
        if (!barrel.applies(id) || !(result ?? code).includes(barrel.specifier)) continue
        if (!maps.has(barrel.index)) maps.set(barrel.index, naiveExportMap(barrel.index))
        result = rewriteNaiveImports(result ?? code, maps.get(barrel.index)!, barrel.specifier) ?? result
      }
      return result === null ? null : { code: result, map: null }
    },
  }
}
