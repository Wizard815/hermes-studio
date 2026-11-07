// The Android emulator's own screen stream over its gRPC control API.
// It pushes a frame whenever the screen changes (~36 fps at 540 px wide,
// against a few fps for `adb screencap`).
// Adapted from herdr-sim's android-stream.mjs (MIT, Copyright (c) 2026 Robert Soriano),
// with discovery extended from macOS to Linux and Windows.
import http2 from 'node:http2'
import { readdirSync, readFileSync } from 'node:fs'
import { homedir, tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'

export interface GrpcEndpoint { port: number; token: string }

/** Folders where a running emulator writes `pid_<n>.ini` with its gRPC port and token. */
export function discoveryDirs(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string[] {
  const home = homedir()
  const dirs: string[] = []
  if (platform === 'darwin') dirs.push(join(home, 'Library', 'Caches', 'TemporaryItems', 'avd', 'running'))
  if (platform === 'win32') dirs.push(join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'Temp', 'avd', 'running'))
  if (env.XDG_RUNTIME_DIR) dirs.push(join(env.XDG_RUNTIME_DIR, 'avd', 'running'))
  if (platform === 'linux' && typeof process.getuid === 'function') dirs.push(join('/run/user', String(process.getuid()), 'avd', 'running'))
  let user = env.USER || ''
  try { user ||= userInfo().username } catch { /* containers without a passwd entry */ }
  dirs.push(join(tmpdir(), `android-${user}`, 'avd', 'running'), join(home, '.android', 'avd', 'running'))
  return [...new Set(dirs)]
}

/** Reads `key=value` lines of a discovery file. */
export function parseDiscovery(ini: string): Record<string, string> {
  const values: Record<string, string> = {}
  for (const line of ini.split(/\r?\n/)) {
    const at = line.indexOf('=')
    if (at > 0) values[line.slice(0, at).trim()] = line.slice(at + 1).trim()
  }
  return values
}

/** The gRPC endpoint of the emulator on a console port (emulator-5554 -> 5554), if it advertises one. */
export function discoverGrpc(consolePort: string, dirs = discoveryDirs()): GrpcEndpoint | null {
  for (const dir of dirs) {
    let names: string[]
    try { names = readdirSync(dir).filter(name => name.endsWith('.ini')) } catch { continue }
    for (const name of names) {
      let values: Record<string, string>
      try { values = parseDiscovery(readFileSync(join(dir, name), 'utf8')) } catch { continue }
      if (values['port.serial'] !== consolePort) continue
      const port = Number(values['grpc.port'])
      if (Number.isInteger(port) && port > 0) return { port, token: values['grpc.token'] || '' }
    }
  }
  return null
}

export function varint(n: number): number[] {
  const out: number[] = []
  for (; n > 127; n >>>= 7) out.push((n & 127) | 128)
  out.push(n)
  return out
}

/** The `image` bytes (field 4) of an emulator `Image` protobuf message. */
export function imageBytes(msg: Buffer): Buffer | null {
  let i = 0
  const read = () => {
    let v = 0
    for (let shift = 0; ; shift += 7) {
      if (i >= msg.length) throw new RangeError('truncated varint')
      const b = msg[i++]
      v += (b & 127) * 2 ** shift
      if (!(b & 128)) return v
    }
  }
  try {
    while (i < msg.length) {
      const key = read()
      const type = key & 7
      if (type === 2) {
        const len = read()
        if (key >> 3 === 4) return msg.subarray(i, i + len)
        i += len
      } else if (type === 0) read()
      else if (type === 1) i += 8
      else if (type === 5) i += 4
      else return null
    }
  } catch { return null }
  return null
}

/** Splits gRPC length-prefixed messages ([flag][u32 length][bytes]) out of a byte stream. */
export class GrpcMessageReader {
  private pending: Buffer = Buffer.alloc(0)

  push(chunk: Buffer): Buffer[] {
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk
    const messages: Buffer[] = []
    while (this.pending.length >= 5) {
      const len = this.pending.readUInt32BE(1)
      if (this.pending.length < 5 + len) break
      messages.push(this.pending.subarray(5, 5 + len))
      this.pending = this.pending.subarray(5 + len)
    }
    return messages
  }
}

/**
 * Opens `streamScreenshot` and calls `onFrame` with each PNG. Resolves the
 * returned `stop` immediately; `onEnd` fires once when the stream ends for any reason.
 */
export function streamEmulatorScreen(endpoint: GrpcEndpoint, width: number,
  onFrame: (png: Buffer) => void, onEnd: (reason: string) => void): { stop: () => void } {
  let ended = false
  const end = (reason: string) => {
    if (ended) return
    ended = true
    try { session.close() } catch { /* already closed */ }
    onEnd(reason)
  }
  const session = http2.connect(`http://127.0.0.1:${endpoint.port}`)
  session.on('error', error => end(error.message))
  // ImageFormat { format: PNG, width, height }: the frame fits inside width x (4 * width).
  const format = Buffer.from([8, 0, 24, ...varint(width), 32, ...varint(width * 4)])
  const call = session.request({
    ':method': 'POST',
    ':path': '/android.emulation.control.EmulatorController/streamScreenshot',
    'content-type': 'application/grpc',
    te: 'trailers',
    ...(endpoint.token ? { authorization: `Bearer ${endpoint.token}` } : {}),
  })
  const prefix = Buffer.alloc(5)
  prefix.writeUInt32BE(format.length, 1)
  call.end(Buffer.concat([prefix, format]))
  const reader = new GrpcMessageReader()
  call.on('data', (chunk: Buffer) => {
    for (const message of reader.push(chunk)) {
      const png = imageBytes(message)
      // An inactive display sends empty images.
      if (png?.length) onFrame(Buffer.from(png))
    }
  })
  call.on('error', error => end(error.message))
  call.on('close', () => end('closed'))
  return { stop: () => end('stopped') }
}
