import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DockerClient, demuxLogs, dockerSocket, parseContainers } from '../../packages/server/src/modules/studio/services/system/docker'
import { signalProcess, systemSnapshot } from '../../packages/server/src/modules/studio/services/system/monitor'

describe('system snapshot', () => {
  it('reports CPU cores, memory and a CPU-sorted process list including this process', async () => {
    const snapshot = await systemSnapshot()
    expect(snapshot.cpu.cores.length).toBeGreaterThan(0)
    expect(snapshot.memory.totalBytes).toBeGreaterThan(0)
    expect(snapshot.serverPid).toBe(process.pid)
    const cpu = snapshot.processes.list.map(p => p.cpuPercent)
    expect(cpu).toEqual([...cpu].sort((a, b) => b - a))
    expect(snapshot.processes.list.some(p => p.pid === process.pid)).toBe(true)
    // A second viewer within the cache window shares the same sample.
    expect((await systemSnapshot()).timestamp).toBe(snapshot.timestamp)
  })

  it('ends ordinary processes but never init, the System process or Studio itself', () => {
    const sent: Array<[number, string]> = []
    const kill = ((pid: number, signal: string) => { sent.push([pid, signal]); return true }) as typeof process.kill
    signalProcess(4242, 'SIGTERM', kill)
    signalProcess(4243, 'SIGKILL', kill)
    expect(sent).toEqual([[4242, 'SIGTERM'], [4243, 'SIGKILL']])
    expect(() => signalProcess(1, 'SIGKILL', kill)).toThrow(/cannot be ended/)
    expect(() => signalProcess(process.pid, 'SIGTERM', kill)).toThrow(/Studio server/)
    expect(() => signalProcess(4244, 'SIGHUP' as any, kill)).toThrow(/Invalid signal/)
    const gone = (() => { throw Object.assign(new Error('x'), { code: 'ESRCH' }) }) as typeof process.kill
    expect(() => signalProcess(4245, 'SIGTERM', gone)).toThrow(/already exited/)
  })
})

describe('Docker', () => {
  it('finds the engine from DOCKER_HOST or the platform default', () => {
    expect(dockerSocket({ DOCKER_HOST: 'unix:///run/user/1000/docker.sock' }, 'linux')).toBe('/run/user/1000/docker.sock')
    expect(dockerSocket({ DOCKER_HOST: 'npipe:////./pipe/docker_engine' }, 'win32')).toBe('\\\\.\\pipe\\docker_engine')
    expect(dockerSocket({}, 'win32')).toBe('\\\\.\\pipe\\docker_engine')
    expect(dockerSocket({ DOCKER_HOST: 'tcp://10.0.0.2:2376' }, 'linux')).toBeNull()
  })

  it('lists running containers first with published ports and compose project', () => {
    const containers = parseContainers([
      { Id: 'b'.repeat(64), Names: ['/redis'], Image: 'redis:7', State: 'exited', Status: 'Exited (0) 2 hours ago', Ports: [] },
      { Id: 'a'.repeat(64), Names: ['/studio'], Image: 'ekko/studio', State: 'running', Status: 'Up 3 days',
        Ports: [{ PublicPort: 6060, PrivatePort: 6060, Type: 'tcp' }, { PublicPort: 6060, PrivatePort: 6060, Type: 'tcp' }, { PrivatePort: 9000, Type: 'tcp' }],
        Labels: { 'com.docker.compose.project': 'hermes' } },
    ])
    expect(containers).toEqual([
      { id: 'a'.repeat(12), name: 'studio', image: 'ekko/studio', state: 'running', status: 'Up 3 days', ports: ['6060→6060/tcp'], composeProject: 'hermes' },
      { id: 'b'.repeat(12), name: 'redis', image: 'redis:7', state: 'exited', status: 'Exited (0) 2 hours ago', ports: [] },
    ])
  })

  it('splits multiplexed stdout/stderr log frames and passes TTY logs through', () => {
    const frame = (stream: number, text: string) => {
      const head = Buffer.alloc(8); head[0] = stream; head.writeUInt32BE(Buffer.byteLength(text), 4)
      return Buffer.concat([head, Buffer.from(text)])
    }
    expect(demuxLogs(Buffer.concat([frame(1, 'ready\n'), frame(2, 'warn\n')]))).toBe('ready\nwarn\n')
    expect(demuxLogs(Buffer.from('plain tty output\n'))).toBe('plain tty output\n')
  })

  describe.runIf(process.platform !== 'win32')('against an engine socket', () => {
    let dir = ''
    let server: Server
    const calls: string[] = []

    afterEach(async () => {
      await new Promise(resolve => server.close(resolve))
      await rm(dir, { recursive: true, force: true })
      calls.length = 0
    })

    async function engine() {
      dir = await mkdtemp(join(tmpdir(), 'docker-'))
      const socket = join(dir, 'docker.sock')
      server = createServer((req, res) => {
        calls.push(`${req.method} ${req.url}`)
        if (req.url === '/v1.41/version') return res.end(JSON.stringify({ Version: '27.3.1' }))
        if (req.url === '/v1.41/containers/json?all=1') return res.end(JSON.stringify([{ Id: 'c'.repeat(64), Names: ['/web'], Image: 'nginx', State: 'running', Status: 'Up', Ports: [] }]))
        if (req.url === `/v1.41/containers/${'c'.repeat(12)}/stop`) { res.statusCode = 204; return res.end() }
        if (req.url === `/v1.41/containers/${'d'.repeat(12)}/start`) { res.statusCode = 404; return res.end(JSON.stringify({ message: 'No such container' })) }
        res.statusCode = 404; res.end()
      })
      await new Promise<void>(resolve => server.listen(socket, resolve))
      return new DockerClient(() => socket)
    }

    it('reads the engine, lists containers and stops one', async () => {
      const docker = await engine()
      expect(await docker.status()).toEqual({ available: true, version: '27.3.1' })
      expect((await docker.containers()).map(c => c.name)).toEqual(['web'])
      await docker.action('c'.repeat(12), 'stop')
      expect(calls).toContain(`POST /v1.41/containers/${'c'.repeat(12)}/stop`)
      await expect(docker.action('d'.repeat(12), 'start')).rejects.toMatchObject({ message: 'No such container', status: 404 })
      await expect(docker.action('../../version', 'stop')).rejects.toThrow(/Invalid container id/)
    })
  })

  it('reports Docker as unavailable without a socket', async () => {
    expect(await new DockerClient(() => null).status()).toEqual({ available: false })
    await expect(new DockerClient(() => null).containers()).rejects.toThrow(/docker.sock/)
  })
})
