import { describe, expect, it } from 'vitest'
import { blockedOf, cleanHost, cleanRules, DEFAULT_RULES, hostList, parseAccessLog, proxyEnv, squidConfig } from '../../packages/server/src/modules/studio/services/sandbox/egress'

describe('sandbox egress rules', () => {
  it('takes host names however they are typed, and nothing else', () => {
    expect(cleanHost('PyPI.org')).toBe('pypi.org')
    expect(cleanHost('*.huggingface.co')).toBe('huggingface.co')
    expect(cleanHost('.openai.com')).toBe('openai.com')
    expect(cleanHost('https://api.openai.com:443/v1/models?x=1')).toBe('api.openai.com')
    for (const bad of ['', 'localhost', '192.168.1.10', '10.0.0.1', 'a b.com', 'evil.com; rm -rf /', '-x.com', 'x..com', '*']) expect(cleanHost(bad), bad).toBeNull()
  })

  it('drops names a listed name already covers, since each covers its subdomains', () => {
    expect(hostList(['api.github.com', 'github.com', 'GITHUB.com', 'raw.githubusercontent.com'])).toEqual(['github.com', 'raw.githubusercontent.com'])
    expect(hostList('pypi.org, files.pythonhosted.org\nnope')).toEqual(['files.pythonhosted.org', 'pypi.org'])
  })

  it('defaults to the allowlist, which never lets AI APIs or model hubs through', () => {
    const rules = cleanRules(null)
    expect(rules.mode).toBe('allowlist')
    for (const host of ['openai.com', 'anthropic.com', 'huggingface.co', 'openrouter.ai']) {
      expect(rules.allow.some(name => host === name || host.endsWith(`.${name}`))).toBe(false)
      expect(rules.block).toContain(host)
    }
    expect(cleanRules({ mode: 'nonsense' as any }).mode).toBe('allowlist')
    expect(cleanRules({ mode: 'log' }, { ...DEFAULT_RULES, allow: ['example.com'] }).allow).toEqual(['example.com'])
  })

  it('refuses private addresses and other ports before any allow, in every mode', () => {
    for (const mode of ['allowlist', 'blocklist', 'log'] as const) {
      const conf = squidConfig({ mode, allow: ['pypi.org'], block: ['openai.com'] })
      const lines = conf.split('\n')
      const at = (text: string) => lines.findIndex(line => line.startsWith(text))
      expect(conf).toMatch(/acl private_dst dst .*10\.0\.0\.0\/8 .*192\.168\.0\.0\/16 .*fc00::\/7/)
      expect(at('http_access deny private_dst')).toBeGreaterThan(-1)
      expect(at('http_access deny !web_port')).toBeLessThan(at('http_access deny private_dst'))
      const firstAllow = lines.findIndex(line => line.startsWith('http_access allow'))
      expect(firstAllow === -1 || firstAllow > at('http_access deny private_dst')).toBe(true)
      expect(lines.at(-2)).toBe('http_access deny all')
      expect(conf).toContain('via off')
      if (mode === 'log') expect(conf).not.toContain('acl blocked')
      else expect(conf).toContain('acl blocked dstdomain .openai.com')
      if (mode === 'allowlist') expect(conf).toContain('acl allowed dstdomain .pypi.org')
      else expect(conf).toContain('http_access allow all')
    }
    // an empty allowlist lets nothing out
    expect(squidConfig({ mode: 'allowlist', allow: [], block: [] })).not.toMatch(/http_access allow/)
  })

  it('reads the access log and names each call\'s sandbox', () => {
    const log = parseAccessLog([
      '1795800000.123 10.9.0.2 CONNECT pypi.org 443 TCP_TUNNEL/200 812 40213',
      '1795800001.000 10.9.0.2 CONNECT api.openai.com 443 TCP_DENIED/403 300 0',
      '1795800002.500 10.9.0.3 GET 192.168.1.10 80 TCP_DENIED/403 120 0',
      'garbage',
    ].join('\n'), ip => (ip === '10.9.0.2' ? 'a1b2c3d4e5' : ''))
    expect(log).toEqual([
      { time: 1795800000123, sandbox: 'a1b2c3d4e5', ip: '10.9.0.2', method: 'CONNECT', host: 'pypi.org', port: 443, allowed: true, result: 'TCP_TUNNEL/200', bytesOut: 812, bytesIn: 40213 },
      { time: 1795800001000, sandbox: 'a1b2c3d4e5', ip: '10.9.0.2', method: 'CONNECT', host: 'api.openai.com', port: 443, allowed: false, result: 'TCP_DENIED/403', bytesOut: 300, bytesIn: 0 },
      { time: 1795800002500, sandbox: '', ip: '10.9.0.3', method: 'GET', host: '192.168.1.10', port: 80, allowed: false, result: 'TCP_DENIED/403', bytesOut: 120, bytesIn: 0 },
    ])
  })

  it('covers downloads for Linux, Windows, JavaScript and Steam, and no catch-all hosting', () => {
    const allow = cleanRules(null).allow
    const covered = (host: string) => allow.some(name => host === name || host.endsWith(`.${name}`))
    for (const host of ['registry.npmjs.org', 'registry.yarnpkg.com', 'cdn.jsdelivr.net', 'jsr.io', 'files.pythonhosted.org', 'static.crates.io',
      'repo1.maven.org', 'api.nuget.org', 'download.visualstudio.microsoft.com', 'community.chocolatey.org', 'repo.msys2.org', 'dl.winehq.org',
      'deb.debian.org', 'archive.ubuntu.com', 'dl-cdn.alpinelinux.org', 'mirrors.fedoraproject.org', 'cache.nixos.org', 'download.docker.com',
      'objects.githubusercontent.com', 'media.steampowered.com', 'steamcdn-a.akamaihd.net', 'cache1-ord1.steamcontent.com']) expect(covered(host), host).toBe(true)
    for (const host of ['storage.googleapis.com', 's3.amazonaws.com', 'evil.akamaihd.net', 'api.openai.com', 'huggingface.co']) expect(covered(host), host).toBe(false)
    expect(blockedOf(allow, cleanRules(null).block)).toEqual([])
  })

  it('gives a sandbox its own extra sites, for its address only and never a blocked one', () => {
    const conf = squidConfig({ mode: 'allowlist', allow: ['pypi.org'], block: ['openai.com'] }, [
      { id: 'a1b2c3d4e5', ip: '10.9.0.2', hosts: ['legendkeeper.com', 'www.legendkeeper.com'] },
      { id: 'bad', ip: '10.9.0.3', hosts: ['x.com'] },
      { id: 'b1b2c3d4e5', ip: '10.9.0.4; http_access allow all', hosts: ['x.com'] },
    ])
    expect(conf).toContain('acl sb_a1b2c3d4e5 src 10.9.0.2/32')
    expect(conf).toContain('acl sb_a1b2c3d4e5_sites dstdomain .legendkeeper.com\n')
    expect(conf).toContain('http_access allow sb_a1b2c3d4e5 sb_a1b2c3d4e5_sites')
    expect(conf).not.toContain('10.9.0.3')
    expect(conf).not.toContain('10.9.0.4')
    expect(conf.indexOf('http_access deny blocked')).toBeLessThan(conf.indexOf('http_access allow sb_'))
    expect(blockedOf(['api.openai.com', 'legendkeeper.com'], ['openai.com'])).toEqual(['api.openai.com'])
  })

  it('points every common tool at the proxy', () => {
    const env = proxyEnv()
    for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'npm_config_https_proxy']) expect(env[key]).toBe('http://egress-proxy:3128')
  })
})
