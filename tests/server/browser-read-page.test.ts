import { afterAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { HeadlessBrowserService } from '../../packages/server/src/modules/studio/services/headless-browser-service'
// @ts-expect-error plain .mjs module without types
import { absoluteLinks, forgetMarkitdownCommand, htmlToMarkdownBasic, markitdownCommand, pageMarkdown } from '../../bin/browser/page-markdown.mjs'

// ekko_studio_browser_read_page: the page as Markdown, for models that read text.
const PAGE = `<html><head><title>Shop</title><style>.x{color:red}</style><script>var secret = 1</script><!-- note --></head><body>
<nav><a href="/">Home</a> <a href="/cart">Cart (2)</a></nav>
<main><h1>Blue kettle</h1><p>A <b>fast</b> kettle that boils in <a href="/spec?x=1&amp;y=2">2 minutes</a>. Great for tea.</p>
<h2>Details</h2><ul><li>1.7 litres</li><li>Steel</li></ul>
<table><tr><th>Size</th><th>Price</th></tr><tr><td>Small</td><td>$20</td></tr></table>
<label>Qty <input name="qty" value="1"></label><input type="password" name="pw" value="hunter2"><p>api_key=abc123</p><button>Add to cart</button><img alt="Kettle photo" src="k.png">
<a href="javascript:void 0">Do it</a></main></body></html>`

let panel: HeadlessBrowserService | null = null
let tools: { stop(): Promise<void> } | null = null
let server: Server | null = null
const dirs: string[] = []
afterAll(async () => {
  await tools?.stop().catch(() => {})
  await panel?.stop().catch(() => {})
  server?.close()
  for (const dir of dirs) await rm(dir, { recursive: true, force: true })
})

describe('TestBrowser_readPageMarkdown', () => {
  it('the built-in converter keeps headings, links, lists, tables and fields, and drops scripts', () => {
    const md = htmlToMarkdownBasic(PAGE, 'http://shop.test/item')
    expect(md).toContain('# Blue kettle')
    expect(md).toContain('## Details')
    expect(md).toContain('[Cart (2)](http://shop.test/cart)')
    expect(md).toContain('[2 minutes](http://shop.test/spec?x=1&y=2)')
    expect(md).toContain('**fast**')
    expect(md).toMatch(/- 1\.7 litres\n- Steel/)
    expect(md).toContain('| Size | Price |\n| --- | --- |\n| Small | $20 |')
    expect(md).toContain('[text field: qty]')
    expect(md).toContain('[password field]')
    expect(md).toContain('[button: Add to cart]')
    expect(md).toContain('![Kettle photo]')
    expect(md).toContain('Do it')
    expect(md).not.toMatch(/javascript:|secret|color:red/)
  })

  it('makes relative links absolute and leaves absolute ones and anchors alone', () => {
    expect(absoluteLinks('[a](/x) [b](https://o.test/y) [c](#top) ![i](img.png)', 'http://s.test/dir/page'))
      .toBe('[a](http://s.test/x) [b](https://o.test/y) [c](#top) ![i](http://s.test/dir/img.png)')
  })

  it('falls back to the built-in converter when markitdown is off or fails', async () => {
    forgetMarkitdownCommand()
    expect(await markitdownCommand(undefined, { STUDIO_MARKITDOWN: '0' })).toBeNull()
    const off = await pageMarkdown(PAGE, { url: 'http://shop.test/', env: { STUDIO_MARKITDOWN: '0' } })
    expect(off.converter).toBe('built-in')
    forgetMarkitdownCommand()
    const failing = async (_command: string, args: string[]) => { if (args.includes('--version')) return 'markitdown 0.1.9'; throw new Error('boom') }
    const failed = await pageMarkdown(PAGE, { url: 'http://shop.test/', runner: failing, env: {} })
    expect(failed.converter).toBe('built-in')
    expect(failed.markdown).toContain('# Blue kettle')
    forgetMarkitdownCommand()
  })

  it('reads a live page through the Browser Broker and converts it', async () => {
    server = createServer((_req, res) => { res.setHeader('content-type', 'text/html'); res.end(PAGE) })
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', () => resolve()))
    const origin = `http://127.0.0.1:${(server.address() as any).port}`
    const panelDir = await mkdtemp(join(tmpdir(), 'panel-')); dirs.push(panelDir)
    panel = new HeadlessBrowserService({ brokerRoot: panelDir })
    try { await panel.start() } catch (error) { console.warn('No Chromium here, skipping:', error); return }
    const { ScreenBrowserService } = await import('../../packages/server/src/modules/studio/services/screen-browser')
    const brokerDir = await mkdtemp(join(tmpdir(), 'tools-')); dirs.push(brokerDir)
    const service = new ScreenBrowserService({ brokerRoot: brokerDir, installed: async () => false })
    tools = service
    service.usePanelBrowser(() => panel!.devToolsPort())
    expect(await service.start()).toBe(true)
    const opened = (await service.request('run-1', { method: 'tabs.create', params: { url: `${origin}/item` } }) as any).result
    const tabId = opened.id || opened.tab?.id
    let page: any = null
    for (let i = 0; i < 50 && !page?.title; i++) {
      page = (await service.request('run-1', { method: 'page.html', params: { tab_id: tabId } }) as any).result
      if (!page?.title) await new Promise(resolve => setTimeout(resolve, 100))
    }
    expect(page).toMatchObject({ tabId, url: `${origin}/item`, title: 'Shop', truncated: false })
    expect(page.html).toContain('<h1>Blue kettle</h1>')
    expect(page.html).not.toMatch(/<script|var secret/)

    forgetMarkitdownCommand()
    const converted = await pageMarkdown(page.html, { url: page.url })
    expect(converted.markdown).toMatch(/# Blue kettle/)
    expect(converted.markdown).toContain(`(${origin}/cart)`)
    expect(converted.markdown).toMatch(/Small\s*\|\s*\$20/)
    expect(converted.markdown).toContain('redacted')
    expect(converted.markdown).not.toMatch(/hunter2|abc123/)
    console.log('converter:', converted.converter)
  }, 60_000)

  it('the MCP tool returns the page in parts and converts it once', async () => {
    const calls: string[] = []
    let url = 'http://shop.test/item'
    const long = PAGE.replace('</main>', `<p>${'Lorem ipsum dolor sit amet. '.repeat(300)}</p><p>THE END</p></main>`)
    const api = createServer((req, res) => {
      let body = ''
      req.on('data', chunk => { body += chunk })
      req.on('end', () => {
        const { method } = JSON.parse(body || '{}')
        calls.push(method)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        if (method === 'page.html') return res.end(JSON.stringify({ result: { tabId: 't1', url, title: 'Shop', html: long, totalLength: long.length, truncated: false } }))
        if (method === 'state') return res.end(JSON.stringify({ result: { tabs: [{ id: 't1', url }] } }))
        res.end(JSON.stringify({ result: {} }))
      })
    })
    await new Promise<void>(r => api.listen(0, '127.0.0.1', r))
    const home = await mkdtemp(join(tmpdir(), 'studio-mcp-')); dirs.push(home)
    const child = spawn(process.execPath, [resolve(__dirname, '../../bin/ekko-studio-mcp.mjs'), 'browser'], {
      env: { ...process.env, HERMES_WEB_UI_URL: `http://127.0.0.1:${(api.address() as any).port}`, HERMES_WEB_UI_TOKEN: 't', HERMES_WEB_UI_HOME: home, STUDIO_MARKITDOWN: '0' },
    })
    const waiting = new Map<number, (m: any) => void>()
    createInterface({ input: child.stdout }).on('line', line => { const m = JSON.parse(line); waiting.get(m.id)?.(m) })
    let id = 0
    const call = (args: unknown) => new Promise<any>(r => {
      const n = ++id
      waiting.set(n, m => r(JSON.parse(m.result.content[0].text)))
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: n, method: 'tools/call', params: { name: 'ekko_studio_browser_read_page', arguments: args } })}\n`)
    })
    try {
      const first = await call({ tab_id: 't1', max_chars: 2000 })
      expect(first).toMatchObject({ url, title: 'Shop', converter: 'built-in', offset: 0, returnedLength: 2000, hasMore: true, nextOffset: 2000 })
      expect(first.markdown).toContain('# Blue kettle')
      let part = first
      while (part.hasMore) part = await call({ tab_id: 't1', offset: part.nextOffset, max_chars: 50000 })
      expect(part.markdown).toContain('THE END')
      expect(calls.filter(m => m === 'page.html')).toHaveLength(1)

      // The tab moved on: a first read converts the new page.
      url = 'http://shop.test/other'
      await call({ tab_id: 't1' })
      expect(calls.filter(m => m === 'page.html')).toHaveLength(2)
      await call({ tab_id: 't1', fresh: true })
      expect(calls.filter(m => m === 'page.html')).toHaveLength(3)
    } finally {
      child.kill()
      api.close()
    }
  }, 30_000)
})
