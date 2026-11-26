// Test Lab runner (docs/test-lab.md). Runs inside the run's own container, on
// the run's private Docker network, with no internet. Studio mounts:
//   /lab/runner.mjs  this file (read-only)
//   /out             progress.jsonl, report.md, report.json, screenshots/
//   /tunnel/lab.sock Studio's model gateway (chat completions only; Studio adds the run's key)
// Steps: wait for each app's health check, run its seed steps, take a picture of
// each app, then one agent (a tool loop on the pinned model) with a browser and
// HTTP tools limited to the apps, which ends by writing the report.
// Plain Node (24+), no packages: the container's files are read-only.
import { request } from 'node:http'
import { mkdirSync, appendFileSync, writeFileSync } from 'node:fs'
import { lookup } from 'node:dns/promises'
import { join } from 'node:path'

const env = process.env
const OUT = env.LAB_OUT || '/out'
const SOCKET = env.LAB_TUNNEL || '/tunnel/lab.sock'
const MODEL = env.LAB_MODEL || ''
const MAX_STEPS = Math.max(1, Math.min(200, Number(env.LAB_MAX_STEPS) || 40))
const APPS = JSON.parse(env.LAB_APPS || '[]')
const INSTRUCTIONS = env.LAB_INSTRUCTIONS || 'Open each app, use its main pages and report what works and what does not.'
const BROWSER = env.LAB_BROWSER || ''
const SHOTS = join(OUT, 'screenshots')
mkdirSync(SHOTS, { recursive: true })

function emit(event) {
  appendFileSync(join(OUT, 'progress.jsonl'), `${JSON.stringify({ at: Date.now(), ...event })}\n`)
}
const sleep = ms => new Promise(done => setTimeout(done, ms))
const short = (text, max = 4000) => { const value = String(text ?? ''); return value.length > max ? `${value.slice(0, max)}…` : value }

// --- seed variables ---------------------------------------------------------------

export function fill(value, vars) {
  if (typeof value === 'string') return value.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_, name) => vars[name] ?? '')
  if (Array.isArray(value)) return value.map(item => fill(item, vars))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fill(item, vars)]))
  return value
}

export function pick(json, path) {
  return String(path).split('.').reduce((value, key) => value == null ? undefined : value[key], json)
}

// --- apps: health and seed ----------------------------------------------------------

async function waitHealthy(app) {
  const deadline = Date.now() + (app.health?.timeoutSeconds || 180) * 1000
  const expect = app.health?.expect || []
  const url = app.baseUrl + (app.health?.path || '/')
  const started = Date.now()
  let last = ''
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(5000) })
      const ok = expect.length ? expect.includes(res.status) : res.status >= 200 && res.status < 400
      if (ok) { emit({ type: 'health', app: app.id, ok: true, status: res.status, ms: Date.now() - started }); return true }
      last = `answered ${res.status}`
    } catch (error) { last = error?.cause?.code || error?.message || String(error) }
    await sleep(2000)
  }
  emit({ type: 'health', app: app.id, ok: false, error: `${url} did not answer in time (${last})` })
  return false
}

async function seed(app) {
  const vars = { baseUrl: app.baseUrl, host: app.id }
  for (const step of app.seed || []) {
    const headers = fill(step.headers || {}, vars)
    let body
    if (step.json !== undefined) { body = JSON.stringify(fill(step.json, vars)); headers['content-type'] ||= 'application/json' }
    else if (step.form) { body = new URLSearchParams(fill(step.form, vars)).toString(); headers['content-type'] ||= 'application/x-www-form-urlencoded' }
    let status = 0
    try {
      const res = await fetch(app.baseUrl + fill(step.path, vars), { method: step.method || 'GET', headers, body, redirect: 'manual', signal: AbortSignal.timeout(30000) })
      status = res.status
      const text = await res.text()
      const ok = (step.expect?.length ? step.expect.includes(status) : status >= 200 && status < 300)
      if (!ok) throw new Error(`answered ${status}: ${short(text, 300)}`)
      let json
      try { json = JSON.parse(text) } catch { json = undefined }
      for (const [name, path] of Object.entries(step.save || {})) {
        vars[name] = String(path).startsWith('header:') ? res.headers.get(String(path).slice(7)) ?? '' : String(pick(json, path) ?? '')
      }
      emit({ type: 'seed', app: app.id, step: step.name, ok: true, status })
    } catch (error) {
      emit({ type: 'seed', app: app.id, step: step.name, ok: false, status, optional: !!step.optional, error: short(error?.message || error, 400) })
      if (!step.optional) return false
    }
  }
  return true
}

