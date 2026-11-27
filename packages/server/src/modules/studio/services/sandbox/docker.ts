import { dockerEngine, sandboxDockerSocket, engineError, demuxLogs } from '../system/docker'

/** Labels on everything a sandbox makes; removal checks them again before deleting. */
export const LABEL_SANDBOX = 'studio.sandbox.id'
export const LABEL_INSTANCE = 'studio.sandbox.instance'
export const LABEL_EXPIRES = 'studio.sandbox.expires'

export interface SandboxSpec {
  name: string
  image: string
  labels: Record<string, string>
  /** 'bridge' (internet, no access to Studio's other networks) or 'none' (no network at all). */
  network: 'bridge' | 'none'
  memoryBytes: number
  nanoCpus: number
  pidsLimit: number
  env?: Record<string, string>
}

export function sandboxBody(spec: SandboxSpec): Record<string, unknown> {
  return {
    Image: spec.image,
    Labels: spec.labels,
    // Kept alive until removed; commands run with exec.
    Entrypoint: ['sh', '-c', 'mkdir -p /work; trap "exit 0" TERM; while :; do sleep 3600 & wait $!; done'],
    Cmd: [],
    WorkingDir: '/',
    ...(spec.env ? { Env: Object.entries(spec.env).map(([key, value]) => `${key}=${value}`) } : {}),
    HostConfig: {
      NetworkMode: spec.network,
      RestartPolicy: { Name: 'no' },
      SecurityOpt: ['no-new-privileges'],
      Memory: spec.memoryBytes,
      NanoCpus: spec.nanoCpus,
      PidsLimit: spec.pidsLimit,
      // No host folders, no Docker socket: the sandbox sees only what Studio copies in.
      Binds: [],
    },
  }
}

export interface ExecResult { exitCode: number; output: string }

export class SandboxDocker {
  constructor(private readonly socketPath: () => string | null = () => sandboxDockerSocket()) {}

  private async api(method: string, path: string, body?: unknown, timeoutMs?: number) {
    const socket = this.socketPath()
    if (!socket) throw Object.assign(new Error('Docker is not reachable: run the sandbox-docker sidecar and set STUDIO_SANDBOX_DOCKER_HOST (docs/sandbox.md)'), { status: 503 })
    return dockerEngine(socket, method, path, body, timeoutMs)
  }

  private async json(method: string, path: string, body?: unknown, ok: number[] = [200], timeoutMs?: number): Promise<any> {
    const res = await this.api(method, path, body, timeoutMs)
    if (!ok.includes(res.status)) throw engineError(res.status, res.body)
    const text = res.body.toString('utf8')
    return text ? JSON.parse(text) : null
  }

  available(): boolean { return !!this.socketPath() }

  async hasImage(image: string): Promise<boolean> {
    return (await this.api('GET', `/images/${encodeURIComponent(image)}/json`)).status === 200
  }

  async imageId(image: string): Promise<string> {
    const info = await this.json('GET', `/images/${encodeURIComponent(image)}/json`)
    return String(info?.RepoDigests?.[0] || info?.Id || '')
  }

  async pull(image: string): Promise<void> {
    const at = image.indexOf('@')
    const slash = image.lastIndexOf('/'), colon = image.lastIndexOf(':')
    const [from, tag] = at > 0 ? [image.slice(0, at), image.slice(at + 1)] : colon > slash ? [image.slice(0, colon), image.slice(colon + 1)] : [image, 'latest']
    const res = await this.api('POST', `/images/create?fromImage=${encodeURIComponent(from)}&tag=${encodeURIComponent(tag)}`, undefined, 30 * 60_000)
    if (res.status !== 200) throw engineError(res.status, res.body)
    for (const line of res.body.toString('utf8').split('\n')) {
      try { const item = JSON.parse(line); if (item.error) throw new Error(String(item.errorDetail?.message || item.error)) } catch (error) { if (!(error instanceof SyntaxError)) throw error }
    }
  }

  async tag(source: string, target: string): Promise<void> {
    const slash = target.lastIndexOf('/'), colon = target.lastIndexOf(':')
    const [repo, tag] = colon > slash ? [target.slice(0, colon), target.slice(colon + 1)] : [target, 'latest']
    const res = await this.api('POST', `/images/${encodeURIComponent(source)}/tag?repo=${encodeURIComponent(repo)}&tag=${encodeURIComponent(tag)}`)
    if (res.status !== 201 && res.status !== 200) throw engineError(res.status, res.body)
  }

