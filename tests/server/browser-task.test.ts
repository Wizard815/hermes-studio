import { afterAll, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BrowserTaskRunner, type BrowserTaskState } from '../../packages/server/src/modules/studio/services/browser-task/service'
import { HeadlessBrowserService } from '../../packages/server/src/modules/studio/services/headless-browser-service'

// Browser tasks: browser-use drives the panel's own browser (docs/browser-tasks.md).
// A fake runner speaks the same JSON-lines protocol as bin/browser-use-task.py.
const FAKE_RUNNER = String.raw`
import json, os, signal, sys, time
req = json.loads(sys.stdin.read())
def out(e): print(json.dumps(e), flush=True)
out({"type": "started", "version": "fake"})
if req["task"] == "hang":
    signal.signal(signal.SIGTERM, lambda *a: (out({"type": "done", "status": "stopped", "error": "Stopped"}), sys.exit(130)))
    out({"type": "step", "n": 1, "text": "waiting"})
    time.sleep(30)
if req["task"] == "crash":
    sys.stderr.write("Traceback: boom\n"); sys.exit(3)
out({"type": "step", "n": 1, "text": 'new_tab("' + req["cdp_url"] + '")'})
out({"type": "step", "n": 2, "text": "key=" + os.environ.get("BROWSER_TASK_API_KEY", "") + " argv=" + " ".join(sys.argv[1:])})
out({"type": "done", "status": "completed", "success": True, "text": req["model"] + "@" + req["base_url"], "steps": 2, "cost_usd": 0.001, "error": None})
`

let dir = ''
let service: HeadlessBrowserService | null = null
afterAll(async () => {
  await service?.stop().catch(() => {})
  if (dir) await rm(dir, { recursive: true, force: true })
})

async function fakeRunner(): Promise<{ runner: BrowserTaskRunner; updates: BrowserTaskState[]; follow: boolean[] }> {
  dir ||= await mkdtemp(join(tmpdir(), 'browser-task-'))
  const script = join(dir, 'fake-runner.py')
  await writeFile(script, FAKE_RUNNER)
  const updates: BrowserTaskState[] = []
  const follow: boolean[] = []
  const runner = new BrowserTaskRunner({
    cdpUrl: async () => 'http://127.0.0.1:9',
    python: () => 'python3',
    script: () => script,
    resolveModel: async id => ({ id, model: 'qwen3-8b', baseUrl: 'http://argos.lan:8080/v1', apiKey: 'sk-secret' }),
    onUpdate: state => updates.push(state),
    setFollowTabs: on => follow.push(on),
  })
  return { runner, updates, follow }
}

async function until(check: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise(r => setTimeout(r, 25))
  }
}

describe('TestBrowserTask_runner', () => {
  it('runs a task, reports its steps and result, and passes the key by environment only', async () => {
    const { runner, updates, follow } = await fakeRunner()
    const started = await runner.start({ task: 'Find the heading', model: 'argos/qwen3-8b' })
    expect(started.status).toBe('running')
    await until(() => runner.state()?.status !== 'running')
    const done = runner.state()!
    expect(done).toMatchObject({ status: 'completed', success: true, result: 'qwen3-8b@http://argos.lan:8080/v1', costUsd: 0.001, model: 'argos/qwen3-8b' })
    expect(done.steps.map(s => s.text)).toEqual(['new_tab("http://127.0.0.1:9")', 'key=sk-secret argv='])
    expect(updates.at(-1)?.status).toBe('completed')
    expect(follow).toEqual([true, false])
  })

  it('refuses a second task while one runs, and stops a running task', async () => {
    const { runner } = await fakeRunner()
    await runner.start({ task: 'hang', model: 'm' })
    await until(() => (runner.state()?.steps.length ?? 0) > 0)
    await expect(runner.start({ task: 'again', model: 'm' })).rejects.toThrow('already running')
    runner.stop()
    await until(() => runner.state()?.status !== 'running')
    expect(runner.state()?.status).toBe('stopped')
  })

  it('says why when the runner dies, and checks the request', async () => {
    const { runner } = await fakeRunner()
    await expect(runner.start({ task: '  ', model: 'm' })).rejects.toThrow('Say what the browser should do')
    await expect(runner.start({ task: 'x', model: '' })).rejects.toThrow('Pick a model')
    await runner.start({ task: 'crash', model: 'm' })
    await until(() => runner.state()?.status !== 'running')
    expect(runner.state()).toMatchObject({ status: 'error' })
    expect(runner.state()?.error).toContain('exit 3')
    expect(runner.state()?.error).toContain('boom')
  })
})

describe('TestBrowserTask_sharedBrowser', () => {
  it('gives the panel browser a loopback DevTools endpoint whose new tabs become panel tabs', async () => {
    dir ||= await mkdtemp(join(tmpdir(), 'browser-task-'))
    service = new HeadlessBrowserService({ brokerRoot: dir })
    try { await service.start() } catch (error) { console.warn('No Chromium here, skipping:', error); return }
    const cdp = await service.cdpUrl()
    expect(cdp).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    const version = await (await fetch(`${cdp}/json/version`)).json()
    expect(version.webSocketDebuggerUrl).toContain('ws://127.0.0.1')
    const before = service.getAllTabs().length
    service.followNewTabs = true
    // What browser-use does: open a tab over CDP.
    const opened = await (await fetch(`${cdp}/json/new?about:blank`, { method: 'PUT' })).json()
    expect(opened.id).toBeTruthy()
    await until(() => service!.getAllTabs().length === before + 1)
    expect(service.activeTabId).toBe(service.getAllTabs().at(-1)!.id)
    // Pin comments still read the element under a spot on the tab the task opened.
    const tab = service.getAllTabs().at(-1)!
    await tab.page.setContent('<button style="position:absolute;left:0;top:0;width:300px;height:200px">Pay later</button>')
    expect(await service.elementAt(tab.id, 0.05, 0.05)).toMatchObject({ tag: 'button', text: 'Pay later' })
  }, 60_000)
})
