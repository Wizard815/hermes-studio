import { afterAll, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HeadlessBrowserService } from '../../packages/server/src/modules/studio/services/headless-browser-service'

// Pin comments in the browser panel name the element under the pin (docs/pin-comments.md).
let service: HeadlessBrowserService | null = null
let dir = ''
afterAll(async () => {
  await service?.stop().catch(() => {})
  if (dir) await rm(dir, { recursive: true, force: true })
})

describe('TestBrowser_elementAt', () => {
  it('names the link, button or labelled element under a point of the viewport', async () => {
    dir = await mkdtemp(join(tmpdir(), 'element-at-'))
    service = new HeadlessBrowserService({ brokerRoot: dir })
    try { await service.start() } catch (error) { console.warn('No Chromium here, skipping:', error); return }
    const tab = [...(service as any).tabs.values()][0]
    await tab.page.setContent(`<style>body{margin:0} a,button{position:absolute;display:block;width:200px;height:100px}</style>
      <a id="docs" href="https://example.invalid/docs" style="left:0;top:0"><span>Read the docs</span></a>
      <main><button aria-label="Save settings" style="left:640px;top:360px">💾</button></main>`)
    expect(await service.elementAt(tab.id, 50 / 1280, 50 / 720)).toMatchObject({ tag: 'a', text: 'Read the docs', selector: '#docs', href: 'https://example.invalid/docs' })
    expect(await service.elementAt(tab.id, 700 / 1280, 400 / 720)).toMatchObject({ tag: 'button', name: 'Save settings', selector: 'main > button' })
    await expect(service.elementAt('nope', 0, 0)).rejects.toThrow('Tab not found')
  }, 60_000)
})
