/**
 * Self-check: a small probe run inside a clean room right after it starts. It
 * reports what the agent can see from inside (mounts, user, capabilities,
 * environment variable names, network) and Studio judges each item against
 * the room's settings. Values of environment variables never leave the room.
 */

export interface ProbeMount { path: string; readOnly: boolean; writable: boolean; type: string }
export interface ProbeNet { target: string; via: 'direct' | 'proxy' | 'studio'; reached: boolean; status?: number; error?: string }

/** What the probe prints (one JSON object). */
export interface ProbeOutput {
  uid: number
  gid: number
  user: string
  noNewPrivs: boolean
  capEff: string[]
  capBnd: string[]
  mounts: ProbeMount[]
  envNames: string[]
  dockerSocket: string[]
  network: ProbeNet[]
}

export type CheckState = 'pass' | 'warn' | 'fail' | 'info'

export interface CheckItem { id: string; state: CheckState; detail: string }

export interface SelfCheckResult {
  at: string
  container: string
  /** pass: every check passed; warn: something to look at; fail: a wall is missing. */
  state: 'pass' | 'warn' | 'fail'
  checks: CheckItem[]
  probe?: ProbeOutput
  error?: string
}

/** Linux capability numbers, for reading /proc/self/status. */
export const CAPABILITY_NAMES = [
  'CHOWN', 'DAC_OVERRIDE', 'DAC_READ_SEARCH', 'FOWNER', 'FSETID', 'KILL', 'SETGID', 'SETUID', 'SETPCAP', 'LINUX_IMMUTABLE',
  'NET_BIND_SERVICE', 'NET_BROADCAST', 'NET_ADMIN', 'NET_RAW', 'IPC_LOCK', 'IPC_OWNER', 'SYS_MODULE', 'SYS_RAWIO', 'SYS_CHROOT', 'SYS_PTRACE',
  'SYS_PACCT', 'SYS_ADMIN', 'SYS_BOOT', 'SYS_NICE', 'SYS_RESOURCE', 'SYS_TIME', 'SYS_TTY_CONFIG', 'MKNOD', 'LEASE', 'AUDIT_WRITE',
  'AUDIT_CONTROL', 'SETFCAP', 'MAC_OVERRIDE', 'MAC_ADMIN', 'SYSLOG', 'WAKE_ALARM', 'BLOCK_SUSPEND', 'AUDIT_READ', 'PERFMON', 'BPF', 'CHECKPOINT_RESTORE',
]

/**
 * The probe itself (plain node, no packages). Its settings come in
 * STUDIO_PROBE (JSON: studioPort, proxyPort, blockedHost, allowedHost; direct: false skips the direct tries).
 */
