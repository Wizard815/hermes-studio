import { existsSync } from 'node:fs'
import { hostname } from 'node:os'
import { dockerEngine, dockerSocket, engineError, demuxLogs } from '../system/docker'

/**
 * Docker for Test Lab (docs/test-lab.md), over the Engine API socket.
 * Everything a run makes carries its labels; removal only ever lists by those
 * labels and checks them again on each item before deleting it, so nothing
 * else on the Docker host is touched.
 */

export const LABEL_RUN = 'studio.testlab.run'
export const LABEL_INSTANCE = 'studio.testlab.instance'
export const LABEL_CREATED = 'studio.testlab.created'
export const LABEL_APP = 'studio.testlab.app'

export interface LabLabels { [LABEL_RUN]: string; [LABEL_INSTANCE]: string; [LABEL_CREATED]: string; [key: string]: string }

export function runLabels(runId: string, instance: string, createdAt: number, extra: Record<string, string> = {}): LabLabels {
  return { [LABEL_RUN]: runId, [LABEL_INSTANCE]: instance, [LABEL_CREATED]: String(createdAt), ...extra }
}

/** Does this object belong to the run (or, without a run id, to any run of this Studio)? */
export function belongsTo(labels: Record<string, string> | null | undefined, instance: string, runId?: string): boolean {
  if (!labels || labels[LABEL_INSTANCE] !== instance || !labels[LABEL_RUN]) return false
  return runId === undefined || labels[LABEL_RUN] === runId
}

export interface ContainerSpec {
  name: string
  image: string
  labels: Record<string, string>
  network: string
  aliases: string[]
  env?: Record<string, string>
  entrypoint?: string[]
  cmd?: string[]
  user?: string
  workingDir?: string
  memoryBytes?: number
  nanoCpus?: number
  pidsLimit?: number
  binds?: string[]
  readOnlyRoot?: boolean
  dropAllCaps?: boolean
  tmpfs?: Record<string, string>
}

export function containerBody(spec: ContainerSpec): Record<string, unknown> {
  return {
    Image: spec.image,
    Labels: spec.labels,
    ...(spec.env ? { Env: Object.entries(spec.env).map(([key, value]) => `${key}=${value}`) } : {}),
    ...(spec.entrypoint ? { Entrypoint: spec.entrypoint } : {}),
    ...(spec.cmd ? { Cmd: spec.cmd } : {}),
    ...(spec.user ? { User: spec.user } : {}),
    ...(spec.workingDir ? { WorkingDir: spec.workingDir } : {}),
    HostConfig: {
      NetworkMode: spec.network,
      RestartPolicy: { Name: 'no' },
      SecurityOpt: ['no-new-privileges'],
      ...(spec.memoryBytes ? { Memory: spec.memoryBytes } : {}),
      ...(spec.nanoCpus ? { NanoCpus: spec.nanoCpus } : {}),
      ...(spec.pidsLimit ? { PidsLimit: spec.pidsLimit } : {}),
      ...(spec.binds?.length ? { Binds: spec.binds } : {}),
      ...(spec.readOnlyRoot ? { ReadonlyRootfs: true } : {}),
      ...(spec.dropAllCaps ? { CapDrop: ['ALL'] } : {}),
      ...(spec.tmpfs ? { Tmpfs: spec.tmpfs } : {}),
    },
    NetworkingConfig: { EndpointsConfig: { [spec.network]: { Aliases: spec.aliases } } },
  }
}

export function memoryBytes(value: string | undefined): number | undefined {
  const match = /^(\d+)([kmg])$/i.exec(value || '')
  if (!match) return undefined
  return Number(match[1]) * 1024 ** ({ k: 1, m: 2, g: 3 } as Record<string, number>)[match[2].toLowerCase()]
}

const filters = (labels: string[]) => `filters=${encodeURIComponent(JSON.stringify({ label: labels }))}`

/** Progress lines of a streamed pull or build; throws on the stream's own error. */
function streamError(body: Buffer): string | null {
  for (const line of body.toString('utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      const item = JSON.parse(line)
      if (item.error || item.errorDetail) return String(item.errorDetail?.message || item.error)
    } catch { /* partial line */ }
  }
  return null
}

export interface RemovalResult { containers: string[]; networks: string[]; volumes: string[]; images: string[] }

export class LabDocker {
  constructor(private readonly socketPath: () => string | null = () => dockerSocket()) {}

  socket(): string | null { return this.socketPath() }

  private async api(method: string, path: string, body?: unknown, timeoutMs?: number) {
    const socket = this.socketPath()
    if (!socket) throw Object.assign(new Error('Docker is not reachable: mount /var/run/docker.sock into Studio'), { status: 503 })
    return dockerEngine(socket, method, path, body, timeoutMs)
  }

