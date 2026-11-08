import { io, type Socket } from 'socket.io-client'
import { getApiKey, getBaseUrlValue, request } from '../client'
import { socketEndpoint } from '@/utils/deployment-url'

export type AndroidDeviceKind = 'emulator' | 'usb' | 'network'

export interface AndroidDevice {
  serial: string
  state: string
  kind: AndroidDeviceKind
  model: string
  product: string
  avd?: string
  label?: string
  bluestacks?: boolean
}

export interface AndroidAvd {
  name: string
  running: boolean
  serial?: string
}

export interface AndroidSettings {
  adbPath: string
  sdkPath: string
  streamWidth: number
  autoConnect: string[]
  detectBlueStacks: boolean
  adbServer: string
}

export interface BlueStacksInstance {
  id: string
  name: string
  port: number | null
  adbEnabled: boolean
  running: boolean
}

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

export interface AndroidFrame {
  serial: string
  mime: string
  width: number
  height: number
  source: 'emulator' | 'screencap'
  data: ArrayBuffer
}

const base = '/api/studio/android'
const device = (serial: string) => `${base}/devices/${encodeURIComponent(serial)}`
const post = <T>(path: string, body: unknown = {}) => request<T>(path, { method: 'POST', body: JSON.stringify(body) })

export const fetchAndroidStatus = () => request<AndroidStatus>(base)
export const saveAndroidSettings = (settings: Partial<AndroidSettings>) =>
  request<{ settings: AndroidSettings }>(`${base}/settings`, { method: 'PUT', body: JSON.stringify(settings) })
export const connectAndroidDevice = (endpoint: string) => post<{ serial: string; message: string }>(`${base}/connect`, { endpoint })
export const pairAndroidDevice = (endpoint: string, code: string) => post<{ message: string }>(`${base}/pair`, { endpoint, code })
export const startAndroidAvd = (name: string) => post<{ started: true }>(`${base}/avds/${encodeURIComponent(name)}/start`)
export const disconnectAndroidDevice = (serial: string) => post<{ ok: true }>(`${device(serial)}/disconnect`)
export const stopAndroidEmulator = (serial: string) => post<{ ok: true }>(`${device(serial)}/stop`)
export const installAndroidApk = (serial: string, path: string) =>
  post<{ message: string; packageName: string | null }>(`${device(serial)}/install`, { path })
export const launchAndroidApp = (serial: string, packageName: string) => post<{ ok: true }>(`${device(serial)}/launch`, { packageName })

export function connectAndroidSocket(): Socket {
  const endpoint = socketEndpoint(getBaseUrlValue(), '/android')
  return io(endpoint.url, {
    forceNew: true,
    path: endpoint.path,
    auth: { token: getApiKey() },
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionDelay: 500,
    reconnectionDelayMax: 5000,
  })
}

/**
 * Set inside the Studio Own Android app (packages/android). The app asks the
 * person on the phone before every command; downloads of an .apk install it.
 */
export interface StudioOwnBridge {
  isTermuxInstalled(): boolean
  /** Runs `command` with Termux's bash; `background` runs it without opening Termux. */
  runInTermux(command: string, workdir: string, background: boolean): void
}

export function studioOwnBridge(): StudioOwnBridge | null {
  const bridge = (window as unknown as { StudioOwn?: StudioOwnBridge }).StudioOwn
  return bridge && typeof bridge.runInTermux === 'function' ? bridge : null
}
