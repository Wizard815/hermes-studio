import { readFileSync } from 'node:fs'
import { Socket } from 'node:net'
import { join } from 'node:path'

/** One BlueStacks instance as its own config describes it. */
export interface BlueStacksInstance {
  id: string
  name: string
  /** adb port on this machine, when BlueStacks has assigned one. */
  port: number | null
  /** BlueStacks' own "Android Debug Bridge" switch (Settings → Advanced). */
  adbEnabled: boolean
  /** Something is listening on the port right now. */
  running: boolean
}

/** Where BlueStacks 5 / BlueStacks Air keep `bluestacks.conf`. */
export function blueStacksConfigPaths(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string[] {
  if (platform === 'win32') {
    const root = env.ProgramData || env.PROGRAMDATA || 'C:\\ProgramData'
    return ['BlueStacks_nxt', 'BlueStacks_nxt_cn', 'BlueStacks_msi5', 'BlueStacks'].map(dir => join(root, dir, 'bluestacks.conf'))
  }
  if (platform === 'darwin') return ['/Users/Shared/Library/Application Support/BlueStacks/bluestacks.conf']
  return []
}

/**
 * Reads `bst.instance.<id>.status.adb_port="5555"`, `bst.instance.<id>.display_name`
 * and the global `bst.enable_adb_access` switch.
 */
export function parseBlueStacksConfig(text: string): Omit<BlueStacksInstance, 'running'>[] {
  const values = new Map<string, string>()
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([\w.-]+)\s*=\s*"?(.*?)"?\s*$/.exec(line)
    if (match) values.set(match[1], match[2])
  }
  const globalAdb = values.get('bst.enable_adb_access')
  const ids = new Set<string>()
  for (const key of values.keys()) {
    const id = /^bst\.instance\.([^.]+)\./.exec(key)?.[1]
    if (id) ids.add(id)
  }
  return [...ids].sort().map(id => {
    const port = Number(values.get(`bst.instance.${id}.status.adb_port`) ?? values.get(`bst.instance.${id}.adb_port`))
    const instanceAdb = values.get(`bst.instance.${id}.enable_adb_access`)
    return {
      id,
      name: values.get(`bst.instance.${id}.display_name`) || id,
      port: Number.isInteger(port) && port > 0 && port < 65536 ? port : null,
      adbEnabled: (instanceAdb ?? globalAdb) === '1',
    }
  })
}

/** True when something accepts a TCP connection on host:port within `timeoutMs`. */
export function tcpOpen(host: string, port: number, timeoutMs = 400): Promise<boolean> {
  return new Promise(resolve => {
    const socket = new Socket()
    const done = (open: boolean) => { socket.destroy(); resolve(open) }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
    socket.connect(port, host)
  })
}

/** BlueStacks instances on this machine, with whether each one is up. Empty where BlueStacks is not installed. */
export async function detectBlueStacks(paths = blueStacksConfigPaths(), probe = tcpOpen): Promise<BlueStacksInstance[]> {
  for (const path of paths) {
    let text: string
    try { text = readFileSync(path, 'utf8') } catch { continue }
    const instances = parseBlueStacksConfig(text)
    return Promise.all(instances.map(async instance => ({
      ...instance,
      running: instance.port != null && await probe('127.0.0.1', instance.port),
    })))
  }
  return []
}
