/**
 * The way out for sandboxes with internet (docs/sandbox.md): they sit on an internal Docker network
 * with no gateway, and their only route out is a Squid proxy that checks every call by host name,
 * refuses private and LAN addresses (after DNS, so a name pointing at 192.168.x is refused too) and
 * logs every call.
 */

export type EgressMode = 'allowlist' | 'blocklist' | 'log'

export interface EgressRules {
  /** allowlist: only `allow` hosts; blocklist: any host but `block`; log: any public host. */
  mode: EgressMode
  allow: string[]
  block: string[]
}

export interface EgressEntry {
  time: number
  /** The sandbox that made the call ('' when Studio no longer knows the address). */
  sandbox: string
  ip: string
  method: string
  host: string
  port: number
  allowed: boolean
  /** Squid's result, e.g. TCP_TUNNEL/200 or TCP_DENIED/403. */
  result: string
  bytesOut: number
  bytesIn: number
}

export const EGRESS_IMAGE = 'ubuntu/squid:6.13-25.04_beta'
export const EGRESS_PORT = 3128
export const EGRESS_ALIAS = 'egress-proxy'
export const EGRESS_CONF_DIR = '/etc/squid/studio'
export const EGRESS_LOG = '/var/log/squid/access.log'

/** Package registries and code hosts: what installs and clones need, for every distro preset. */
export const DEFAULT_ALLOW = [
  // Python, Node, Go, Rust, Ruby
  'pypi.org', 'files.pythonhosted.org', 'registry.npmjs.org', 'registry.yarnpkg.com', 'nodejs.org',
  'proxy.golang.org', 'sum.golang.org', 'go.dev', 'crates.io', 'static.crates.io', 'index.crates.io', 'static.rust-lang.org', 'rubygems.org',
  // distro packages
  'deb.debian.org', 'security.debian.org', 'archive.ubuntu.com', 'security.ubuntu.com', 'ports.ubuntu.com',
  'dl-cdn.alpinelinux.org', 'mirrors.fedoraproject.org', 'dl.fedoraproject.org', 'download.fedoraproject.org',
  'mirrors.rockylinux.org', 'dl.rockylinux.org', 'geo.mirror.pkgbuild.com', 'download.opensuse.org', 'cdn.opensuse.org',
  // code
  'github.com', 'codeload.github.com', 'objects.githubusercontent.com', 'raw.githubusercontent.com', 'release-assets.githubusercontent.com',
]

/** AI APIs and model hubs: refused in blocklist mode (and never on the default allowlist). */
export const DEFAULT_BLOCK = [
  'openai.com', 'anthropic.com', 'claude.ai', 'huggingface.co', 'hf.co', 'openrouter.ai', 'generativelanguage.googleapis.com',
  'aiplatform.googleapis.com', 'api.mistral.ai', 'api.groq.com', 'api.together.xyz', 'api.deepseek.com', 'x.ai', 'api.cohere.com',
  'api.perplexity.ai', 'api.fireworks.ai', 'replicate.com', 'ollama.com',
]

export const DEFAULT_RULES: EgressRules = { mode: 'allowlist', allow: DEFAULT_ALLOW, block: DEFAULT_BLOCK }

/** Private, loopback, link-local, CGNAT, multicast and reserved ranges: never reachable from a sandbox. */
export const PRIVATE_RANGES = [
  '0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12', '192.0.0.0/24',
  '192.168.0.0/16', '198.18.0.0/15', '224.0.0.0/4', '240.0.0.0/4', '::/128', '::1', 'fc00::/7', 'fe80::/10', 'ff00::/8',
]

const HOST = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/

/** A host name as typed (`example.com`, `*.example.com`, `.example.com`, a URL) to the name it covers, or null. */
export function cleanHost(value: unknown): string | null {
  let text = String(value ?? '').trim().toLowerCase()
  text = text.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').split(/[/?#]/)[0].replace(/:\d+$/, '').replace(/^\*?\./, '').replace(/\.$/, '')
  if (!HOST.test(text) || !text.includes('.') || /^[\d.]+$/.test(text)) return null
  return text
}

