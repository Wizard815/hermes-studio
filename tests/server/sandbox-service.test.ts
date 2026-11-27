import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { create as tarCreate, extract as tarExtract } from 'tar'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LABEL_EXPIRES, LABEL_INSTANCE, LABEL_SANDBOX, sandboxBody, type SandboxDocker, type SandboxSpec } from '../../packages/server/src/modules/studio/services/sandbox/docker'
import { DISTROS, SandboxService } from '../../packages/server/src/modules/studio/services/sandbox/service'
import { EGRESS_IMAGE } from '../../packages/server/src/modules/studio/services/sandbox/egress'
import { sandboxDockerSocket } from '../../packages/server/src/modules/studio/services/system/docker'

/** A Docker that keeps each container's files in a host folder, so archives and exec are real. */
class FakeSandboxDocker {
  up = true
  images = new Set<string>()
  pulls: string[] = []
  tags: string[] = []
  failPull = new Set<string>()
  containers = new Map<string, { spec: SandboxSpec; root: string; state: string }>()
  execs: Array<{ id: string; command: string; workdir?: string; timeoutSeconds: number }> = []
  nextExec: { exitCode: number; output: string } | null = null
  private n = 0

  available() { return this.up }
  async hasImage(image: string) { return this.images.has(image) }
  async imageId(image: string) { return `sha256:${image}` }
  async pull(image: string) {
    this.pulls.push(image)
    if (this.failPull.has(image)) throw new Error('not found')
    this.images.add(image)
  }
  async tag(source: string, target: string) { this.tags.push(`${source}->${target}`); this.images.add(target) }
  networks = new Map<string, { internal: boolean; labels: Record<string, string> }>()
  own = new Map<string, { name: string; body: any; root: string; running: boolean; networks: string[] }>()
  proxyLog = ''
  async create(spec: SandboxSpec) {
    const id = `c${++this.n}`
    const root = mkdtempSync(join(tmpdir(), 'fake-sandbox-'))
    mkdirSync(join(root, 'work'))
    this.containers.set(id, { spec, root, state: 'running' })
    return id
  }
  async ensureNetwork(name: string, labels: Record<string, string>, internal: boolean) {
    if (!this.networks.has(name)) this.networks.set(name, { internal, labels })
  }
  async createContainer(name: string, body: any) {
    const id = `p${++this.n}`
    this.own.set(id, { name, body, root: mkdtempSync(join(tmpdir(), 'fake-proxy-')), running: false, networks: [] })
    return id
  }
  async start(id: string) { this.own.get(id)!.running = true }
  async connect(network: string, id: string) { this.own.get(id)!.networks.push(network) }
  async ipOn(id: string) { return `10.9.0.${id.slice(1)}` }
  async exec(id: string, command: string, opts: { workdir?: string; timeoutSeconds: number }) {
    this.execs.push({ id, command, ...opts })
    if (this.own.has(id) && command.startsWith('tail ')) return { exitCode: 0, output: this.proxyLog }
    if (this.nextExec) { const r = this.nextExec; this.nextExec = null; return r }
    return { exitCode: 0, output: `ran: ${command}\n` }
  }
  async putArchive(id: string, path: string, tar: Buffer) {
    const dest = join((this.containers.get(id) || this.own.get(id))!.root, path)
    mkdirSync(dest, { recursive: true })
    const src = join(dest, '.incoming.tar')
    writeFileSync(src, tar)
    await tarExtract({ file: src, cwd: dest })
    rmSync(src)
  }
  async getArchive(id: string, path: string) {
    const root = this.containers.get(id)!.root
    const chunks: Buffer[] = []
    for await (const c of tarCreate({ cwd: join(root, path, '..'), portable: true }, [path.split('/').pop()!]) as AsyncIterable<Buffer>) chunks.push(Buffer.from(c))
    return Buffer.concat(chunks)
  }
  async inspect(idOrName: string) {
    for (const [Id, c] of this.own) if (Id === idOrName || c.name === idOrName) return { Id, State: { Running: c.running }, Config: { Labels: c.body.Labels } }
    return null
  }
  async list(instance: string) {
    return [...this.containers.entries()].filter(([, c]) => c.spec.labels[LABEL_INSTANCE] === instance)
      .map(([Id, c]) => ({ Id, Labels: c.spec.labels, State: c.state, Image: c.spec.image }))
  }
  async remove(id: string, instance: string) {
    const c = this.containers.get(id)
    if (!c || c.spec.labels[LABEL_INSTANCE] !== instance) return false
    rmSync(c.root, { recursive: true, force: true })
    this.containers.delete(id)
    return true
  }
}

let home: string
let docker: FakeSandboxDocker
let clock = 1_000_000

