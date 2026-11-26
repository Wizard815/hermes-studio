import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AGENT_WEB_TOOL_POLICIES, applyKimiWebToolConfig, DSH_WEB_PATCH_PATH, kimiConfigWithWebTools, webToolLaunchArgs, webToolPolicyFiles,
} from '../../packages/server/src/modules/coding-agents/services/cleanroom/web-tools'
import { judgeWebTools, normalizeProbe, PROBE_SCRIPT, type ProbeOutput, type SelfCheckExpectations } from '../../packages/server/src/modules/coding-agents/services/cleanroom/probe'
import { TOOL_DEFINITIONS } from '../../packages/server/src/modules/coding-agents/services/registry/definitions'

const dirs: string[] = []
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'cleanroom-web-tools-')); dirs.push(dir); return dir }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const file = (inside: string) => {
  const found = webToolPolicyFiles(false).find(entry => entry.inside === inside)
  if (!found) throw new Error(`no policy file at ${inside}`)
  return found.content
}

describe('clean room web tools: each agent\'s own switch', () => {
  it('knows every coding agent Studio runs', () => {
    const known = AGENT_WEB_TOOL_POLICIES.map(policy => policy.agent)
    for (const agent of TOOL_DEFINITIONS.map(definition => definition.id)) expect(known).toContain(agent)
  })

  it('Qwen Code: system settings deny and disable web_fetch and web_search', () => {
    const settings = JSON.parse(file('/etc/qwen-code/settings.json'))
    expect(settings.permissions.deny).toEqual(['web_fetch', 'web_search'])
    expect(settings.tools.disabled).toEqual(['web_fetch', 'web_search'])
  })

  it('Gemini CLI: system settings exclude google_web_search and web_fetch', () => {
    expect(JSON.parse(file('/etc/gemini-cli/settings.json'))).toEqual({ tools: { exclude: ['google_web_search', 'web_fetch'] } })
  })

  it('OpenCode: managed config denies webfetch and websearch', () => {
    expect(JSON.parse(file('/etc/opencode/opencode.json'))).toEqual({ permission: { webfetch: 'deny', websearch: 'deny' } })
  })

  it('Grok: requirements turn web_search, web_fetch and server-side search off', () => {
    const requirements = parseToml(file('/etc/grok/requirements.toml')) as any
    expect(requirements.disable_web_search).toBe(true)
    expect(requirements.features).toEqual({ web_fetch: false, backend_tools: false })
  })

  it('DSH: a patch turns the tool-web plugin off, passed with --patch', () => {
    expect(file(DSH_WEB_PATCH_PATH)).toMatch(/^- id: tool-web\n {2}disabled: true$/m)
    expect(webToolLaunchArgs('dsh', false)).toEqual(['--patch', DSH_WEB_PATCH_PATH])
  })

  it('Copilot, Qoder and CodeBuddy: launch flags', () => {
    expect(webToolLaunchArgs('copilot', false)).toEqual(['--excluded-tools=web_fetch', '--disable-mcp-server=github-mcp-server'])
    expect(webToolLaunchArgs('qoder', false)).toEqual(['--disallowed-tools', 'WebSearch', '--disallowed-tools', 'WebFetch', '--disallowed-tools', 'ImageSearch'])
    expect(webToolLaunchArgs('codebuddy', false)).toEqual(['--disallowedTools=WebSearch,WebFetch'])
    expect(webToolLaunchArgs('claude-code', false)).toEqual([])
  })

  it('adds nothing when the room allows web tools', () => {
    expect(webToolPolicyFiles(true)).toEqual([])
    for (const policy of AGENT_WEB_TOOL_POLICIES) expect(webToolLaunchArgs(policy.agent, true)).toEqual([])
  })

  it('Kimi Code: adds [tools] disabled to config.toml and takes it out again', () => {
    const studio = '# Model and local proxy credentials are supplied by the session environment.\n'
    const off = kimiConfigWithWebTools(studio, false)
    expect((parseToml(off) as any).tools.disabled).toEqual(['WebSearch', 'FetchURL'])
    expect(off.startsWith(studio)).toBe(true)
    expect(kimiConfigWithWebTools(off, false)).toBe(off)
    expect(kimiConfigWithWebTools(off, true)).toBe(studio)
  })

  it('Kimi Code: joins a [tools] table the user already has', () => {
    const own = 'default_model = "k2"\n\n[tools]\ndisabled = ["Bash"]\n'
    const off = parseToml(kimiConfigWithWebTools(own, false)) as any
    expect(off.tools.disabled).toEqual(['Bash', 'WebSearch', 'FetchURL'])
    expect(off.default_model).toBe('k2')
  })

  it('Kimi Code: writes the file Studio gives it', () => {
    const dir = temp()
    const config = join(dir, 'kimi', 'config.toml')
    applyKimiWebToolConfig(config, false)
    expect((parseToml(readFileSync(config, 'utf8')) as any).tools.disabled).toEqual(['WebSearch', 'FetchURL'])
    applyKimiWebToolConfig(config, true)
    expect(readFileSync(config, 'utf8')).toBe('')
  })
})