/** Each name covers its subdomains, so a name under another listed one is dropped (Squid refuses both). */
export function hostList(values: unknown): string[] {
  const list = Array.isArray(values) ? values : String(values ?? '').split(/[\s,]+/)
  const names = [...new Set(list.map(cleanHost).filter((name): name is string => !!name))].sort((a, b) => a.length - b.length)
  const kept: string[] = []
  for (const name of names) if (!kept.some(top => name === top || name.endsWith(`.${top}`))) kept.push(name)
  return kept.sort()
}

export function cleanRules(input: Partial<Record<keyof EgressRules, unknown>> | null | undefined, base: EgressRules = DEFAULT_RULES): EgressRules {
  const mode = input?.mode === 'blocklist' || input?.mode === 'log' || input?.mode === 'allowlist' ? input.mode : base.mode
  return {
    mode,
    allow: input?.allow === undefined ? hostList(base.allow) : hostList(input.allow),
    block: input?.block === undefined ? hostList(base.block) : hostList(input.block),
  }
}

/** Squid's configuration for these rules. */
export function squidConfig(rules: EgressRules): string {
  const lines = [
    '# Written by Hermes Studio (services/sandbox/egress.ts). Edit the rules in Studio, not here.',
    `http_port ${EGRESS_PORT}`,
    'cache deny all',
    'cache_mem 8 MB',
    'via off',
    'forwarded_for delete',
    'httpd_suppress_version_string on',
    'logformat studio %ts.%03tu %>a %rm %>rd %>rP %Ss/%>Hs %>st %<st',
    `access_log stdio:${EGRESS_LOG} studio`,
    'acl web_port port 80 443',
    'acl tls_port port 443',
    'acl CONNECT method CONNECT',
    `acl private_dst dst ${PRIVATE_RANGES.join(' ')}`,
    'http_access deny !web_port',
    'http_access deny CONNECT !tls_port',
    // dst resolves the name first: a public name that points at the LAN is refused too.
    'http_access deny private_dst',
  ]
  const domains = (names: string[]) => names.map(name => `.${name}`).join(' ')
  const block = hostList(rules.block)
  const allow = hostList(rules.allow)
  if (rules.mode !== 'log' && block.length) lines.push(`acl blocked dstdomain ${domains(block)}`, 'http_access deny blocked')
  if (rules.mode === 'allowlist') {
    if (allow.length) lines.push(`acl allowed dstdomain ${domains(allow)}`, 'http_access allow allowed')
  } else {
    lines.push('http_access allow all')
  }
  lines.push('http_access deny all', '')
  return lines.join('\n')
}

/** Lines of the access log (format `studio` above), oldest first; lines that don't parse are skipped. */
export function parseAccessLog(text: string, sandboxOf: (ip: string) => string = () => ''): EgressEntry[] {
  const out: EgressEntry[] = []
  for (const line of text.split('\n')) {
    const parts = line.trim().split(/\s+/)
    if (parts.length < 8) continue
    const [time, ip, method, host, port, result, up, down] = parts
    const seconds = Number(time)
    if (!Number.isFinite(seconds)) continue
    const status = Number(result.split('/')[1])
    out.push({
      time: Math.round(seconds * 1000), sandbox: sandboxOf(ip), ip, method, host: host === '-' ? '' : host, port: Number(port) || 0,
      allowed: !result.startsWith('TCP_DENIED') && status !== 403 && status > 0, result,
      bytesOut: Number(up) || 0, bytesIn: Number(down) || 0,
    })
  }
  return out
}

/** The variables that send a sandbox's tools (curl, pip, npm, apt, git, go…) through the proxy. */
export function proxyEnv(): Record<string, string> {
  const url = `http://${EGRESS_ALIAS}:${EGRESS_PORT}`
  return {
    HTTP_PROXY: url, HTTPS_PROXY: url, http_proxy: url, https_proxy: url,
    NO_PROXY: 'localhost,127.0.0.1', no_proxy: 'localhost,127.0.0.1',
    npm_config_proxy: url, npm_config_https_proxy: url,
  }
}