function service(extra: Partial<ConstructorParameters<typeof SandboxService>[0]> = {}) {
  return new SandboxService({ home: () => home, docker: docker as unknown as SandboxDocker, instance: 'inst', now: () => clock, forge: null, ...extra })
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'sandbox-home-'))
  docker = new FakeSandboxDocker()
  docker.images.add(EGRESS_IMAGE) // the proxy image; pulls below are the sandboxes' own
  clock = 1_000_000
})
afterEach(() => {
  for (const c of docker.containers.values()) rmSync(c.root, { recursive: true, force: true })
  for (const c of docker.own.values()) rmSync(c.root, { recursive: true, force: true })
  rmSync(home, { recursive: true, force: true })
})

describe('sandbox container settings', () => {
  it('uses Studio\'s own sandbox Docker when one is set, not the host\'s', () => {
    const own = { STUDIO_SANDBOX_DOCKER_HOST: 'unix:///run/sandbox-docker/docker.sock', DOCKER_HOST: 'unix:///var/run/docker.sock' }
    expect(sandboxDockerSocket(own, 'linux')).toBe('/run/sandbox-docker/docker.sock')
    expect(sandboxDockerSocket({ STUDIO_SANDBOX_DOCKER_HOST: 'tcp://sandbox-docker:2375' }, 'linux')).toBeNull()
    expect(sandboxDockerSocket({ DOCKER_HOST: 'unix:///x.sock' }, 'linux')).toBe('/x.sock')
  })

  it('has no host folders, no extra privileges and the asked network', () => {
    const body: any = sandboxBody({ name: 'x', image: 'alpine:3.22', labels: { a: 'b' }, network: 'none', memoryBytes: 1, nanoCpus: 2, pidsLimit: 3 })
    expect(body.HostConfig).toMatchObject({ NetworkMode: 'none', Binds: [], SecurityOpt: ['no-new-privileges'], Memory: 1, NanoCpus: 2, PidsLimit: 3 })
    expect(body.HostConfig.Privileged).toBeUndefined()
    expect(JSON.stringify(body)).not.toContain('docker.sock')
  })
})