// --- browser: Chrome DevTools Protocol over Node's WebSocket -------------------------

class Browser {
  constructor() { this.id = 0; this.pending = new Map(); this.events = [] }
  async open() {
    const [host, port = '9222'] = BROWSER.split(':')
    // Chrome only answers /json for an IP or localhost Host header.
    const { address } = await lookup(host, { family: 4 })
    const base = `http://${address}:${port}`
    let target
    for (let i = 0; i < 30 && !target; i++) {
      try { target = await (await fetch(`${base}/json/new?about:blank`, { method: 'PUT' })).json() } catch { await sleep(1000) }
    }
    if (!target?.webSocketDebuggerUrl) throw new Error(`The browser at ${BROWSER} did not answer`)
    this.ws = new WebSocket(target.webSocketDebuggerUrl.replace(/\/\/[^/]+/, `//${address}:${port}`))
    await new Promise((resolve, reject) => { this.ws.onopen = resolve; this.ws.onerror = () => reject(new Error('Could not connect to the browser')) })
    this.ws.onmessage = message => {
      const data = JSON.parse(String(message.data))
      if (data.id && this.pending.has(data.id)) {
        const { resolve, reject } = this.pending.get(data.id)
        this.pending.delete(data.id)
        if (data.error) reject(new Error(data.error.message)); else resolve(data.result)
      } else if (data.method) this.events.push(data.method)
    }
    await this.send('Page.enable')
    await this.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false })
  }
  send(method, params = {}) {
    const id = ++this.id
    this.ws.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      setTimeout(() => { if (this.pending.delete(id)) reject(new Error(`${method} timed out`)) }, 30000)
    })
  }
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || 'Script failed')
    return result.result?.value
  }
  async settle() {
    for (let i = 0; i < 20; i++) {
      await sleep(250)
      try { if (await this.evaluate('document.readyState') === 'complete') break } catch { /* navigating */ }
    }
    await sleep(500)
  }
  async goto(url) { await this.send('Page.navigate', { url }); await this.settle(); return this.snapshot() }
  async snapshot() {
    return this.evaluate(`(() => {
      let n = 0
      const items = []
      for (const el of document.querySelectorAll('a[href], button, input, select, textarea, [role="button"], [role="link"], [role="menuitem"], [role="tab"], summary')) {
        const box = el.getBoundingClientRect()
        if (!box.width || !box.height || getComputedStyle(el).visibility === 'hidden') continue
        const id = String(++n)
        el.setAttribute('data-lab-id', id)
        const label = (el.getAttribute('aria-label') || el.innerText || el.value || el.placeholder || el.name || el.getAttribute('href') || '').trim().replace(/\\s+/g, ' ').slice(0, 80)
        items.push(id + ' ' + el.tagName.toLowerCase() + (el.type ? '[' + el.type + ']' : '') + ' ' + label)
        if (n >= 150) break
      }
      const text = (document.body?.innerText || '').replace(/\\n{3,}/g, '\\n\\n').slice(0, 3000)
      return 'URL: ' + location.href + '\\nTitle: ' + document.title + '\\n\\nText:\\n' + text + '\\n\\nElements (id tag label):\\n' + items.join('\\n')
    })()`)
  }
  async click(id) {
    const done = await this.evaluate(`(() => { const el = document.querySelector('[data-lab-id="${Number(id)}"]'); if (!el) return false; el.scrollIntoView({ block: 'center' }); el.click(); return true })()`)
    if (!done) return `No element ${id}: take a new snapshot`
    await this.settle()
    return this.snapshot()
  }
  async type(id, text, submit) {
    const done = await this.evaluate(`(() => {
      const el = document.querySelector('[data-lab-id="${Number(id)}"]'); if (!el) return false
      el.focus()
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
      Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, ${JSON.stringify(String(text))})
      el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }))
      if (${submit ? 'true' : 'false'}) { if (el.form) el.form.requestSubmit ? el.form.requestSubmit() : el.form.submit(); else el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) }
      return true
    })()`)
    if (!done) return `No element ${id}: take a new snapshot`
    await this.settle()
    return this.snapshot()
  }
  async screenshot(name) {
    const file = `${String(name || 'shot').replace(/[^\w.-]+/g, '-').slice(0, 60) || 'shot'}.png`
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(SHOTS, file), Buffer.from(data, 'base64'))
    emit({ type: 'screenshot', file })
    return file
  }
}

