import { request } from '../client'

export interface SystemProcess {
  pid: number
  parentPid: number
  name: string
  user: string
  state: string
  cpuPercent: number
  memPercent: number
  memRssBytes: number
  command: string
}

export interface SystemSnapshot {
  timestamp: number
  host: { hostname: string; platform: string; distro: string; release: string; arch: string; uptimeSeconds: number; cpuModel: string }
  cpu: { percent: number; cores: number[]; loadAverage: number[] }
  memory: { totalBytes: number; usedBytes: number; availableBytes: number; swapTotalBytes: number; swapUsedBytes: number }
  disks: Array<{ mount: string; fs: string; type: string; sizeBytes: number; usedBytes: number; percent: number }>
  network: Array<{ iface: string; rxBytesPerSec: number | null; txBytesPerSec: number | null }>
  processes: { total: number; running: number; list: SystemProcess[] }
  serverPid: number
}

export interface DockerContainer {
  id: string
  name: string
  image: string
  state: string
  status: string
  ports: string[]
  composeProject?: string
}

export interface DockerStatus {
  available: boolean
  version?: string
  error?: string
  containers: DockerContainer[]
}

const base = '/api/studio/system'
const post = <T>(path: string, body: unknown = {}) => request<T>(path, { method: 'POST', body: JSON.stringify(body) })

export const fetchSystemSnapshot = () => request<SystemSnapshot>(base)
export const signalProcess = (pid: number, signal: 'SIGTERM' | 'SIGKILL') => post<{ ok: true }>(`${base}/processes/${pid}/signal`, { signal })
export const fetchDocker = () => request<DockerStatus>(`${base}/docker`)
export const dockerAction = (id: string, action: 'start' | 'stop' | 'restart') => post<{ ok: true }>(`${base}/docker/containers/${id}/${action}`)
export const fetchDockerLogs = (id: string, tail = 200) => request<{ logs: string }>(`${base}/docker/containers/${id}/logs?tail=${tail}`)
