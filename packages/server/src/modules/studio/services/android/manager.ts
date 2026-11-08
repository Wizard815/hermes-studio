import { spawn } from 'node:child_process'
import { closeSync, existsSync, openSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import {
  assertSerial, parseEndpoint, resolveAdb, resolveEmulator, run,
  type AndroidToolPaths,
} from './adb'
import { parseAvds, parseDevices, parseScreenSize, type AndroidAvd, type AndroidDevice } from './devices'
import { detectBlueStacks, tcpOpen, type BlueStacksInstance } from './bluestacks'
import { FrameHub } from './frames'
import { gestureArgs, orientedSize, type AndroidGesture, type ScreenSize } from './input'

export interface AndroidSettings extends AndroidToolPaths {
  /** Width the live screen is sent at; the panel scales it to fit. */
  streamWidth: number
  /** Network devices (phones, BlueStacks on another PC, emulator containers) reconnected whenever they are reachable. */
  autoConnect: string[]
  /** Find BlueStacks on this machine from its own config and connect to running instances. */
  detectBlueStacks: boolean
}

export const DEFAULT_ANDROID_SETTINGS: AndroidSettings = { adbPath: '', sdkPath: '', streamWidth: 540, autoConnect: [], detectBlueStacks: true }

export interface AndroidStatus {
  adb: string | null
  adbVersion: string | null
  emulator: string | null
  settings: AndroidSettings
  devices: AndroidDevice[]
  avds: AndroidAvd[]
  bluestacks: BlueStacksInstance[]
  error?: string
}

const AVD_NAME = /^[A-Za-z0-9._-]{1,100}$/
const PACKAGE_NAME = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/
const SIZE_TTL_MS = 30_000
const EMULATOR_BOOT_CHECK_MS = 6_000
const RECONNECT_INTERVAL_MS = 10_000
const MAX_AUTO_CONNECT = 20

const httpError = (status: number, message: string) => Object.assign(new Error(message), { status })

export function normalizeSettings(input: Partial<AndroidSettings> | null | undefined): AndroidSettings {
  const width = Math.round(Number(input?.streamWidth))
  return {
    adbPath: typeof input?.adbPath === 'string' ? input.adbPath.trim() : '',
    sdkPath: typeof input?.sdkPath === 'string' ? input.sdkPath.trim() : '',
    streamWidth: Number.isFinite(width) ? Math.min(1440, Math.max(240, width)) : DEFAULT_ANDROID_SETTINGS.streamWidth,
    autoConnect: [...new Set((Array.isArray(input?.autoConnect) ? input.autoConnect : []).flatMap(value => {
      try { return [parseEndpoint(String(value))] } catch { return [] }
    }))].slice(0, MAX_AUTO_CONNECT),
    detectBlueStacks: input?.detectBlueStacks !== false,
  }
}

/** host and port of a `host:port` endpoint (IPv6 in brackets). */
function splitEndpoint(endpoint: string): { host: string; port: number } {
  const at = endpoint.lastIndexOf(':')
  return { host: endpoint.slice(0, at).replace(/^\[|\]$/g, ''), port: Number(endpoint.slice(at + 1)) }
}

/** adb's own local-emulator scan lists a BlueStacks on port N as emulator-(N-1). */
export function labelBlueStacks(devices: AndroidDevice[], instances: BlueStacksInstance[]): AndroidDevice[] {
  return devices.map(device => {
    const instance = instances.find(i => i.port != null && (
      device.serial === `127.0.0.1:${i.port}` || device.serial === `localhost:${i.port}`
      || (device.serial === `emulator-${i.port - 1}` && !device.avd)))
    return instance ? { ...device, label: instance.name, bluestacks: true } : device
  })
}

type Compressor = (png: Buffer, width: number) => Promise<{ data: Buffer; mime: 'image/png' | 'image/jpeg'; width: number; height: number }>

/** Screencaps are full-resolution PNGs; send a smaller JPEG when sharp is available. */
const compressWithSharp: Compressor = async (png, width) => {
  try {
    const { default: sharp } = await import('sharp')
    const { data, info } = await sharp(png).resize({ width, withoutEnlargement: true }).jpeg({ quality: 72 }).toBuffer({ resolveWithObject: true })
    return { data, mime: 'image/jpeg', width: info.width, height: info.height }
  } catch {
    const size = png.length >= 24 ? { width: png.readUInt32BE(16), height: png.readUInt32BE(20) } : { width: 0, height: 0 }
    return { data: png, mime: 'image/png', ...size }
  }
}

export class AndroidDeviceManager {
  private settings: AndroidSettings = { ...DEFAULT_ANDROID_SETTINGS }
  private settingsFile = ''
  private sizes = new Map<string, { size: ScreenSize; at: number }>()
  private queues = new Map<string, Promise<unknown>>()
  private logger: (message: string) => void = () => {}
  private lastReconnect = 0
  private detect: () => Promise<BlueStacksInstance[]> = () => detectBlueStacks()
  readonly frames: FrameHub

  constructor(compress: Compressor = compressWithSharp, detect?: () => Promise<BlueStacksInstance[]>) {
    if (detect) this.detect = detect
    this.frames = new FrameHub({
      screencap: serial => this.adb(['-s', serial, 'exec-out', 'screencap', '-p'], 10_000).then(result => result.stdout),
      compress,
      streamWidth: () => this.settings.streamWidth,
      log: message => this.logger(message),
    })
  }

  async configure(settingsFile: string, log: (message: string) => void): Promise<void> {
    this.settingsFile = settingsFile
    this.logger = log
    try {
      this.settings = normalizeSettings(JSON.parse(await readFile(settingsFile, 'utf8')))
    } catch {
      this.settings = { ...DEFAULT_ANDROID_SETTINGS }
    }
  }

  getSettings(): AndroidSettings { return { ...this.settings } }

  async updateSettings(input: Partial<AndroidSettings>): Promise<AndroidSettings> {
    const next = normalizeSettings({ ...this.settings, ...input })
    if (next.adbPath && !existsSync(next.adbPath)) throw httpError(400, `adb was not found at ${next.adbPath}`)
    if (next.sdkPath && !existsSync(next.sdkPath)) throw httpError(400, `No Android SDK at ${next.sdkPath}`)
    this.settings = next
    if (this.settingsFile) {
      await mkdir(dirname(this.settingsFile), { recursive: true })
      await writeFile(this.settingsFile, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    }
    return this.getSettings()
  }

  adbBinary(): string {
    const adb = resolveAdb(this.settings)
    if (!adb) throw httpError(503, 'adb was not found. Install the Android platform-tools (Debian/Ubuntu: apt install adb) or set its path in Android settings.')
    return adb
  }

  adb(args: string[], timeoutMs = 15_000) {
    return run(this.adbBinary(), args, { timeoutMs })
  }

  async status(): Promise<AndroidStatus> {
    const adb = resolveAdb(this.settings)
    const emulator = resolveEmulator(this.settings)
    const bluestacks = this.settings.detectBlueStacks ? await this.detect().catch(() => []) : []
    const base = { adb, emulator, settings: this.getSettings(), adbVersion: null, devices: [], avds: [], bluestacks }
    if (!adb) return { ...base, avds: await this.listAvds(emulator, []) }
    try {
      const version = (await run(adb, ['version'], { timeoutMs: 10_000 })).stdout.toString('utf8')
      await this.reconnect(bluestacks)
      const devices = labelBlueStacks(await this.listDevices(), bluestacks)
      return {
        ...base,
        adbVersion: /version\s+([\d.]+)/i.exec(version)?.[1] ?? null,
        devices,
        avds: await this.listAvds(emulator, devices),
      }
    } catch (error) {
      return { ...base, error: (error as Error).message }
    }
  }

  /**
   * Brings back remembered network devices and running BlueStacks instances.
   * Only endpoints that accept a TCP connection get an `adb connect`, so an
   * offline phone costs a short probe, not adb's long connect timeout.
   */
  private async reconnect(bluestacks: BlueStacksInstance[]): Promise<void> {
    if (Date.now() - this.lastReconnect < RECONNECT_INTERVAL_MS) return
    this.lastReconnect = Date.now()
    const present = new Set(parseDevices((await this.adb(['devices'], 10_000)).stdout.toString('utf8'))
      .filter(device => device.state === 'device').map(device => device.serial))
    const targets = new Set(this.settings.autoConnect)
    for (const instance of bluestacks) {
      // adb already lists a local BlueStacks as emulator-(port-1); a second connection would duplicate it.
      if (instance.running && instance.port && !present.has(`emulator-${instance.port - 1}`)) targets.add(`127.0.0.1:${instance.port}`)
    }
    await Promise.all([...targets].filter(target => !present.has(target)).map(async target => {
      const { host, port } = splitEndpoint(target)
      if (!await tcpOpen(host, port)) return
      try { await this.adb(['connect', target], 10_000) } catch (error) { this.logger(`[android] reconnect ${target}: ${(error as Error).message}`) }
    }))
  }

  async listDevices(): Promise<AndroidDevice[]> {
    const devices = parseDevices((await this.adb(['devices', '-l'], 20_000)).stdout.toString('utf8'))
    await Promise.all(devices.filter(device => device.kind === 'emulator' && device.state === 'device').map(async device => {
      try {
        const out = (await this.adb(['-s', device.serial, 'emu', 'avd', 'name'], 5_000)).stdout.toString('utf8')
        device.avd = out.split(/\r?\n/)[0]?.trim() || undefined
      } catch { /* an emulator in another container has no console here */ }
    }))
    return devices
  }

  private async listAvds(emulator: string | null, devices: AndroidDevice[]): Promise<AndroidAvd[]> {
    if (!emulator) return []
    try {
      const names = parseAvds((await run(emulator, ['-list-avds'], { timeoutMs: 15_000 })).stdout.toString('utf8'))
      return names.map(name => {
        const device = devices.find(d => d.avd === name)
        return { name, running: Boolean(device), ...(device ? { serial: device.serial } : {}) }
      })
    } catch {
      return []
    }
  }

  /** Boots an AVD with no window of its own; its screen shows in Studio. */
  async startAvd(name: string, logDir: string): Promise<{ started: true }> {
    if (!AVD_NAME.test(name)) throw httpError(400, 'Invalid emulator name')
    const emulator = resolveEmulator(this.settings)
    if (!emulator) throw httpError(503, 'The Android emulator is not installed on this machine. Install it with the SDK, or connect an emulator running elsewhere with adb connect.')
    await mkdir(logDir, { recursive: true })
    const logFile = join(logDir, `emulator-${name}.log`)
    const fd = openSync(logFile, 'w')
    const headless = process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY
    const args = ['-avd', name, '-no-window', '-no-audio', '-no-boot-anim', ...(headless ? ['-gpu', 'swiftshader_indirect'] : [])]
    const child = spawn(emulator, args, { detached: true, stdio: ['ignore', fd, fd], windowsHide: true })
    closeSync(fd)
    const exited = await new Promise<number | null>(done => {
      const timer = setTimeout(() => done(null), EMULATOR_BOOT_CHECK_MS)
      child.once('exit', code => { clearTimeout(timer); done(code ?? -1) })
      child.once('error', () => { clearTimeout(timer); done(-1) })
    })
    if (exited !== null) {
      let tail = ''
      try { tail = readFileSync(logFile, 'utf8').trim().split('\n').slice(-4).join(' ') } catch { /* no log */ }
      throw httpError(502, tail || `The emulator exited (${exited}).`)
    }
    child.unref()
    return { started: true }
  }

  async stopEmulator(serial: string) {
    if (!/^emulator-\d+$/.test(assertSerial(serial))) throw httpError(400, 'Only emulators can be shut down from Studio')
    await this.adb(['-s', serial, 'emu', 'kill'])
  }

  /** `adb connect` for wireless debugging, BlueStacks, or an emulator container. */
  async connect(endpoint: string, remember = true) {
    const target = parseEndpoint(endpoint, 5555)
    const out = (await this.adb(['connect', target], 20_000)).stdout.toString('utf8').trim()
    if (/cannot|failed|unable|refused/i.test(out)) throw httpError(502, out)
    if (remember && !this.settings.autoConnect.includes(target)) {
      await this.updateSettings({ autoConnect: [...this.settings.autoConnect, target] })
    }
    return { serial: target, message: out }
  }

  /** Disconnects and forgets a network device, so it is not reconnected automatically. */
  async disconnect(serial: string) {
    await this.adb(['disconnect', assertSerial(serial)])
    if (this.settings.autoConnect.includes(serial)) {
      await this.updateSettings({ autoConnect: this.settings.autoConnect.filter(endpoint => endpoint !== serial) })
    }
  }

  /** Android 11+ wireless debugging: the pairing address and 6-digit code from the phone. */
  async pair(endpoint: string, code: string) {
    const target = parseEndpoint(endpoint)
    if (!/^\d{6}$/.test(code.trim())) throw httpError(400, 'The pairing code is 6 digits')
    const out = (await this.adb(['pair', target, code.trim()], 30_000)).stdout.toString('utf8').trim()
    // adb's failure text can contain "Success" ("protocol fault ...: Success"); match the real outcome.
    if (!/Successfully paired/i.test(out)) throw httpError(502, out || 'Pairing failed')
    return { message: out }
  }

  /** Installs an APK that is on this machine (built here, or uploaded through Studio). */
  async installApk(serial: string, apkPath: string) {
    assertSerial(serial)
    const file = resolve(apkPath)
    if (!file.toLowerCase().endsWith('.apk')) throw httpError(400, 'Choose an .apk file')
    let isFile = false
    try { isFile = statSync(file).isFile() } catch { /* missing */ }
    if (!isFile) throw httpError(404, `No APK at ${file}`)
    const out = (await this.adb(['-s', serial, 'install', '-r', '-t', file], 5 * 60_000)).stdout.toString('utf8').trim()
    if (!/^Success\s*$/m.test(out)) throw httpError(502, out || 'Install failed')
    const packageName = await this.packageOf(file)
    return { message: out, packageName }
  }

  /** The package an APK declares, read with aapt from the SDK when it is there. */
  private async packageOf(apk: string): Promise<string | null> {
    for (const root of [this.settings.sdkPath, process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT].filter(Boolean) as string[]) {
      const buildTools = join(root, 'build-tools')
      try {
        const versions = readdirSync(buildTools).sort().reverse()
        for (const version of versions) {
          const aapt = join(buildTools, version, process.platform === 'win32' ? 'aapt.exe' : 'aapt')
          if (!existsSync(aapt)) continue
          const out = (await run(aapt, ['dump', 'badging', apk], { timeoutMs: 20_000 })).stdout.toString('utf8')
          return /package: name='([^']+)'/.exec(out)?.[1] ?? null
        }
      } catch { /* no build-tools */ }
    }
    return null
  }

  async launch(serial: string, packageName: string) {
    assertSerial(serial)
    if (!PACKAGE_NAME.test(packageName)) throw httpError(400, 'Invalid package name')
    const out = (await this.adb(['-s', serial, 'shell', 'monkey', '-p', packageName, '-c', 'android.intent.category.LAUNCHER', '1'])).stdout.toString('utf8')
    if (/No activities found|monkey aborted/i.test(out)) throw httpError(404, `${packageName} has no launcher activity on this device`)
  }

  async screenshot(serial: string): Promise<Buffer> {
    return (await this.adb(['-s', assertSerial(serial), 'exec-out', 'screencap', '-p'], 15_000)).stdout
  }

  private async naturalSize(serial: string): Promise<ScreenSize> {
    const cached = this.sizes.get(serial)
    if (cached && Date.now() - cached.at < SIZE_TTL_MS) return cached.size
    const out = (await this.adb(['-s', serial, 'shell', 'wm', 'size'], 5_000)).stdout.toString('utf8')
    const size = parseScreenSize(out) ?? { width: 1080, height: 1920 }
    this.sizes.set(serial, { size, at: Date.now() })
    return size
  }

  /** Runs one gesture. Gestures for a device run in order, one at a time. */
  gesture(serial: string, gesture: AndroidGesture): Promise<void> {
    try { assertSerial(serial) } catch (error) { return Promise.reject(error) }
    const previous = this.queues.get(serial) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(async () => {
      const frame = this.frames.lastFrame(serial)
      const size = orientedSize(await this.naturalSize(serial), frame)
      const args = gestureArgs(gesture, size)
      if (!args) throw httpError(400, 'Invalid gesture')
      await this.adb(['-s', serial, 'shell', ...args], 10_000)
    })
    this.queues.set(serial, next)
    void next.finally(() => { if (this.queues.get(serial) === next) this.queues.delete(serial) }).catch(() => undefined)
    return next
  }

  shutdown() {
    this.frames.close()
  }
}

export const androidDeviceManager = new AndroidDeviceManager()