// --- model: Studio's gateway over the mounted socket -----------------------------------

function chat(body) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body))
    const req = request({ socketPath: SOCKET, method: 'POST', path: '/v1/chat/completions', headers: { 'content-type': 'application/json', 'content-length': payload.length }, timeout: 300000 }, res => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let json
        try { json = JSON.parse(text) } catch { json = undefined }
        if (res.statusCode >= 400) reject(Object.assign(new Error(json?.error?.message || short(text, 500) || `Gateway answered ${res.statusCode}`), { status: res.statusCode }))
        else resolve(json)
      })
    })
    req.on('timeout', () => req.destroy(new Error('The model did not answer in 5 minutes')))
    req.on('error', reject)
    req.end(payload)
  })
}

const TOOLS = [
  { name: 'browser_open', description: 'Open a URL in the browser (only the apps listed). Returns the page text and its numbered elements.', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
  { name: 'browser_snapshot', description: 'The current page text and its numbered elements.', parameters: { type: 'object', properties: {} } },
  { name: 'browser_click', description: 'Click an element by its number from the last snapshot.', parameters: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] } },
  { name: 'browser_type', description: 'Type text into an input by its number; submit=true presses Enter / submits the form.', parameters: { type: 'object', properties: { id: { type: 'integer' }, text: { type: 'string' }, submit: { type: 'boolean' } }, required: ['id', 'text'] } },
  { name: 'browser_screenshot', description: 'Save a screenshot of the current page for the report.', parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
  { name: 'http_request', description: 'An HTTP request to one of the apps (their API). Returns status and the start of the body.', parameters: { type: 'object', properties: { method: { type: 'string' }, url: { type: 'string' }, headers: { type: 'object' }, body: { type: 'string' } }, required: ['method', 'url'] } },
  { name: 'report', description: 'Finish: the result of each check. Call it once, at the end.', parameters: { type: 'object', properties: {
    summary: { type: 'string' },
    checks: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, result: { type: 'string', enum: ['pass', 'fail', 'skip'] }, detail: { type: 'string' } }, required: ['name', 'result'] } },
  }, required: ['summary', 'checks'] } },
].map(fn => ({ type: 'function', function: fn }))

export function allowedUrl(url, apps = APPS) {
  try {
    const target = new URL(url)
    return apps.some(app => new URL(app.baseUrl).origin === target.origin)
  } catch { return false }
}

export function reportMarkdown(summary, checks) {
  const mark = { pass: 'PASS', fail: 'FAIL', skip: 'SKIP' }
  const lines = ['# Test Lab report', '', '## Summary', '', String(summary || '').trim() || '(none)', '', '## Checks', '']
  for (const check of checks || []) {
    const result = mark[String(check.result).toLowerCase()] || 'SKIP'
    const detail = String(check.detail || '').replace(/\s+/g, ' ').trim()
    lines.push(`- [${result}] ${String(check.name || '').replace(/\s+/g, ' ').trim()}${detail ? ` — ${detail}` : ''}`)
  }
  return `${lines.join('\n')}\n`
}

function writeReport(summary, checks, extra = {}) {
  writeFileSync(join(OUT, 'report.md'), reportMarkdown(summary, checks))
  writeFileSync(join(OUT, 'report.json'), JSON.stringify({ summary, checks, ...extra }, null, 2))
}

