import { buildSync } from 'esbuild'
import { basename, dirname, resolve } from 'path'
import type { Plugin } from 'vite'

/**
 * The feature message files in packages/client/src/i18n hold every language
 * in one object, and each locale file (i18n/locales/<lang>.ts) picks its own
 * entry. Bundled as they are, the first page load pulls all twelve languages
 * of every feature (about 1.5 MB of JavaScript) to show one.
 *
 * In builds, this plugin gives each locale file its own copy of those modules
 * holding only that locale's entries. A module whose exports are not plain
 * data (functions, classes) is left as it is.
 */
const LOCALE_QUERY = '?studio-locale='

function isPlainData(value: unknown, depth = 0): boolean {
  if (depth > 64) return false
  if (value === null) return true
  const type = typeof value
  if (type === 'string' || type === 'number' || type === 'boolean') return true
  if (Array.isArray(value)) return value.every(item => isPlainData(item, depth + 1))
  if (type !== 'object') return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  return Object.values(value as Record<string, unknown>).every(item => isPlainData(item, depth + 1))
}

function evaluateModule(file: string): Record<string, unknown> | null {
  const result = buildSync({
    entryPoints: [file],
    bundle: true,
    format: 'cjs',
    platform: 'neutral',
    write: false,
    logLevel: 'silent',
  })
  const module = { exports: {} as Record<string, unknown> }
  // The source is our own i18n data; evaluating it at build time is the point.
  new Function('module', 'exports', result.outputFiles[0].text)(module, module.exports)
  return module.exports
}

/** The locale's entry of a `{ en: {...}, de: {...} }` map; other exports unchanged. */
export function pickLocale(exports: Record<string, unknown>, locale: string): Record<string, unknown> | null {
  const picked: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(exports)) {
    if (!isPlainData(value)) return null
    const map = value as Record<string, unknown>
    picked[name] = map && typeof map === 'object' && !Array.isArray(map) && 'en' in map && locale in map
      ? { [locale]: map[locale] }
      : value
  }
  return picked
}

export function localeSplitPlugin(i18nDir: string): Plugin {
  const localesDir = resolve(i18nDir, 'locales')
  return {
    name: 'studio-locale-split',
    apply: 'build',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      if (!importer || dirname(importer) !== localesDir || !source.startsWith('../')) return null
      if (!/-(messages|locales)$/.test(source)) return null
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true })
      if (!resolved || dirname(resolved.id) !== i18nDir) return null
      const locale = basename(importer).replace(/\.ts$/, '')
      return `${resolved.id}${LOCALE_QUERY}${locale}`
    },
    load(id) {
      const at = id.indexOf(LOCALE_QUERY)
      if (at < 0) return null
      const file = id.slice(0, at)
      const locale = id.slice(at + LOCALE_QUERY.length)
      this.addWatchFile(file)
      const picked = pickLocale(evaluateModule(file) || {}, locale)
      // Not plain data: load the whole module for this locale as before.
      if (!picked) return `export * from ${JSON.stringify(file)}`
      return Object.entries(picked)
        .map(([name, value]) => `export const ${name} = ${JSON.stringify(value)}`)
        .join('\n')
    },
  }
}