describe('clean room self-check: web tools per agent', () => {
  const expect0: SelfCheckExpectations = {
    network: 'allowlist', readOnlyRoot: true, dropAllCaps: true, capAdd: [], uid: 1000,
    workspace: '/work', readOnlyPaths: [], blockedHost: 'example.com',
  }
  const probe = (webPolicy: string[], webConfig?: ProbeOutput['webConfig']): ProbeOutput => ({
    uid: 1000, gid: 1000, user: 'agent', noNewPrivs: true, capEff: [], capBnd: [], mounts: [], envNames: [], dockerSocket: [], network: [], webPolicy, webConfig,
  })
  const all = webToolPolicyFiles(false).map(entry => entry.inside)

  it('says how each agent\'s web tools are off', () => {
    expect(judgeWebTools(probe(all), { ...expect0, agent: 'qwen' })).toEqual({ state: 'pass', detail: 'off for Qwen Code (web_fetch, web_search): /etc/qwen-code/settings.json' })
    expect(judgeWebTools(probe(all), { ...expect0, agent: 'opencode' }).state).toBe('pass')
    expect(judgeWebTools(probe(all), { ...expect0, agent: 'copilot' }).detail).toContain('--excluded-tools=web_fetch')
    expect(judgeWebTools(probe([]), { ...expect0, agent: 'qwen' })).toEqual({ state: 'fail', detail: 'Qwen Code: policy missing: /etc/qwen-code/settings.json' })
    expect(judgeWebTools(probe([]), { ...expect0, agent: 'pi' })).toEqual({ state: 'pass', detail: 'Pi has no web tools' })
    expect(judgeWebTools(probe(all), { ...expect0, agent: 'cursor' })).toEqual({ state: 'warn', detail: 'can\'t be turned off for Cursor; the network allowlist still blocks other sites' })
    expect(judgeWebTools(probe([]), { ...expect0, agent: 'qwen', allowWebTools: true })).toEqual({ state: 'info', detail: 'allowed (Qwen Code)' })
  })

  it('checks Kimi Code\'s config file', () => {
    const kimi = { ...expect0, agent: 'kimi', webConfig: { path: '/root/.kimi-code/config.toml', needles: ['"WebSearch"', '"FetchURL"'] } }
    expect(judgeWebTools(probe(all, { path: kimi.webConfig.path, found: true }), kimi).state).toBe('pass')
    expect(judgeWebTools(probe(all, { path: kimi.webConfig.path, found: false }), kimi).state).toBe('fail')
  })

  it('an unknown agent needs every policy file', () => {
    expect(judgeWebTools(probe(all), expect0).state).toBe('pass')
    expect(judgeWebTools(probe(all.slice(1)), expect0).state).toBe('fail')
  })

  it('the probe reports whether the config file names the tools, never its contents', () => {
    const dir = temp()
    writeFileSync(join(dir, 'probe.mjs'), PROBE_SCRIPT)
    const config = join(dir, 'config.toml')
    writeFileSync(config, 'api_key = "do-not-print-me"\n[tools]\ndisabled = ["WebSearch", "FetchURL"]\n')
    const out = execFileSync(process.execPath, [join(dir, 'probe.mjs')], {
      env: { PATH: process.env.PATH, STUDIO_PROBE: JSON.stringify({ blockedHost: 'blocked.invalid', direct: false, webConfig: { path: config, needles: ['"WebSearch"', '"FetchURL"'] } }) },
      encoding: 'utf8', timeout: 30000,
    })
    expect(out).not.toContain('do-not-print-me')
    expect(normalizeProbe(JSON.parse(out.trim())).webConfig).toEqual({ path: config, found: true })
  }, 40000)
})