  async create(spec: SandboxSpec): Promise<string> {
    const created = await this.json('POST', `/containers/create?name=${encodeURIComponent(spec.name)}`, sandboxBody(spec), [201])
    const id = String(created.Id)
    const res = await this.api('POST', `/containers/${encodeURIComponent(id)}/start`)
    if (res.status !== 204 && res.status !== 304) throw engineError(res.status, res.body)
    return id
  }

  /** Runs `sh -c command` (as `env`'s HERMES_SANDBOX_COMMAND) and waits for it, up to timeoutMs. */
  async exec(id: string, command: string, opts: { workdir?: string; timeoutSeconds: number; user?: string }): Promise<ExecResult> {
    const seconds = Math.max(1, Math.floor(opts.timeoutSeconds))
    // `timeout` (coreutils or busybox) ends a runaway command; images without it just run it.
    const script = `if command -v timeout >/dev/null 2>&1; then exec timeout -s KILL ${seconds} sh -c "$HERMES_SANDBOX_COMMAND"; else exec sh -c "$HERMES_SANDBOX_COMMAND"; fi`
    const created = await this.json('POST', `/containers/${encodeURIComponent(id)}/exec`, {
      AttachStdout: true, AttachStderr: true, Tty: false, Cmd: ['sh', '-c', script],
      Env: [`HERMES_SANDBOX_COMMAND=${command}`], WorkingDir: opts.workdir || '/work', ...(opts.user ? { User: opts.user } : {}),
    }, [201])
    const execId = String(created.Id)
    const res = await this.api('POST', `/exec/${encodeURIComponent(execId)}/start`, { Detach: false, Tty: false }, (seconds + 15) * 1000)
    if (res.status !== 200) throw engineError(res.status, res.body)
    const info = await this.json('GET', `/exec/${encodeURIComponent(execId)}/json`)
    return { exitCode: typeof info?.ExitCode === 'number' ? info.ExitCode : -1, output: demuxLogs(res.body) }
  }

  /** Unpacks a tar into `path` inside the container (the folder must exist). */
  async putArchive(id: string, path: string, tar: Buffer): Promise<void> {
    const res = await this.api('PUT', `/containers/${encodeURIComponent(id)}/archive?path=${encodeURIComponent(path)}`, tar, 10 * 60_000)
    if (res.status !== 200) throw engineError(res.status, res.body)
  }

  /** A tar of `path` inside the container. */
  async getArchive(id: string, path: string): Promise<Buffer> {
    const res = await this.api('GET', `/containers/${encodeURIComponent(id)}/archive?path=${encodeURIComponent(path)}`, undefined, 5 * 60_000)
    if (res.status === 404) throw Object.assign(new Error(`${path} does not exist in the sandbox`), { status: 404 })
    if (res.status !== 200) throw engineError(res.status, res.body)
    return res.body
  }

  async inspect(id: string): Promise<any | null> {
    const res = await this.api('GET', `/containers/${encodeURIComponent(id)}/json`)
    if (res.status === 404) return null
    if (res.status !== 200) throw engineError(res.status, res.body)
    return JSON.parse(res.body.toString('utf8'))
  }

  async list(instance: string): Promise<Array<{ Id: string; Labels?: Record<string, string>; State?: string; Image?: string }>> {
    const filters = encodeURIComponent(JSON.stringify({ label: [`${LABEL_INSTANCE}=${instance}`] }))
    const all = await this.json('GET', `/containers/json?all=1&filters=${filters}`)
    // A Docker that ignores the filter still can't make Studio touch anything else.
    return (all || []).filter((c: any) => c?.Labels?.[LABEL_INSTANCE] === instance && c?.Labels?.[LABEL_SANDBOX])
  }

  /** Removes the container (and its anonymous volumes) if it is this Studio's sandbox. */
  async remove(id: string, instance: string): Promise<boolean> {
    const info = await this.inspect(id)
    if (!info || info.Config?.Labels?.[LABEL_INSTANCE] !== instance || !info.Config?.Labels?.[LABEL_SANDBOX]) return false
    const res = await this.api('DELETE', `/containers/${encodeURIComponent(id)}?force=1&v=1`)
    if (res.status !== 204 && res.status !== 404) throw engineError(res.status, res.body)
    return true
  }
}