export const PROBE_SCRIPT = `// Studio clean room self-check. Prints one JSON line; never prints env values.
import { accessSync, constants, existsSync, readFileSync } from 'node:fs'
import { connect } from 'node:net'
const cfg = JSON.parse(process.env.STUDIO_PROBE || '{}')
delete process.env.STUDIO_PROBE
const status = Object.fromEntries(readFileSync('/proc/self/status', 'utf8').split('\\n').map(line => line.split(':\\t')).filter(p => p.length === 2))
const caps = hex => { let v = 0n; try { v = BigInt('0x' + (hex || '0').trim()) } catch {}; const out = []; for (let b = 0; b < 64; b++) if (v & (1n << BigInt(b))) out.push(b); return out }
const uid = process.getuid(), gid = process.getgid()
let user = String(uid)
try { const row = readFileSync('/etc/passwd', 'utf8').split('\\n').find(l => l.split(':')[2] === String(uid)); if (row) user = row.split(':')[0] } catch {}
const skip = /^\\/(proc|sys|dev)(\\/|$)|^\\/etc\\/(hostname|hosts|resolv\\.conf)$/
const mounts = []
for (const line of readFileSync('/proc/self/mountinfo', 'utf8').split('\\n').filter(Boolean)) {
  const parts = line.split(' ')
  const path = parts[4].replace(/\\\\040/g, ' ')
  if (skip.test(path)) continue
  const dash = parts.indexOf('-')
  const readOnly = parts[5].split(',').includes('ro')
  let writable = false
  try { accessSync(path, constants.W_OK); writable = !readOnly } catch {}
  mounts.push({ path, readOnly, writable, type: parts[dash + 1] || '' })
}
const tcp = (host, port, send, ms = 5000) => new Promise(done => {
  const socket = connect({ host, port })
  let data = ''
  const finish = result => { clearTimeout(timer); socket.destroy(); done(result) }
  const timer = setTimeout(() => finish({ reached: false, error: 'timeout' }), ms)
  socket.on('connect', () => { if (!send) finish({ reached: true }); else socket.write(send) })
  socket.on('data', chunk => { data += chunk; if (data.includes('\\r\\n')) finish({ reached: true, status: Number(data.split(' ')[1]) || 0 }) })
  socket.on('error', error => finish({ reached: false, error: error.code || error.message }))
})
const network = []
if (cfg.direct !== false) {
  network.push({ target: '1.1.1.1:443', via: 'direct', ...await tcp('1.1.1.1', 443) })
  network.push({ target: (cfg.blockedHost || 'example.com') + ':443', via: 'direct', ...await tcp(cfg.blockedHost || 'example.com', 443) })
}
if (cfg.proxyPort) {
  const through = async host => { const r = await tcp('127.0.0.1', cfg.proxyPort, 'CONNECT ' + host + ':443 HTTP/1.1\\r\\nHost: ' + host + ':443\\r\\n\\r\\n', 10000); return { ...r, reached: r.status === 200 } }
  network.push({ target: (cfg.blockedHost || 'example.com') + ':443', via: 'proxy', ...await through(cfg.blockedHost || 'example.com') })
  if (cfg.allowedHost) network.push({ target: cfg.allowedHost + ':443', via: 'proxy', ...await through(cfg.allowedHost) })
}
if (cfg.studioPort) {
  const r = await tcp('127.0.0.1', cfg.studioPort, 'GET /api/auth/status HTTP/1.1\\r\\nHost: studio\\r\\nConnection: close\\r\\n\\r\\n')
  network.push({ target: 'studio:/api/auth/status', via: 'studio', ...r, reached: r.status > 0 && r.status !== 403 })
}
const dockerSocket = ['/var/run/docker.sock', '/run/docker.sock', '/var/run/docker', '/run/containerd/containerd.sock'].filter(p => existsSync(p))
console.log(JSON.stringify({
  uid, gid, user,
  noNewPrivs: String(status.NoNewPrivs || '').trim() === '1',
  capEff: caps(status.CapEff), capBnd: caps(status.CapBnd),
  mounts, envNames: Object.keys(process.env).sort(), dockerSocket, network,
}))
`

export interface SelfCheckExpectations {
  network: 'studio' | 'allowlist' | 'internet'
  readOnlyRoot: boolean
  dropAllCaps: boolean
  capAdd: string[]
  /** The uid the room should run as. */
  uid: number
  workspace: string
  /** Paths that must be mounted read-only (the agent program, protected config). */
  readOnlyPaths: string[]
  allowedHost?: string
  blockedHost: string
}

/** Raw probe output (capability numbers) to names. */
export function normalizeProbe(raw: any): ProbeOutput {
  const names = (list: unknown) => Array.isArray(list) ? list.map(bit => CAPABILITY_NAMES[Number(bit)] || `CAP_${bit}`) : []
  return {
    uid: Number(raw?.uid), gid: Number(raw?.gid), user: String(raw?.user || ''),
    noNewPrivs: !!raw?.noNewPrivs,
    capEff: names(raw?.capEff), capBnd: names(raw?.capBnd),
    mounts: Array.isArray(raw?.mounts) ? raw.mounts : [],
    envNames: Array.isArray(raw?.envNames) ? raw.envNames.map(String) : [],
    dockerSocket: Array.isArray(raw?.dockerSocket) ? raw.dockerSocket.map(String) : [],
    network: Array.isArray(raw?.network) ? raw.network : [],
  }
}