describe('SandboxService', () => {
  it('makes a sandbox from a distro preset, pulling through the mirror and tagging it', async () => {
    const s = service()
    const { sandbox } = await s.tool('create', { distro: 'Fedora', network: 'none', minutes: 30, purpose: 'try it' }) as any
    expect(sandbox).toMatchObject({ image: DISTROS.fedora.image, network: 'none', purpose: 'try it', state: 'running', expiresAt: clock + 30 * 60_000 })
    expect(sandbox.id).toMatch(/^[a-f0-9]{10}$/)
    expect(sandbox.containerId).toBeUndefined()
    expect(docker.pulls).toEqual(['mirror.gcr.io/library/fedora:43'])
    expect(docker.tags).toEqual(['mirror.gcr.io/library/fedora:43->fedora:43'])
    const spec = [...docker.containers.values()][0].spec
    expect(spec.network).toBe('none')
    expect(spec.labels).toMatchObject({ [LABEL_SANDBOX]: sandbox.id, [LABEL_INSTANCE]: 'inst', [LABEL_EXPIRES]: String(clock + 30 * 60_000) })
    const listed = await s.tool('list', {}) as any
    expect(listed.sandboxes.map((x: any) => x.id)).toEqual([sandbox.id])
    expect(Object.keys(listed.distros)).toContain('opensuse')
  })

  it('falls back to Docker Hub when the mirror lacks the image, and says when neither has it', async () => {
    docker.failPull.add('mirror.gcr.io/library/debian:trixie-slim')
    await service().create({ distro: 'debian' })
    expect(docker.pulls).toEqual(['mirror.gcr.io/library/debian:trixie-slim', 'debian:trixie-slim'])
    docker.failPull.add('mirror.gcr.io/nobody/nothing:1').add('nobody/nothing:1')
    await expect(service().create({ image: 'nobody/nothing:1' })).rejects.toThrow(/Could not pull nobody\/nothing:1/)
  })

  it('refuses unknown distros, bad image names and a ninth sandbox', async () => {
    const s = service()
    await expect(s.create({ distro: 'windows' })).rejects.toThrow(/Unknown distro windows/)
    await expect(s.create({ image: '-v /:/host' })).rejects.toThrow(/Give a distro/)
    docker.images.add('alpine:3.22')
    for (let i = 0; i < 8; i++) await s.create({ distro: 'alpine' })
    await expect(s.create({ distro: 'alpine' })).rejects.toThrow(/8 sandboxes are running/)
  })

  it('runs commands with limits and keeps only the end of long output', async () => {
    const s = service()
    docker.images.add('alpine:3.22')
    const { id } = await s.create({ distro: 'alpine' })
    const ran = await s.exec({ sandbox: id, command: 'uname -a', timeoutSeconds: 99999 }) as any
    expect(ran).toMatchObject({ sandbox: id, exitCode: 0, timedOut: false, output: 'ran: uname -a\n', truncated: false })
    expect(docker.execs.at(-1)).toMatchObject({ workdir: '/work', timeoutSeconds: 3600 })
    docker.nextExec = { exitCode: 1, output: 'x'.repeat(100_000) + 'END' }
    const long = await s.exec({ sandbox: id, command: 'big' }) as any
    expect(long.truncated).toBe(true)
    expect(long.output.endsWith('END')).toBe(true)
    expect(long.output.length).toBe(64 * 1024)
    await expect(s.exec({ sandbox: id, command: '  ' })).rejects.toThrow(/Give the command/)
    await expect(s.exec({ sandbox: 'nope', command: 'ls' })).rejects.toThrow(/No sandbox nope/)
    await expect(s.exec({ sandbox: id, command: 'ls', workdir: 'work' })).rejects.toThrow(/absolute path/)
  })

  it('writes and reads files through archives, and refuses relative paths and big files', async () => {
    const s = service()
    docker.images.add('alpine:3.22')
    const { id } = await s.create({ distro: 'alpine' })
    expect(await s.writeFile({ sandbox: id, path: '/work/app/main.py', content: 'print("hi")\n' })).toMatchObject({ bytes: 12 })
    expect(await s.readFile({ sandbox: id, path: '/work/app/main.py' })).toMatchObject({ content: 'print("hi")\n', truncated: false })
    await expect(s.writeFile({ sandbox: id, path: 'main.py', content: '' })).rejects.toThrow(/absolute path/)
    await expect(s.writeFile({ sandbox: id, path: '/work/big', content: 'x'.repeat(1024 * 1024 + 1) })).rejects.toThrow(/1 MB/)
  })

  it('copies a repo into /work/NAME and records it', async () => {
    const s = service({
      clone: async (_url, _ref, dest) => { mkdirSync(dest, { recursive: true }); writeFileSync(join(dest, 'README.md'), 'hello') },
    })
    docker.images.add('alpine:3.22')
    const { id } = await s.create({ distro: 'alpine' })
    const out = await s.copyRepo({ sandbox: id, repo: 'http://forgejo:3000/wizard/lab-app.git', ref: 'main' })
    expect(out).toEqual({ sandbox: id, repo: 'http://forgejo:3000/wizard/lab-app.git', path: '/work/lab-app' })
    expect((await s.readFile({ sandbox: id, path: '/work/lab-app/README.md' }) as any).content).toBe('hello')
    expect((await s.list())[0].repos).toEqual(['http://forgejo:3000/wizard/lab-app.git'])
    await expect(s.copyRepo({ sandbox: id, repo: '--upload-pack=evil' })).rejects.toThrow(/git URL/)
    await expect(s.copyRepo({ sandbox: id, repo: 'file:///etc' })).rejects.toThrow(/git URL/)
    await expect(s.copyRepo({ sandbox: id, repo: 'https://github.com/o/r', ref: 'main; rm -rf /' })).rejects.toThrow(/ref/)
  })

  it('extends, removes, and sweeps expired or unknown sandboxes but never another Studio\'s', async () => {
    const s = service()
    docker.images.add('alpine:3.22')
    const a = await s.create({ distro: 'alpine', minutes: 5 })
    const b = await s.create({ distro: 'alpine', minutes: 60 })
    const other = await new SandboxService({ home: () => mkdtempSync(join(tmpdir(), 'other-')), docker: docker as unknown as SandboxDocker, instance: 'other', now: () => clock }).create({ distro: 'alpine', minutes: 5 })
    expect((await s.extend({ sandbox: b.id, minutes: 120 }) as any).expiresAt).toBe(clock + 180 * 60_000)
    clock += 10 * 60_000
    expect(await s.sweep()).toEqual([a.id])
    expect((await s.list()).map(x => x.id)).toEqual([b.id])
    expect([...docker.containers.values()].map(c => c.spec.labels[LABEL_SANDBOX]).sort()).toEqual([b.id, other.id].sort())
    expect(await s.remove({ sandbox: b.id })).toEqual({ sandbox: b.id, removed: true })
    expect(await s.list()).toEqual([])
    expect([...docker.containers.values()].map(c => c.spec.labels[LABEL_SANDBOX])).toEqual([other.id])
  })

  it('gives internet only through one shared proxy on an internal network', async () => {
    const s = service()
    docker.images.add('alpine:3.22').add(EGRESS_IMAGE)
    const [a, b] = await Promise.all([s.create({ distro: 'alpine' }), s.create({ distro: 'alpine' })])
    expect(docker.own.size).toBe(1)
    const [[proxyId, proxy]] = [...docker.own.entries()]
    expect(proxy).toMatchObject({ name: 'studio-sandbox-egress-inst', running: true, networks: ['studio-sandbox-net-inst'] })
    expect(proxy.body.HostConfig.Binds).toEqual([])
    expect(docker.networks.get('studio-sandbox-net-inst')).toMatchObject({ internal: true })
    for (const c of docker.containers.values()) {
      expect(c.spec.network).toBe('studio-sandbox-net-inst')
      expect(c.spec.env).toMatchObject({ HTTPS_PROXY: 'http://egress-proxy:3128', http_proxy: 'http://egress-proxy:3128' })
    }
    const conf = readFileSync(join(proxy.root, 'etc/squid/studio/squid.conf'), 'utf8')
    expect(conf).toMatch(/acl allowed dstdomain .*\.pypi\.org/)
    expect(conf).not.toMatch(/allowed dstdomain[^\n]*openai/)
    // offline sandboxes need no proxy
    expect((await s.create({ distro: 'alpine', network: 'none' })).network).toBe('none')
    expect([...docker.containers.values()].at(-1)!.spec.network).toBe('none')
    // the log names the sandbox each address belongs to, and keeps calls after a sandbox is gone
    const ipA = await docker.ipOn([...docker.containers.keys()][0])
    docker.proxyLog = `1795800000.100 ${ipA} CONNECT pypi.org 443 TCP_TUNNEL/200 900 12000\n` +
      `1795800001.200 ${ipA} CONNECT api.openai.com 443 TCP_DENIED/403 300 0\n`
    const log = await s.networkLog({}) as any
    expect(log.calls.map((c: any) => [c.sandbox, c.host, c.allowed])).toEqual([[a.id, 'api.openai.com', false], [a.id, 'pypi.org', true]])
    expect((await s.networkLog({ blocked: true })).calls).toHaveLength(1)
    expect((await s.networkLog({ sandbox: b.id })).calls).toHaveLength(0)
    await s.remove({ sandbox: a.id })
    expect((await s.networkLog({ sandbox: a.id })).calls).toHaveLength(2)
    // new rules reach the running proxy at once
    const rules = await s.setEgressRules({ mode: 'blocklist', block: ['*.huggingface.co', 'https://api.openai.com/v1'] })
    expect(rules).toMatchObject({ mode: 'blocklist', block: ['api.openai.com', 'huggingface.co'] })
    expect(readFileSync(join(proxy.root, 'etc/squid/studio/squid.conf'), 'utf8')).toMatch(/http_access allow all/)
    expect(docker.execs.at(-1)).toMatchObject({ id: proxyId, command: expect.stringContaining('squid -k reconfigure') })
    expect(s.egressRules().mode).toBe('blocklist')
    expect((await s.tool('network_log', {}) as any).rules.mode).toBe('blocklist')
  })

  it('lets a sandbox reach the extra sites its task needs, takes them back on remove, and never a blocked one', async () => {
    const s = service()
    docker.images.add('alpine:3.22')
    await s.create({ distro: 'alpine' }) // starts the proxy
    const [[proxyId, proxy]] = [...docker.own.entries()]
    const conf = () => readFileSync(join(proxy.root, 'etc/squid/studio/squid.conf'), 'utf8')
    const box = await s.create({ distro: 'alpine', allow: ['https://legendkeeper.com/app', 'api.legendkeeper.com'], purpose: 'test the LegendKeeper MCP' })
    expect(box.allow).toEqual(['legendkeeper.com'])
    expect(conf()).toContain(`acl sb_${box.id}_sites dstdomain .legendkeeper.com`)
    expect(docker.execs.at(-1)).toMatchObject({ id: proxyId, command: expect.stringContaining('squid -k reconfigure') })
    expect((await s.list()).find(b => b.id === box.id)?.allow).toEqual(['legendkeeper.com'])
    await expect(s.create({ distro: 'alpine', allow: ['legendkeeper.com', 'api.openai.com'] })).rejects.toThrow(/api\.openai\.com is on Studio's block list/)
    // offline sandboxes have no use for sites
    expect((await s.create({ distro: 'alpine', network: 'none', allow: ['legendkeeper.com'] })).allow).toEqual([])
    await s.remove({ sandbox: box.id })
    expect(conf()).not.toContain('legendkeeper')
    // reset brings back the default lists
    await s.setEgressRules({ mode: 'log', allow: [] })
    expect((await s.setEgressRules({ reset: true })).allow).toContain('npmjs.org')
  })

  it('says Docker is missing instead of failing oddly', async () => {
    docker.up = false
    await expect(service().create({ distro: 'alpine' })).rejects.toThrow(/Docker is not reachable/)
    expect(await service().sweep()).toEqual([])
    await expect(service().tool('format_disk', {})).rejects.toThrow(/Unknown sandbox action/)
  })
})
