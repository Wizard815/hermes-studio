import si from 'systeminformation'

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
  /** The Studio server's own pid, which the page will not offer to end. */
  serverPid: number
}

const MAX_PROCESSES = 400
const SNAPSHOT_TTL_MS = 1500
const PSEUDO_FS = /^(tmpfs|devtmpfs|overlay|squashfs|proc|sysfs|cgroup2?|nsfs|autofs|fuse\..*)$/i

const round = (value: number, digits = 1) => Math.round((Number(value) || 0) * 10 ** digits) / 10 ** digits

let staticInfo: Promise<{ hostname: string; platform: string; distro: string; release: string; arch: string; cpuModel: string }> | null = null
let cached: { at: number; snapshot: Promise<SystemSnapshot> } | null = null

function hostInfo() {
  staticInfo ??= Promise.all([si.osInfo(), si.cpu()]).then(([os, cpu]) => ({
    hostname: os.hostname,
    platform: os.platform,
    distro: os.distro,
    release: os.release,
    arch: os.arch,
    cpuModel: [cpu.manufacturer, cpu.brand].filter(Boolean).join(' '),
  }))
  return staticInfo
}

async function collect(): Promise<SystemSnapshot> {
  const [host, load, mem, fs, net, procs] = await Promise.all([
    hostInfo(),
    si.currentLoad(),
    si.mem(),
    si.fsSize().catch(() => []),
    si.networkStats('*').catch(() => []),
    si.processes(),
  ])
  const list = procs.list
    .map(p => ({
      pid: p.pid,
      parentPid: p.parentPid,
      name: p.name,
      user: p.user,
      state: p.state,
      cpuPercent: round(p.cpu),
      memPercent: round(p.mem),
      // systeminformation reports RSS in KiB.
      memRssBytes: Math.round((p.memRss || 0) * 1024),
      command: [p.command, p.params].filter(Boolean).join(' ').slice(0, 500),
    }))
    .sort((a, b) => b.cpuPercent - a.cpuPercent || b.memRssBytes - a.memRssBytes)
    .slice(0, MAX_PROCESSES)
  const seen = new Set<string>()
  return {
    timestamp: Date.now(),
    host: { ...host, uptimeSeconds: Math.round(si.time().uptime) },
    cpu: {
      percent: round(load.currentLoad),
      cores: load.cpus.map(core => round(core.load)),
      loadAverage: [load.avgLoad].filter(value => value > 0).map(value => round(value, 2)),
    },
    memory: {
      totalBytes: mem.total,
      usedBytes: mem.active,
      availableBytes: mem.available,
      swapTotalBytes: mem.swaptotal,
      swapUsedBytes: mem.swapused,
    },
    disks: fs
      .filter(disk => disk.size > 0 && !PSEUDO_FS.test(disk.type) && !seen.has(disk.fs) && seen.add(disk.fs))
      .map(disk => ({ mount: disk.mount, fs: disk.fs, type: disk.type, sizeBytes: disk.size, usedBytes: disk.used, percent: round(disk.use) })),
    network: net
      .filter(iface => iface.iface !== 'lo')
      .map(iface => ({
        iface: iface.iface,
        rxBytesPerSec: iface.rx_sec == null ? null : Math.max(0, Math.round(iface.rx_sec)),
        txBytesPerSec: iface.tx_sec == null ? null : Math.max(0, Math.round(iface.tx_sec)),
      })),
    processes: { total: procs.all, running: procs.running, list },
    serverPid: process.pid,
  }
}

/** One sample shared by every viewer for a moment, so several open pages do not multiply the cost. */
export function systemSnapshot(): Promise<SystemSnapshot> {
  if (cached && Date.now() - cached.at < SNAPSHOT_TTL_MS) return cached.snapshot
  const snapshot = collect()
  cached = { at: Date.now(), snapshot }
  snapshot.catch(() => { if (cached?.snapshot === snapshot) cached = null })
  return snapshot
}

export type ProcessSignal = 'SIGTERM' | 'SIGKILL'

/** Ends a process. Refuses init/the System process and the Studio server itself. */
export function signalProcess(pid: number, signal: ProcessSignal, kill: typeof process.kill = process.kill.bind(process)): void {
  if (!Number.isInteger(pid) || pid <= 4) throw Object.assign(new Error('That process cannot be ended from Studio'), { status: 400 })
  if (pid === process.pid) throw Object.assign(new Error('This is the Studio server itself'), { status: 400 })
  if (signal !== 'SIGTERM' && signal !== 'SIGKILL') throw Object.assign(new Error('Invalid signal'), { status: 400 })
  try {
    kill(pid, signal)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ESRCH') throw Object.assign(new Error('The process has already exited'), { status: 404 })
    if (code === 'EPERM') throw Object.assign(new Error('Studio is not allowed to end that process'), { status: 403 })
    throw error
  }
}
