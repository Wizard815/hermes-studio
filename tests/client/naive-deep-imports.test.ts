import { resolve } from 'path'
import { describe, expect, it } from 'vitest'
import { naiveExportMap, rewriteNaiveImports } from '../../scripts/vite-naive-deep-imports'

const naive = naiveExportMap(resolve(__dirname, '../../node_modules/naive-ui/es/index.mjs'))
const dateFns = naiveExportMap(resolve(__dirname, '../../node_modules/date-fns/locale.js'))

describe('naive deep imports', () => {
  it('maps the names Studio imports to the modules that define them', () => {
    expect(naive.get('NButton')).toMatchObject({ imported: 'default' })
    expect(naive.get('NButton')!.file).toMatch(/naive-ui[\\/]es[\\/]button[\\/]src[\\/]Button\.mjs$/)
    expect(naive.get('useMessage')!.file).toMatch(/[\\/]message[\\/]/)
    expect(naive.get('darkTheme')!.file).toMatch(/[\\/]themes[\\/]/)
    expect(naive.get('dateEnUS')!.file).toMatch(/locales[\\/]date[\\/]enUS\.mjs$/)
    expect(dateFns.get('zhCN')!.file).toMatch(/date-fns[\\/]locale[\\/]zh-CN\.js$/)
  })

  it('rewrites multi-line, aliased and mixed type imports and keeps the line count', () => {
    const code = `import {\n  NButton,\n  NInput as TextBox,\n  type DataTableColumns,\n  useMessage,\n} from 'naive-ui'\nconst x = 1\n`
    const out = rewriteNaiveImports(code, naive)!
    expect(out).not.toMatch(/from 'naive-ui'[^\n]*NButton/)
    expect(out).toMatch(/import \{ default as NButton \} from '[^']*Button\.mjs'/)
    expect(out).toMatch(/default as TextBox/)
    expect(out).toContain(`import type { DataTableColumns } from 'naive-ui';`)
    expect(out.split('\n').length).toBe(code.split('\n').length)
    expect(out.split('\n')[6]).toBe('const x = 1')
  })

  it('leaves type-only imports, other packages and unknown names alone', () => {
    expect(rewriteNaiveImports(`import type { NLocale } from 'naive-ui'`, naive)).toBeNull()
    expect(rewriteNaiveImports(`import { ref } from 'vue'`, naive)).toBeNull()
    expect(rewriteNaiveImports(`import { NotARealExport } from 'naive-ui'`, naive)).toBeNull()
  })

  it('rewrites date-fns locale imports to the one locale', () => {
    const out = rewriteNaiveImports(`import { zhCN } from 'date-fns/locale';`, dateFns, 'date-fns/locale')!
    expect(out).toMatch(/import \{ zhCN \} from '[^']*zh-CN\.js';/)
  })
})
