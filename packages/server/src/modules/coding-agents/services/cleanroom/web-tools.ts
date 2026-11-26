/**
 * The agents' own web search and fetch tools in a clean room (docs/cleanroom.md).
 * With `allowWebTools` off, Studio turns them off with each agent's own switch:
 * a read-only policy file at the agent's system or managed settings path, a
 * launch flag, or (Kimi Code, which has no system file) its config file.
 * Every switch below was read from the agent's own documentation or package.
 */
import { existsSync, lchownSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml'

export interface WebToolPolicyFile { name: string; inside: string; content: string }

/** Where the DSH patch that drops its `tool-web` plugin goes in the room. */
export const DSH_WEB_PATCH_PATH = '/etc/studio-cleanroom/dsh-no-web-tools.patch.yml'

/**
 * The policy files, mounted read-only in every room while web tools are off
 * (an agent reads only its own; the others are harmless).
 */
export const WEB_POLICY_FILES: WebToolPolicyFile[] = [
  // Claude Code managed settings: deny rules win over every other settings file and over skipping permissions.
  { name: 'claude-managed-settings.json', inside: '/etc/claude-code/managed-settings.json', content: `${JSON.stringify({ permissions: { deny: ['WebSearch', 'WebFetch'] } }, null, 2)}\n` },
  // Codex managed config (`web_search = "disabled"`).
  { name: 'codex-managed-config.toml', inside: '/etc/codex/managed_config.toml', content: '# Studio clean room: web search off (cleanroom settings: allowWebTools)\nweb_search = "disabled"\n' },
  // Qwen Code system settings override user and project settings; a whole-tool deny also removes the tool.
  { name: 'qwen-code-settings.json', inside: '/etc/qwen-code/settings.json', content: `${JSON.stringify({ permissions: { deny: ['web_fetch', 'web_search'] }, tools: { disabled: ['web_fetch', 'web_search'] } }, null, 2)}\n` },
  // Gemini CLI system settings: tools.exclude (merged as a union with the user's list).
  { name: 'gemini-cli-settings.json', inside: '/etc/gemini-cli/settings.json', content: `${JSON.stringify({ tools: { exclude: ['google_web_search', 'web_fetch'] } }, null, 2)}\n` },
  // OpenCode managed config, merged after every other config: a "deny" permission removes the tool.
  { name: 'opencode-managed.json', inside: '/etc/opencode/opencode.json', content: `${JSON.stringify({ permission: { webfetch: 'deny', websearch: 'deny' } }, null, 2)}\n` },
  // Grok requirements (always enforced from /etc/grok): no web_search, no web_fetch, no server-side search.
  { name: 'grok-requirements.toml', inside: '/etc/grok/requirements.toml', content: '# Studio clean room: web tools off (cleanroom settings: allowWebTools)\ndisable_web_search = true\n\n[features]\nweb_fetch = false\nbackend_tools = false\n' },
  // DSH: a patch that turns its tool-web plugin (web_search, web_fetch) off; Studio passes it with --patch.
  { name: 'dsh-no-web-tools.patch.yml', inside: DSH_WEB_PATCH_PATH, content: '# Studio clean room: web tools off (cleanroom settings: allowWebTools)\n- id: tool-web\n  disabled: true\n' },
]

/** Kimi Code's web tools, turned off in its config.toml (`[tools] disabled`). */
export const KIMI_WEB_TOOLS = ['WebSearch', 'FetchURL']

type Method = 'policy-file' | 'launch-flags' | 'config-file' | 'none-needed' | 'cannot'

export interface AgentWebToolPolicy {
  /** Studio's agent id. */
  agent: string
  name: string
  method: Method
  /** The agent's web tools this turns off. */
  tools: string[]
  /** Policy files the agent reads (paths inside the room). */
  files?: string[]
  /** Flags Studio adds to the agent's command line. */
  args?: string[]
  /** Where the switch is documented. */
  source: string
}

export const AGENT_WEB_TOOL_POLICIES: AgentWebToolPolicy[] = [
  { agent: 'claude-code', name: 'Claude Code', method: 'policy-file', tools: ['WebSearch', 'WebFetch'], files: ['/etc/claude-code/managed-settings.json'], source: 'Claude Code managed settings (permissions.deny)' },
  { agent: 'codex', name: 'Codex', method: 'policy-file', tools: ['web_search'], files: ['/etc/codex/managed_config.toml'], source: 'Codex managed_config.toml (web_search = "disabled")' },
  { agent: 'qwen', name: 'Qwen Code', method: 'policy-file', tools: ['web_fetch', 'web_search'], files: ['/etc/qwen-code/settings.json'], source: 'Qwen Code docs/users/configuration/settings.md: system settings file, permissions.deny, tools.disabled' },
  { agent: 'opencode', name: 'OpenCode', method: 'policy-file', tools: ['webfetch', 'websearch'], files: ['/etc/opencode/opencode.json'], source: 'opencode 1.19.6 binary: managed config directory /etc/opencode (opencode.json), loaded last; a "deny" permission removes the tool' },
  { agent: 'grok', name: 'Grok', method: 'policy-file', tools: ['web_search', 'web_fetch', 'backend search'], files: ['/etc/grok/requirements.toml'], source: 'Grok 1.0.92 built-in docs: requirements.toml in /etc/grok always counts; disable_web_search, features.web_fetch, features.backend_tools' },
  { agent: 'dsh', name: 'DSH', method: 'policy-file', tools: ['web_search', 'web_fetch'], files: [DSH_WEB_PATCH_PATH], args: ['--patch', DSH_WEB_PATCH_PATH], source: '@deepseek-ai/dsh-base cordis.patch.yml (plugin id tool-web) and dsh-tool-web README' },
  { agent: 'copilot', name: 'Copilot', method: 'launch-flags', tools: ['web_fetch', 'github-mcp-server web_search'], args: ['--excluded-tools=web_fetch', '--disable-mcp-server=github-mcp-server'], source: 'GitHub Copilot CLI changelog: --excluded-tools (applies in ACP mode), --disable-mcp-server; web_search comes from the built-in github-mcp-server' },
  { agent: 'qoder', name: 'Qoder', method: 'launch-flags', tools: ['WebSearch', 'WebFetch', 'ImageSearch'], args: ['--disallowed-tools', 'WebSearch', '--disallowed-tools', 'WebFetch', '--disallowed-tools', 'ImageSearch'], source: '@qoder-ai/qodercli 1.1.98: --disallowed-tools <tool> ("Tools to deny")' },
  { agent: 'codebuddy', name: 'CodeBuddy', method: 'launch-flags', tools: ['WebSearch', 'WebFetch'], args: ['--disallowedTools=WebSearch,WebFetch'], source: '@tencent-ai/codebuddy-code 2.187.0: --disallowedTools <tools...> ("Tool names to deny, separated by commas or spaces")' },
  { agent: 'kimi', name: 'Kimi Code', method: 'config-file', tools: KIMI_WEB_TOOLS, source: 'Kimi Code docs/en/configuration/config-files.md: [tools] disabled in config.toml (no system or managed file)' },
  { agent: 'pi', name: 'Pi', method: 'none-needed', tools: [], source: '@earendil-works/pi-coding-agent 1.6.1: built-in tools are read, bash, edit, write, grep, find, ls' },
  { agent: 'cursor', name: 'Cursor', method: 'cannot', tools: [], source: 'Cursor CLI is not on npm and its docs and downloads could not be read here: no switch Studio can rely on' },
  { agent: 'antigravity', name: 'Antigravity', method: 'cannot', tools: [], source: 'Antigravity (agy) is installed by hand and has no documented switch for its web tools' },
  { agent: 'zcode', name: 'ZCode', method: 'cannot', tools: [], source: 'ZCode has no documented switch for its web tools' },
]

export function agentWebToolPolicy(agent?: string): AgentWebToolPolicy | undefined {
  return AGENT_WEB_TOOL_POLICIES.find(policy => policy.agent === agent)
}

/** Files that turn the agents' web tools off, mounted read-only. None when the room allows web tools. */
export function webToolPolicyFiles(allowWebTools: boolean): WebToolPolicyFile[] {
  return allowWebTools ? [] : WEB_POLICY_FILES
}

/** Flags Studio adds to an agent's command line in a clean room with web tools off. */
export function webToolLaunchArgs(agent: string, allowWebTools: boolean): string[] {
  if (allowWebTools) return []
  return [...(agentWebToolPolicy(agent)?.args || [])]
}

const KIMI_BEGIN = '# studio-cleanroom: web tools off (begin; Studio removes this when the room allows web tools)'
const KIMI_END = '# studio-cleanroom: web tools off (end)'

function withoutStudioBlock(content: string): string {
  const start = content.indexOf(KIMI_BEGIN)
  if (start < 0) return content
  const end = content.indexOf(KIMI_END, start)
  if (end < 0) return content
  return `${content.slice(0, start).replace(/\n+$/, '\n')}${content.slice(end + KIMI_END.length).replace(/^\n+/, '')}`
}

/**
 * Kimi Code's config.toml with its web tools turned off (or our block taken
 * out again). Studio's block is added at the end, between marker comments;
 * when the file already has a `[tools]` table, its `disabled` list gets the
 * web tools instead (the file is rewritten without its comments).
 */
export function kimiConfigWithWebTools(content: string, allowWebTools: boolean): string {
  const base = withoutStudioBlock(content)
  if (allowWebTools) return base
  let parsed: Record<string, any> = {}
  try { parsed = parseToml(base) as Record<string, any> } catch { parsed = {} }
  const tools = parsed.tools
  if (tools && typeof tools === 'object' && !Array.isArray(tools)) {
    const disabled = Array.isArray(tools.disabled) ? tools.disabled.map(String) : []
    if (KIMI_WEB_TOOLS.every(name => disabled.includes(name))) return base
    return `${stringifyToml({ ...parsed, tools: { ...tools, disabled: [...new Set([...disabled, ...KIMI_WEB_TOOLS])] } })}\n`
  }
  const lead = base && !base.endsWith('\n') ? `${base}\n` : base
  return `${lead}${lead ? '\n' : ''}${KIMI_BEGIN}\n[tools]\ndisabled = ${JSON.stringify(KIMI_WEB_TOOLS).replace(/,/g, ', ')}\n${KIMI_END}\n`
}

/** Write Kimi Code's config.toml for the room (owned like its folder). */
export function applyKimiWebToolConfig(configFile: string, allowWebTools: boolean): void {
  const current = existsSync(configFile) ? readFileSync(configFile, 'utf8') : ''
  const next = kimiConfigWithWebTools(current, allowWebTools)
  if (next === current) return
  mkdirSync(dirname(configFile), { recursive: true })
  writeFileSync(configFile, next, { mode: 0o600 })
  if (process.getuid?.() === 0) {
    try { const owner = statSync(dirname(configFile)); lchownSync(configFile, owner.uid, owner.gid) } catch { /* leave it */ }
  }
}

/** Substrings the self-check looks for in the agent's config file (Kimi Code). */
export function webConfigNeedles(agent?: string): string[] {
  return agent === 'kimi' ? KIMI_WEB_TOOLS.map(name => `"${name}"`) : []
}