  private async json(method: string, path: string, body?: unknown, ok: number[] = [200], timeoutMs?: number): Promise<any> {
    const res = await this.api(method, path, body, timeoutMs)
    if (!ok.includes(res.status)) throw engineError(res.status, res.body)
    const text = res.body.toString('utf8')
    return text ? JSON.parse(text) : null
  }

  async status(): Promise<{ available: boolean; version?: string; socket?: string; error?: string }> {
    const socket = this.socketPath()
    if (!socket) return { available: false }
    try {
      const version = await this.json('GET', '/version', undefined, [200], 5000)
      return { available: true, version: version?.Version, socket }
    } catch (error) {
      return { available: false, socket, error: (error as Error).message }
    }
  }

  async hasImage(image: string): Promise<boolean> {
    const res = await this.api('GET', `/images/${encodeURIComponent(image)}/json`)
    return res.status === 200
  }

  /** Studio's own mounts, when it runs in Docker (bind mounts need host paths). */
  async ownMounts(): Promise<Array<{ inside: string; host: string }>> {
    const self = studioContainerId()
    if (!self) return []
    const info = await this.inspect(self).catch(() => null)
    return (info?.Mounts || []).map((mount: any) => ({ inside: String(mount.Destination), host: String(mount.Source) }))
      .sort((a: { inside: string }, b: { inside: string }) => b.inside.length - a.inside.length)
  }

  async pull(image: string): Promise<void> {
    const at = image.indexOf('@')
    const slash = image.lastIndexOf('/'), colon = image.lastIndexOf(':')
    const [from, tag] = at > 0 ? [image.slice(0, at), image.slice(at + 1)] : colon > slash ? [image.slice(0, colon), image.slice(colon + 1)] : [image, 'latest']
    const res = await this.api('POST', `/images/create?fromImage=${encodeURIComponent(from)}&tag=${encodeURIComponent(tag)}`, undefined, 30 * 60_000)
    if (res.status !== 200) throw engineError(res.status, res.body)
    const failed = streamError(res.body)
    if (failed) throw new Error(failed)
  }

  async tag(source: string, repo: string, tag: string): Promise<void> {
    const res = await this.api('POST', `/images/${encodeURIComponent(source)}/tag?repo=${encodeURIComponent(repo)}&tag=${encodeURIComponent(tag)}`)
    if (res.status !== 201 && res.status !== 200) throw engineError(res.status, res.body)
  }

  /** `docker build <git url>`: Docker clones it itself. The image carries the run's labels. */
  async build(gitUrl: string, image: string, labels: Record<string, string>, dockerfile?: string): Promise<void> {
    const query = [`remote=${encodeURIComponent(gitUrl)}`, `t=${encodeURIComponent(image)}`, `labels=${encodeURIComponent(JSON.stringify(labels))}`, 'rm=1', 'forcerm=1',
      ...(dockerfile ? [`dockerfile=${encodeURIComponent(dockerfile)}`] : [])].join('&')
    const res = await this.api('POST', `/build?${query}`, undefined, 60 * 60_000)
    if (res.status !== 200) throw engineError(res.status, res.body)
    const failed = streamError(res.body)
    if (failed) throw new Error(failed)
  }

  /** `docker build -` from a tar build context (a private forge repo Studio cloned itself). */
  async buildContext(context: Buffer, image: string, labels: Record<string, string>, dockerfile?: string): Promise<void> {
    const query = [`t=${encodeURIComponent(image)}`, `labels=${encodeURIComponent(JSON.stringify(labels))}`, 'rm=1', 'forcerm=1',
      ...(dockerfile ? [`dockerfile=${encodeURIComponent(dockerfile)}`] : [])].join('&')
    const res = await this.api('POST', `/build?${query}`, context, 60 * 60_000)
    if (res.status !== 200) throw engineError(res.status, res.body)
    const failed = streamError(res.body)
    if (failed) throw new Error(failed)
  }

  async createNetwork(name: string, labels: Record<string, string>): Promise<string> {
    // Internal: the apps reach each other, never the internet or the host's LAN.
    const created = await this.json('POST', '/networks/create', { Name: name, Driver: 'bridge', Internal: true, CheckDuplicate: true, Labels: labels }, [201])
    return String(created.Id)
  }

  async createContainer(spec: ContainerSpec): Promise<string> {
    const created = await this.json('POST', `/containers/create?name=${encodeURIComponent(spec.name)}`, containerBody(spec), [201])
    return String(created.Id)
  }