/** Judge a probe's output against what the room's settings promise. */
export function judgeProbe(probe: ProbeOutput, expect: SelfCheckExpectations): CheckItem[] {
  const checks: CheckItem[] = []
  const add = (id: string, state: CheckState, detail: string) => checks.push({ id, state, detail })
  const mount = (path: string) => probe.mounts.find(entry => entry.path === path)
    || [...probe.mounts].sort((a, b) => b.path.length - a.path.length).find(entry => path.startsWith(`${entry.path}/`))

  add('docker-socket', probe.dockerSocket.length ? 'fail' : 'pass', probe.dockerSocket.length ? probe.dockerSocket.join(', ') : 'absent')
  add('user', probe.uid === expect.uid ? (probe.uid === 0 ? 'warn' : 'pass') : 'fail', `${probe.user} (uid ${probe.uid}, gid ${probe.gid})`)
  add('no-new-privileges', probe.noNewPrivs ? 'pass' : 'fail', probe.noNewPrivs ? 'on' : 'off')
  const extra = probe.capBnd.filter(cap => !expect.capAdd.includes(cap))
  add('capabilities', expect.dropAllCaps ? (extra.length ? 'fail' : 'pass') : 'info', probe.capBnd.length ? probe.capBnd.join(', ') : 'none')

  const root = mount('/')
  add('root-filesystem', !root ? 'warn' : root.readOnly ? 'pass' : expect.readOnlyRoot ? 'fail' : 'info', root ? (root.readOnly ? 'read-only' : 'writable') : 'unknown')
  const workspace = mount(expect.workspace)
  add('workspace', workspace?.writable ? 'pass' : 'fail', `${expect.workspace}: ${workspace ? (workspace.writable ? 'writable' : 'not writable for the agent') : 'not mounted'}`)
  for (const path of expect.readOnlyPaths) {
    const entry = mount(path)
    add('read-only-mount', entry && !entry.writable ? 'pass' : 'fail', `${path}: ${entry ? (entry.writable ? 'writable' : 'read-only') : 'not mounted'}`)
  }
  add('mounts', 'info', probe.mounts.map(entry => `${entry.path} ${entry.writable ? 'rw' : 'ro'}`).join(', '))
  add('environment', 'info', probe.envNames.join(', '))

  const net = (via: ProbeNet['via'], target?: string) => probe.network.find(entry => entry.via === via && (!target || entry.target.startsWith(target)))
  const directHit = probe.network.filter(entry => entry.via === 'direct' && entry.reached)
  add('direct-internet', directHit.length ? 'fail' : 'pass', directHit.length ? `reached ${directHit.map(entry => entry.target).join(', ')}` : 'no route out')
  const blocked = net('proxy', expect.blockedHost)
  if (blocked) {
    const shouldBlock = expect.network !== 'internet'
    add('proxy-blocks', blocked.reached === !shouldBlock ? 'pass' : 'fail', `${blocked.target}: ${blocked.reached ? 'allowed' : `refused${blocked.status ? ` (${blocked.status})` : ''}`}`)
  }
  if (expect.allowedHost) {
    const allowed = net('proxy', expect.allowedHost)
    // An allowed host that does not answer is a network problem outside the room, not a hole in it.
    if (allowed) add('proxy-allows', allowed.reached ? 'pass' : 'warn', `${allowed.target}: ${allowed.reached ? 'reachable' : `not reachable${allowed.status ? ` (${allowed.status})` : allowed.error ? ` (${allowed.error})` : ''}`}`)
  }
  const studio = net('studio')
  if (studio) add('studio-api', studio.reached ? 'fail' : 'pass', studio.reached ? `Studio's API answered (${studio.status})` : 'only the model proxies')
  return checks
}

export function overallState(checks: CheckItem[]): SelfCheckResult['state'] {
  if (checks.some(check => check.state === 'fail')) return 'fail'
  if (checks.some(check => check.state === 'warn')) return 'warn'
  return 'pass'
}
