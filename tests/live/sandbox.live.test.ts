import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SandboxDocker } from '../../packages/server/src/modules/studio/services/sandbox/docker'
import { sandboxDockerSocket } from '../../packages/server/src/modules/studio/services/system/docker'
import { SandboxService } from '../../packages/server/src/modules/studio/services/sandbox/service'

// Edge cases of Studio's sandboxes against a real Docker. Run with LIVE_DOCKER=1 (needs a Docker at
// STUDIO_SANDBOX_DOCKER_HOST or /var/run/docker.sock, and alpine:3.22, pulled through the mirror if missing).
const live = !!process.env.LIVE_DOCKER
const home = mkdtempSync(join(tmpdir(), 'sandbox-live-'))
const docker = new SandboxDocker(() => sandboxDockerSocket())
const make = (instance = `live${process.pid}`) => new SandboxService({ home: () => home, docker, instance, forge: null })
let s: SandboxService
let id = ''

describe.skipIf(!live)('sandboxes on real Docker: edge cases', () => {
  beforeAll(async () => {
    s = make()
    id = (await s.create({ distro: 'alpine', minutes: 10, purpose: 'live edge cases' })).id
  }, 300_000)
  afterAll(async () => {
    for (const box of await s.list()) await s.remove({ sandbox: box.id }).catch(() => undefined)
    rmSync(home, { recursive: true, force: true })
  })

  it('runs commands with quotes, $ signs, newlines and unicode exactly as given', async () => {
    const out = await s.exec({ sandbox: id, command: `printf '%s|' "a b" 'c"d' '$HOME' "\${HOME}"; echo\necho "ünïcödé ✓"` })
    expect(out.exitCode).toBe(0)
    expect(out.output).toBe('a b|c"d|$HOME|/root|\nünïcödé ✓\n')
  })

  it('keeps the end of huge output and survives binary output', async () => {
    const big = await s.exec({ sandbox: id, command: 'seq 1 200000; echo LAST' })
    expect(big.truncated).toBe(true)
    expect(big.output.endsWith('200000\nLAST\n')).toBe(true)
    const bin = await s.exec({ sandbox: id, command: 'head -c 4096 /dev/urandom; echo; echo done' })
    expect(bin.exitCode).toBe(0)
    expect(bin.output.endsWith('done\n')).toBe(true)
  })

  it('reports stderr, exit codes, a missing workdir and a timeout', async () => {
    expect(await s.exec({ sandbox: id, command: 'echo oops >&2; exit 3' })).toMatchObject({ exitCode: 3, output: 'oops\n' })
    const nowhere = await s.exec({ sandbox: id, command: 'pwd', workdir: '/does/not/exist' })
    expect(nowhere.exitCode).not.toBe(0)
    const slow = await s.exec({ sandbox: id, command: 'sleep 30', timeoutSeconds: 2 })
    expect(slow).toMatchObject({ exitCode: 137, timedOut: true })
  }, 60_000)

  it('a background process left running does not hang the next command', async () => {
    const t = Date.now()
    await s.exec({ sandbox: id, command: 'nohup sleep 300 >/dev/null 2>&1 &' })
    expect((await s.exec({ sandbox: id, command: 'echo next' })).output).toBe('next\n')
    expect(Date.now() - t).toBeLessThan(15_000)
  }, 30_000)

  it('files: deep new folders, odd names, overwrite, empty, missing, folders, and binary content', async () => {
    await s.writeFile({ sandbox: id, path: '/work/a/b/c/name with spaces & quotes\'.txt', content: 'one' })
    await s.writeFile({ sandbox: id, path: '/work/a/b/c/name with spaces & quotes\'.txt', content: 'two' })
    expect((await s.readFile({ sandbox: id, path: '/work/a/b/c/name with spaces & quotes\'.txt' })).content).toBe('two')
    await s.writeFile({ sandbox: id, path: '/work/empty', content: '' })
    expect(await s.readFile({ sandbox: id, path: '/work/empty' })).toMatchObject({ bytes: 0, content: '' })
    await expect(s.readFile({ sandbox: id, path: '/work/missing.txt' })).rejects.toThrow(/does not exist/)
    await expect(s.readFile({ sandbox: id, path: '/work/a' })).rejects.toThrow(/is a folder/)
    await s.exec({ sandbox: id, command: 'ln -sf /etc/alpine-release /work/link' })
    expect((await s.readFile({ sandbox: id, path: '/work/link' })).content).toMatch(/^3\.22/)
    await s.exec({ sandbox: id, command: 'head -c 3000 /dev/urandom > /work/bin' })
    expect((await s.readFile({ sandbox: id, path: '/work/bin' })).bytes).toBe(3000)
    // a path that normalises to / is the container's root, not the host's
    await s.writeFile({ sandbox: id, path: '/work/../tmp/x', content: 'inside' })
    expect((await s.exec({ sandbox: id, command: 'cat /tmp/x' })).output).toBe('inside')
  }, 60_000)

  it('copy_repo: a local bare repo at a branch, a missing repo and a missing ref', async () => {
    const src = mkdtempSync(join(tmpdir(), 'sandbox-src-'))
    try {
      const git = (...a: string[]) => execFileSync('git', ['-C', src, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a])
      git('init', '-q', '-b', 'main'); writeFileSync(join(src, 'f.txt'), 'main'); git('add', '.'); git('commit', '-qm', 'one')
      git('checkout', '-qb', 'feature'); writeFileSync(join(src, 'f.txt'), 'feature'); git('commit', '-qam', 'two')
      // agents may only give http(s)/ssh URLs; the service's clone is exercised through deps.clone here
      const viaGit = new SandboxService({
        home: () => home, docker, instance: `live${process.pid}`, forge: null,
        clone: async (_url, ref, dest) => {
          execFileSync('git', ['clone', '-q', src, dest]); if (ref) execFileSync('git', ['-C', dest, 'checkout', '-q', ref])
        },
      })
      const out = await viaGit.copyRepo({ sandbox: id, repo: 'https://example.invalid/me/proj.git', ref: 'feature' })
      expect(out.path).toBe('/work/proj')
      expect((await s.readFile({ sandbox: id, path: '/work/proj/f.txt' })).content).toBe('feature')
      expect((await s.exec({ sandbox: id, command: 'git -C /work/proj log --oneline 2>/dev/null | wc -l || true' })).exitCode).toBe(0)
      await expect(s.copyRepo({ sandbox: id, repo: 'https://127.0.0.1:1/none/nothing.git' })).rejects.toThrow(/Could not clone/)
    } finally { rmSync(src, { recursive: true, force: true }) }
  }, 120_000)

  it('a container removed behind Studio\'s back: list says gone, exec says so, sweep tidies the index', async () => {
    const other = await s.create({ distro: 'alpine', minutes: 10 })
    const cid = JSON.parse(readIndex())[other.id].containerId
    execFileSync('docker', ['-H', `unix://${sandboxDockerSocket()}`, 'rm', '-f', cid])
    expect((await s.list()).find(b => b.id === other.id)?.state).toBe('gone')
    await expect(s.exec({ sandbox: other.id, command: 'true' })).rejects.toThrow()
    await s.sweep()
    expect((await s.list()).map(b => b.id)).not.toContain(other.id)
    expect((await s.list()).map(b => b.id)).toContain(id)
  }, 120_000)

  it('a new Studio process (same home) finds its sandboxes; another Studio never sees them', async () => {
    expect((await make().list()).map(b => b.id)).toContain(id)
    const otherHome = mkdtempSync(join(tmpdir(), 'sandbox-other-'))
    const stranger = new SandboxService({ home: () => otherHome, docker, instance: 'someone-else', forge: null, now: () => Date.now() + 48 * 3600_000 })
    expect(await stranger.sweep()).toEqual([])
    expect((await stranger.list())).toEqual([])
    expect((await s.list()).find(b => b.id === id)?.state).toBe('running')
  })

  it('two sandboxes made at once both stay in the list', async () => {
    const [a, b] = await Promise.all([s.create({ distro: 'alpine', minutes: 5 }), s.create({ distro: 'alpine', minutes: 5 })])
    await Promise.all([s.extend({ sandbox: a.id, minutes: 5 }), s.sweep(), s.extend({ sandbox: b.id, minutes: 5 })])
    const ids = (await s.list()).map(x => x.id)
    expect(ids).toEqual(expect.arrayContaining([a.id, b.id]))
    await Promise.all([s.remove({ sandbox: a.id }), s.remove({ sandbox: b.id })])
    expect((await s.list()).map(x => x.id)).not.toContain(a.id)
  }, 120_000)

  it('an unknown image says it could not be pulled, and nothing is left behind', async () => {
    const before = (await s.list()).length
    await expect(s.create({ image: 'nobody-here/does-not-exist:never' })).rejects.toThrow(/Could not pull/)
    expect((await s.list()).length).toBe(before)
  }, 120_000)

  it('internet goes only through the proxy: allowlist, LAN by name, no DNS, no direct route, all logged', async () => {
    const box = (await s.create({ distro: 'alpine', minutes: 10, purpose: 'egress' })).id
    const sh = async (command: string) => (await s.exec({ sandbox: box, command, timeoutSeconds: 120 })).output.trim()
    // A box whose own TLS is inspected (like the cloud CI box) gives its CA with LIVE_EXTRA_CA.
    if (process.env.LIVE_EXTRA_CA) {
      await s.writeFile({ sandbox: box, path: '/tmp/extra-ca.crt', content: require('node:fs').readFileSync(process.env.LIVE_EXTRA_CA, 'utf8') })
      await sh('cat /tmp/extra-ca.crt >> /etc/ssl/certs/ca-certificates.crt')
    }
    expect(await sh('apk add -q curl >/dev/null 2>&1 && echo ok')).toBe('ok') // dl-cdn.alpinelinux.org is on the allowlist
    const code = (url: string, extra = '') => sh(`curl -s ${extra} -m 10 -o /dev/null -w "%{http_code}" ${url}; echo " $?"`)
    expect(await code('https://pypi.org/simple/')).toBe('200 0')
    expect(await code('https://api.openai.com/v1/models')).toBe('000 56') // CONNECT refused with 403
    expect(await code('https://huggingface.co/')).toBe('000 56')
    expect(await code('https://1.1.1.1/', '--noproxy "*"')).toMatch(/^000 (7|28)$/) // no route but the proxy
    expect(await code('http://192.168.1.10/')).toBe('403 0')
    expect(await sh('nslookup -timeout=2 example.com >/dev/null 2>&1; echo $?')).not.toBe('0') // no DNS to leak data through
    // log-only mode still refuses names that point at private addresses
    await s.setEgressRules({ mode: 'log' })
    try {
      expect(await code('https://example.com/')).toBe('200 0')
      // resolves to 127.0.0.1: refused (403), or 503 where the resolver already drops loopback answers
      expect(await code('http://127.0.0.1.nip.io/')).toMatch(/^(403|503) 0$/)
      expect(await code('http://192.168.1.10.nip.io/')).toBe('403 0') // resolves to 192.168.1.10
    } finally { await s.setEgressRules({ mode: 'allowlist' }) }
    expect(await code('https://example.com/')).toBe('000 56')
    // a sandbox made for a task that needs a site gets it; the others still don't
    const own = (await s.create({ distro: 'alpine', minutes: 10, allow: ['example.com'], purpose: 'needs example.com' })).id
    if (process.env.LIVE_EXTRA_CA) {
      await s.writeFile({ sandbox: own, path: '/tmp/extra-ca.crt', content: require('node:fs').readFileSync(process.env.LIVE_EXTRA_CA, 'utf8') })
      await s.exec({ sandbox: own, command: 'cat /tmp/extra-ca.crt >> /etc/ssl/certs/ca-certificates.crt' })
    }
    // busybox wget can't send https through a proxy: curl can
    expect((await s.exec({ sandbox: own, command: 'apk add -q curl >/dev/null 2>&1 && curl -s -m 10 -o /dev/null -w "%{http_code}" https://example.com/', timeoutSeconds: 120 })).output.trim()).toBe('200')
    expect(await code('https://example.com/')).toBe('000 56')
    await s.remove({ sandbox: own })
    const calls = (await s.networkLog({ sandbox: box, limit: 500 })).calls
    const seen = (host: string) => calls.find(c => c.host === host)
    expect(seen('pypi.org')).toMatchObject({ allowed: true, sandbox: box })
    expect(seen('api.openai.com')).toMatchObject({ allowed: false, result: 'TCP_DENIED/403' })
    expect(seen('192.168.1.10.nip.io')).toMatchObject({ allowed: false, result: 'TCP_DENIED/403' })
    expect(calls.some(c => c.host === '1.1.1.1')).toBe(false)
    await s.remove({ sandbox: box })
  }, 300_000)

  it('network none really has no network', async () => {
    const off = await s.create({ distro: 'alpine', network: 'none', minutes: 5 })
    const r = await s.exec({ sandbox: off.id, command: 'ip -o link | grep -v " lo:" | wc -l; wget -q -T 3 -O- http://1.1.1.1 >/dev/null 2>&1; echo $?' })
    expect(r.output.trim().split('\n')).toEqual(['0', '1'])
    await s.remove({ sandbox: off.id })
  }, 60_000)
})

function readIndex(): string {
  return require('node:fs').readFileSync(join(home, 'sandboxes.json'), 'utf8')
}