  async start(id: string): Promise<void> {
    const res = await this.api('POST', `/containers/${encodeURIComponent(id)}/start`)
    if (res.status !== 204 && res.status !== 304) throw engineError(res.status, res.body)
  }

  async kill(id: string): Promise<void> {
    const res = await this.api('POST', `/containers/${encodeURIComponent(id)}/kill`)
    if (res.status !== 204 && res.status !== 409 && res.status !== 404) throw engineError(res.status, res.body)
  }

  async inspect(id: string): Promise<any | null> {
    const res = await this.api('GET', `/containers/${encodeURIComponent(id)}/json`)
    if (res.status === 404) return null
    if (res.status !== 200) throw engineError(res.status, res.body)
    return JSON.parse(res.body.toString('utf8'))
  }

  async logs(id: string, tail = 200): Promise<string> {
    const res = await this.api('GET', `/containers/${encodeURIComponent(id)}/logs?stdout=1&stderr=1&timestamps=0&tail=${Math.max(1, Math.min(5000, tail))}`)
    if (res.status !== 200) throw engineError(res.status, res.body)
    return demuxLogs(res.body)
  }

  async containers(labels: string[]): Promise<Array<{ Id: string; Names?: string[]; Labels?: Record<string, string>; State?: string }>> {
    return this.json('GET', `/containers/json?all=1&${filters(labels)}`)
  }

  async networks(labels: string[]): Promise<Array<{ Id: string; Name: string; Labels?: Record<string, string> }>> {
    return this.json('GET', `/networks?${filters(labels)}`)
  }

  async volumes(labels: string[]): Promise<Array<{ Name: string; Labels?: Record<string, string> }>> {
    return (await this.json('GET', `/volumes?${filters(labels)}`))?.Volumes || []
  }

  async images(labels: string[]): Promise<Array<{ Id: string; Labels?: Record<string, string> }>> {
    return this.json('GET', `/images/json?${filters(labels)}`)
  }

  /**
   * Remove a run's containers (with their anonymous volumes), networks,
   * labelled volumes and built images. Lists by label, then checks each
   * item's labels again: nothing without the run's labels is ever removed.
   */
  async removeRun(instance: string, runId: string, keepImages = false): Promise<RemovalResult> {
    const wanted = [`${LABEL_RUN}=${runId}`, `${LABEL_INSTANCE}=${instance}`]
    const removed: RemovalResult = { containers: [], networks: [], volumes: [], images: [] }
    for (const container of await this.containers(wanted)) {
      if (!belongsTo(container.Labels, instance, runId)) continue
      const res = await this.api('DELETE', `/containers/${encodeURIComponent(container.Id)}?force=1&v=1`, undefined, 60_000)
      if (res.status === 204 || res.status === 404) removed.containers.push(container.Id)
      else throw engineError(res.status, res.body)
    }
    for (const network of await this.networks(wanted)) {
      if (!belongsTo(network.Labels, instance, runId)) continue
      const res = await this.api('DELETE', `/networks/${encodeURIComponent(network.Id)}`)
      if (res.status === 204 || res.status === 404) removed.networks.push(network.Name)
      else throw engineError(res.status, res.body)
    }
    for (const volume of await this.volumes(wanted)) {
      if (!belongsTo(volume.Labels, instance, runId)) continue
      const res = await this.api('DELETE', `/volumes/${encodeURIComponent(volume.Name)}`)
      if (res.status === 204 || res.status === 404) removed.volumes.push(volume.Name)
    }
    if (!keepImages) {
      for (const image of await this.images(wanted)) {
        if (!belongsTo(image.Labels, instance, runId)) continue
        const res = await this.api('DELETE', `/images/${encodeURIComponent(image.Id)}?force=1`)
        if (res.status === 200 || res.status === 404) removed.images.push(image.Id)
      }
    }
    return removed
  }

  /** Run ids of this Studio found on Docker, with when each was made (from the labels). */
  async labelledRuns(instance: string): Promise<Map<string, number>> {
    const runs = new Map<string, number>()
    const wanted = [LABEL_RUN, `${LABEL_INSTANCE}=${instance}`]
    const note = (labels?: Record<string, string>) => {
      if (!belongsTo(labels, instance)) return
      const created = Number(labels![LABEL_CREATED]) || 0
      const id = labels![LABEL_RUN]
      runs.set(id, Math.min(runs.get(id) ?? created, created))
    }
    for (const container of await this.containers(wanted)) note(container.Labels)
    for (const network of await this.networks(wanted)) note(network.Labels)
    return runs
  }
}

/** Studio's own container id when it runs in Docker (the hostname Docker gives it). */
export function studioContainerId(): string | null {
  return existsSync('/.dockerenv') ? hostname() : null
}
