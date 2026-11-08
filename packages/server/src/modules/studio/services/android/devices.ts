/** How Studio reaches a device. BlueStacks and phones on wireless debugging are both `network`. */
export type AndroidDeviceKind = 'emulator' | 'usb' | 'network'

/** adb's own words: device, unauthorized, offline, "no permissions", ... */
export type AndroidDeviceState = string

export interface AndroidDevice {
  serial: string
  state: AndroidDeviceState
  kind: AndroidDeviceKind
  model: string
  product: string
  /** The AVD name for a running emulator, when known. */
  avd?: string
  /** A friendlier name, e.g. the BlueStacks instance name. */
  label?: string
  bluestacks?: boolean
}

export interface AndroidAvd {
  name: string
  running: boolean
  serial?: string
}

export function deviceKind(serial: string): AndroidDeviceKind {
  if (/^emulator-\d+$/.test(serial)) return 'emulator'
  // host:port (adb connect, BlueStacks) or an mDNS wireless-debugging service name.
  if (serial.includes(':') || serial.includes('._adb-tls-connect.')) return 'network'
  return 'usb'
}

/** Parses `adb devices -l`. Unknown lines (daemon notices, headers) are skipped. */
export function parseDevices(output: string): AndroidDevice[] {
  const devices: AndroidDevice[] = []
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('*') || line.startsWith('List of devices')) continue
    const match = /^(\S+)\s+(no permissions.*?(?=\s+\w+:|$)|\S+)(.*)$/.exec(line)
    if (!match) continue
    const [, serial, state, rest] = match
    const field = (key: string) => new RegExp(`(?:^|\\s)${key}:(\\S+)`).exec(rest)?.[1] ?? ''
    devices.push({
      serial,
      state: state.trim(),
      kind: deviceKind(serial),
      model: field('model').replace(/_/g, ' '),
      product: field('product'),
    })
  }
  return devices
}

/** Parses `emulator -list-avds`; the emulator also prints INFO/WARNING lines there. */
export function parseAvds(output: string): string[] {
  return output.split(/\r?\n/).map(line => line.trim()).filter(line => /^[A-Za-z0-9._-]+$/.test(line))
}

/** Physical size from `wm size`; an override size wins because that is what the screen shows. */
export function parseScreenSize(output: string): { width: number; height: number } | null {
  const override = /Override size:\s*(\d+)x(\d+)/.exec(output)
  const physical = /Physical size:\s*(\d+)x(\d+)/.exec(output)
  const match = override ?? physical ?? /(\d+)x(\d+)/.exec(output)
  return match ? { width: Number(match[1]), height: Number(match[2]) } : null
}