async function agent(browser) {
  const lines = APPS.map(app => [
    `- ${app.name}: ${app.baseUrl}`,
    ...(app.logins || []).map(login => `  login: ${login.username} / ${login.password}${login.role ? ` (${login.role})` : ''}`),
    ...(app.notes ? [`  notes: ${app.notes}`] : []),
    ...(app.seedFailed ? ['  (its test data could not be fully created)'] : []),
  ].join('\n'))
  const messages = [
    { role: 'system', content: [
      'You are a careful QA tester. You test web apps that run in a throwaway lab: everything here is test data.',
      'Use only the tools. browser_* drives one browser tab; http_request calls the apps\' APIs. Only the URLs below can be reached.',
      'Take a screenshot when something fails or looks wrong. Do not repeat the same action over and over.',
      'When you are done, call report once with one entry per check: result pass, fail or skip, and a short detail.',
      '',
      'Apps:',
      ...lines,
    ].join('\n') },
    { role: 'user', content: INSTRUCTIONS },
  ]
  for (let step = 1; step <= MAX_STEPS; step++) {
    if (step === MAX_STEPS) messages.push({ role: 'user', content: 'This is your last step: call report now.' })
    let response
    try {
      response = await chat({ model: MODEL, messages, tools: TOOLS, tool_choice: 'auto', stream: false })
    } catch (error) {
      // Studio's limit text ends with chat advice ("Continue with a higher limit…") that does not apply here.
      const message = String(error.message || '').split('\nContinue with')[0]
      emit({ type: 'stopped', reason: error.status === 400 || error.status === 403 ? 'refused' : 'model_error', message: short(message, 600) })
      return { stopped: error.status === 400 || error.status === 403 ? 'refused' : 'model_error', message }
    }
    const message = response?.choices?.[0]?.message || {}
    messages.push({ role: 'assistant', content: message.content || '', ...(message.tool_calls?.length ? { tool_calls: message.tool_calls } : {}) })
    if (message.content) emit({ type: 'agent', role: 'assistant', text: short(message.content, 2000) })
    if (!message.tool_calls?.length) {
      messages.push({ role: 'user', content: 'Continue testing with the tools, or call report if you are done.' })
      continue
    }
    for (const call of message.tool_calls) {
      const name = call.function?.name
      let args = {}
      try { args = JSON.parse(call.function?.arguments || '{}') } catch { /* bad JSON: answered below */ }
      emit({ type: 'agent', role: 'tool', tool: name, text: short(JSON.stringify(args), 400) })
      if (name === 'report') {
        writeReport(args.summary, Array.isArray(args.checks) ? args.checks : [], { steps: step })
        emit({ type: 'report' })
        return { reported: true }
      }
      let result
      try {
        if (name?.startsWith('browser_') && !browser) result = 'No browser in this run: use http_request'
        else if (name === 'browser_open') result = allowedUrl(args.url) ? await browser.goto(args.url) : 'That address is not one of the apps'
        else if (name === 'browser_snapshot') result = await browser.snapshot()
        else if (name === 'browser_click') result = await browser.click(args.id)
        else if (name === 'browser_type') result = await browser.type(args.id, args.text ?? '', !!args.submit)
        else if (name === 'browser_screenshot') result = `Saved ${await browser.screenshot(args.name)}`
        else if (name === 'http_request') {
          if (!allowedUrl(args.url)) result = 'That address is not one of the apps'
          else {
            const res = await fetch(args.url, { method: String(args.method || 'GET').toUpperCase(), headers: args.headers || {}, body: args.body || undefined, redirect: 'manual', signal: AbortSignal.timeout(30000) })
            result = `HTTP ${res.status}\n${short(await res.text(), 3000)}`
          }
        } else result = `Unknown tool ${name}`
      } catch (error) { result = `Error: ${error?.message || error}` }
      messages.push({ role: 'tool', tool_call_id: call.id, content: short(result, 6000) })
    }
  }
  return { stopped: 'steps' }
}

async function main() {
  emit({ type: 'runner', text: 'started' })
  let ready = 0
  for (const app of APPS) {
    if (!(await waitHealthy(app))) continue
    ready++
    if (app.seed?.length) app.seedFailed = !(await seed(app))
  }
  let browser = null
  if (BROWSER) {
    try {
      browser = new Browser()
      await browser.open()
      emit({ type: 'browser', ok: true })
      for (const app of APPS) { try { await browser.goto(app.baseUrl + (app.start || '/')); await browser.screenshot(`app-${app.id}`) } catch { /* the agent will see it */ } }
    } catch (error) {
      emit({ type: 'browser', ok: false, error: short(error?.message || error, 300) })
      browser = null
    }
  }
  if (!ready && APPS.length) {
    writeReport('No app became healthy, so the agent did not run.', APPS.map(app => ({ name: `${app.name} starts`, result: 'fail', detail: 'health check failed' })))
    emit({ type: 'done', outcome: 'no_apps' })
    return
  }
  const result = await agent(browser)
  if (!result.reported) {
    const why = result.stopped === 'refused' ? `The run was stopped: ${result.message}` : result.stopped === 'steps' ? `The agent used all ${MAX_STEPS} steps without a report.` : `The model could not be reached: ${result.message}`
    writeReport(why, [{ name: 'Agent finished', result: 'fail', detail: why }], { stopped: result.stopped })
  }
  emit({ type: 'done', outcome: result.reported ? 'reported' : result.stopped })
  try { browser?.ws?.close() } catch { /* closing */ }
}

if (!env.LAB_NO_MAIN) {
  main().then(() => process.exit(0), error => {
    emit({ type: 'done', outcome: 'crashed', error: short(error?.stack || error, 1000) })
    process.exit(1)
  })
}
