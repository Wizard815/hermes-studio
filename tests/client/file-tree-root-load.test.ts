import { readFileSync } from 'fs'
import { describe, expect, it } from 'vitest'

const source = () => readFileSync('packages/client/src/components/hermes/files/FileTree.vue', 'utf8')

describe('FileTree root loading', () => {
  it('surfaces a failed root listing instead of rendering an empty directory', () => {
    const src = source()
    const loadChildren = src.slice(src.indexOf('async function loadChildren'), src.indexOf('async function reloadRoot'))

    // A failed load must be distinguishable from "this directory has no files".
    expect(loadChildren).toContain('rootError.value')
    expect(loadChildren).toMatch(/catch \(error\)/)
    expect(loadChildren).toContain("console.error('[FileTree] failed to list'")
    // The old code swallowed the error entirely, which is what made a broken
    // workspace scope look like an empty folder.
    expect(loadChildren).not.toMatch(/}\s*catch\s*\{\s*\n\s*if \(!path\)/)
    expect(src).toContain('v-if="rootError"')
  })

  it('reloads the root when the workspace scope settles after the load started', () => {
    const src = source()
    const reloadRoot = src.slice(src.indexOf('async function reloadRoot'))

    // loadChildren picks its source from the store's *current* scope, which the
    // hosting panel sets — so the scope can change under a load already running.
    expect(reloadRoot).toContain('scopeAtStart')
    expect(reloadRoot).toContain('scopeNow')
    expect(reloadRoot).toMatch(/if \(scopeNow !== scopeAtStart\)/)
    // The stale-response guard must stay tied to the latest sequence.
    expect(reloadRoot).toContain('if (seq !== rootLoadSeq) return')
  })

  it('drives both root-refresh triggers through reloadRoot', () => {
    const src = source()
    const watchers = src.slice(src.indexOf("watch([effectiveProfile"), src.indexOf('</script>'))

    expect(watchers).toContain('await reloadRoot()')
    expect(watchers).toMatch(/\}, \{ immediate: true \}\)/)
    // Reloading must not be skipped when the workspace scope is already active.
    expect(watchers).toContain('if (!workspaceMode.value) return')
    // Both watchers still invalidate the rendered tree.
    expect(watchers.match(/treeInstanceKey\.value \+= 1/g)?.length).toBe(2)
  })
})
