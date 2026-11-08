import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseEndpoint } from '../../packages/server/src/modules/studio/services/android/adb'
import { deviceKind, parseAvds, parseDevices, parseScreenSize } from '../../packages/server/src/modules/studio/services/android/devices'
import { discoverGrpc, GrpcMessageReader, imageBytes, varint } from '../../packages/server/src/modules/studio/services/android/emulator-grpc'
import { FrameHub, pngSize, type AndroidFrame } from '../../packages/server/src/modules/studio/services/android/frames'
import { gestureArgs, orientedSize, quoteInputText } from '../../packages/server/src/modules/studio/services/android/input'
import { AndroidDeviceManager, labelBlueStacks } from '../../packages/server/src/modules/studio/services/android/manager'
import { parseBlueStacksConfig, type BlueStacksInstance } from '../../packages/server/src/modules/studio/services/android/bluestacks'
import { createServer, type Server } from 'node:net'

/** A 1x1 PNG header with the given size; FrameHub and pngSize only read IHDR. */
function png(width: number, height: number, salt = 0): Buffer {
  const buf = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0)
  buf.writeUInt32BE(13, 8)
  buf.write('IHDR', 12, 'ascii')
  buf.writeUInt32BE(width, 16)
  buf.writeUInt32BE(height, 20)
  buf[32] = salt
  return buf
}

describe('adb output parsing', () => {
  it('lists emulators, USB phones, wireless phones and BlueStacks with their state', () => {
    const devices = parseDevices([
      '* daemon started successfully',
      'List of devices attached',
      'emulator-5554          device product:sdk_gphone64_x86_64 model:sdk_gphone64_x86_64 device:emu64xa transport_id:1',
      'R5CT1234ABC            unauthorized usb:1-1 transport_id:2',
      '127.0.0.1:5555         device product:OnePlus8 model:ONEPLUS_A5000 device:OnePlus8 transport_id:3',
      'adb-R5CT1234ABC-x1Y2._adb-tls-connect._tcp. device product:a52 model:SM_A525F transport_id:4',
      '0123456789ABCDEF       no permissions (missing udev rules? user is in the plugdev group); see [http://developer.android.com/tools/device.html] usb:1-2 transport_id:5',
      '',
    ].join('\n'))
    expect(devices.map(d => [d.serial, d.state, d.kind])).toEqual([
      ['emulator-5554', 'device', 'emulator'],
      ['R5CT1234ABC', 'unauthorized', 'usb'],
      ['127.0.0.1:5555', 'device', 'network'],
      ['adb-R5CT1234ABC-x1Y2._adb-tls-connect._tcp.', 'device', 'network'],
      ['0123456789ABCDEF', expect.stringMatching(/^no permissions/), 'usb'],
    ])
    expect(devices[2].model).toBe('ONEPLUS A5000')
  })

  it('reads AVD names past emulator log noise, and the screen size override first', () => {
    expect(parseAvds('INFO    | Storing crashdata in: /tmp\nPixel_8_API_35\nTablet_API_34\n')).toEqual(['Pixel_8_API_35', 'Tablet_API_34'])
    expect(parseScreenSize('Physical size: 1080x2400\nOverride size: 720x1600')).toEqual({ width: 720, height: 1600 })
    expect(parseScreenSize('Physical size: 1080x2400')).toEqual({ width: 1080, height: 2400 })
    expect(deviceKind('emulator-5556')).toBe('emulator')
  })

  it('accepts host:port endpoints and rejects anything that is not one', () => {
    expect(parseEndpoint('192.168.1.20', 5555)).toBe('192.168.1.20:5555')
    expect(parseEndpoint(' bluestacks.lan:5556 ')).toBe('bluestacks.lan:5556')
    expect(() => parseEndpoint('192.168.1.20')).toThrow()
    expect(() => parseEndpoint('host:5555; rm -rf /')).toThrow()
    expect(() => parseEndpoint('-h:5555')).toThrow()
  })
})

describe('gestures', () => {
  const portrait = { width: 1080, height: 2400 }

  it('maps fractions to pixels in the current rotation', () => {
    expect(gestureArgs({ type: 'tap', x: 0.5, y: 1 }, portrait)).toEqual(['input', 'tap', '540', '2399'])
    const landscape = orientedSize(portrait, { width: 540, height: 243 })
    expect(landscape).toEqual({ width: 2400, height: 1080 })
    expect(gestureArgs({ type: 'tap', x: 1, y: 0 }, landscape)).toEqual(['input', 'tap', '2399', '0'])
  })

  it('clamps swipes and long presses and rejects malformed ones', () => {
    expect(gestureArgs({ type: 'swipe', x1: 0.5, y1: 0.8, x2: 0.5, y2: -3, ms: 99999 }, portrait))
      .toEqual(['input', 'swipe', '540', '1919', '540', '0', '5000'])
    expect(gestureArgs({ type: 'longpress', x: 0, y: 0 }, portrait)).toEqual(['input', 'swipe', '0', '0', '0', '0', '600'])
    expect(gestureArgs({ type: 'tap', x: Number.NaN, y: 0 }, portrait)).toBeNull()
    expect(gestureArgs({ type: 'key', key: 'nope' as any }, portrait)).toBeNull()
    expect(gestureArgs({ type: 'key', key: 'back' }, portrait)).toEqual(['input', 'keyevent', '4'])
  })

  it('quotes typed text so the device shell cannot run it', () => {
    expect(quoteInputText(`it's 100% $(reboot)`)).toBe(`'it'\\''s%s100\\%%s$(reboot)'`)
    expect(gestureArgs({ type: 'text', text: '' }, portrait)).toBeNull()
  })
})

describe('emulator gRPC stream', () => {
  let dir = ''
  afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }) })

  it('finds the gRPC port and token for a console port', async () => {
    dir = await mkdtemp(join(tmpdir(), 'avd-running-'))
    await writeFile(join(dir, 'pid_100.ini'), 'port.serial=5556\ngrpc.port=8556\ngrpc.token=abc\n')
    await writeFile(join(dir, 'pid_200.ini'), 'port.serial=5554\ngrpc.port=8554\n')
    expect(discoverGrpc('5554', [join(dir, 'missing'), dir])).toEqual({ port: 8554, token: '' })
    expect(discoverGrpc('5556', [dir])).toEqual({ port: 8556, token: 'abc' })
    expect(discoverGrpc('5558', [dir])).toBeNull()
  })

  it('extracts image bytes from length-prefixed messages split across chunks', () => {
    const image = Buffer.from('PNGDATA')
    // Image { format(1): {..}, width(2)=3, image(4)=bytes }
    const message = Buffer.from([0x0a, 0x02, 0x08, 0x00, 0x10, 0x03, 0x22, image.length, ...image])
    const framed = Buffer.concat([Buffer.from([0, 0, 0, 0, message.length]), message])
    const reader = new GrpcMessageReader()
    expect(reader.push(framed.subarray(0, 4))).toEqual([])
    const [decoded] = reader.push(framed.subarray(4))
    expect(imageBytes(decoded)?.toString()).toBe('PNGDATA')
    expect(imageBytes(Buffer.from([0x22, 0x7f]))).toEqual(Buffer.alloc(0))
    expect(imageBytes(Buffer.from([0xff]))).toBeNull()
    expect(varint(300)).toEqual([0xac, 0x02])
  })
})

describe('FrameHub screencap feed', () => {
  const compress = async (data: Buffer) => ({ data, mime: 'image/png' as const, ...(pngSize(data) ?? { width: 0, height: 0 }) })

  it('shares one feed between viewers, skips unchanged frames and stops with the last viewer', async () => {
    let calls = 0
    const hub = new FrameHub({
      screencap: async () => { calls += 1; return png(1080, 2400, calls < 3 ? 0 : 1) },
      compress, streamWidth: () => 540, log: () => {},
    })
    const a: AndroidFrame[] = []
    const b: AndroidFrame[] = []
    const stopA = hub.watch('R5CT1234ABC', f => a.push(f), () => {})
    const stopB = hub.watch('R5CT1234ABC', f => b.push(f), () => {})
    await new Promise(r => setTimeout(r, 450))
    stopA(); stopB()
    const callsAtStop = calls
    await new Promise(r => setTimeout(r, 300))
    expect(calls).toBe(callsAtStop)
    expect(a.length).toBe(2) // salt 0 once, then salt 1 once
    expect(b.length).toBe(2)
    expect(a[0]).toMatchObject({ width: 1080, height: 2400, source: 'screencap' })
  })

  it('ends the feed and tells viewers when the device keeps failing', async () => {
    const hub = new FrameHub({
      screencap: async () => { throw new Error('device offline') },
      compress, streamWidth: () => 540, log: () => {},
    })
    // Five failures with a 1.5 s backoff between them.
    const ended = await new Promise<string>(resolve => hub.watch('emulator-9999', () => {}, resolve))
    expect(ended).toBe('device offline')
  }, 15_000)
})

describe('AndroidDeviceManager with a fake adb', () => {
  let dir = ''
  let log = ''
  let manager: AndroidDeviceManager

  let blueStacks: BlueStacksInstance[] = []

  beforeEach(async () => {
    blueStacks = []
    dir = await mkdtemp(join(tmpdir(), 'android-manager-'))
    log = join(dir, 'adb.log')
    const adb = join(dir, 'adb')
    await writeFile(adb, `#!/bin/sh
printf '%s\\n' "$*" >> "${log}"
case "$*" in
  version) echo "Android Debug Bridge version 1.0.41"; echo "Version 35.0.2" ;;
  "devices -l") printf 'List of devices attached\\n192.168.1.20:5555 device product:x model:Pixel_7 transport_id:1\\n' ;;
  "connect 192.168.1.20:5555") echo "connected to 192.168.1.20:5555" ;;
  "connect 10.0.0.9:5555") echo "failed to connect to '10.0.0.9:5555': Connection refused" ;;
  *"wm size") echo "Physical size: 1080x2400" ;;
  *" install "*) echo "Performing Streamed Install"; echo "Success" ;;
  "connect 127.0.0.1:"*) echo "connected to $2" ;;
  "pair 10.0.0.9:37000 123456") echo "error: protocol fault (couldn't read status message): Success" ;;
  "pair 192.168.1.20:37000 123456") echo "Successfully paired to 192.168.1.20:37000 [guid=adb-X]" ;;
esac
`)
    await chmod(adb, 0o755)
    manager = new AndroidDeviceManager(async data => ({ data, mime: 'image/png', width: 1, height: 1 }), async () => blueStacks)
    await manager.configure(join(dir, 'state', 'settings.json'), () => {})
    await manager.updateSettings({ adbPath: adb })
  })

  afterEach(async () => {
    manager.shutdown()
    await rm(dir, { recursive: true, force: true })
  })

  it.runIf(process.platform !== 'win32')('reports adb, devices and saved settings', async () => {
    const status = await manager.status()
    expect(status.adbVersion).toBe('1.0.41')
    expect(status.devices).toEqual([expect.objectContaining({ serial: '192.168.1.20:5555', kind: 'network', model: 'Pixel 7' })])
    const saved = JSON.parse(await readFile(join(dir, 'state', 'settings.json'), 'utf8'))
    expect(saved).toMatchObject({ adbPath: join(dir, 'adb'), streamWidth: 540 })
  })

  it.runIf(process.platform !== 'win32')('connects, reports a refused connection, installs and taps', async () => {
    await expect(manager.connect('192.168.1.20')).resolves.toMatchObject({ serial: '192.168.1.20:5555' })
    await expect(manager.connect('10.0.0.9')).rejects.toThrow(/refused/)
    await expect(manager.pair('192.168.1.20:37000', '123456')).resolves.toMatchObject({ message: expect.stringContaining('Successfully paired') })
    await expect(manager.pair('10.0.0.9:37000', '123456')).rejects.toThrow(/protocol fault/)
    await expect(manager.pair('10.0.0.9:37000', '12345')).rejects.toThrow(/6 digits/)
    const apk = join(dir, 'app-debug.apk')
    await writeFile(apk, 'apk')
    await expect(manager.installApk('192.168.1.20:5555', apk)).resolves.toMatchObject({ message: expect.stringContaining('Success') })
    await expect(manager.installApk('192.168.1.20:5555', join(dir, 'notes.txt'))).rejects.toThrow(/\.apk/)
    await manager.gesture('192.168.1.20:5555', { type: 'tap', x: 0.5, y: 0.5 })
    const calls = (await readFile(log, 'utf8')).trim().split('\n')
    expect(calls).toContain(`-s 192.168.1.20:5555 install -r -t ${apk}`)
    expect(calls).toContain('-s 192.168.1.20:5555 shell input tap 540 1200')
  })

  it('refuses a missing adb path and an invalid serial', async () => {
    await expect(manager.updateSettings({ adbPath: join(dir, 'nope') })).rejects.toThrow(/not found/)
    await expect(manager.gesture('bad serial;', { type: 'key', key: 'home' })).rejects.toThrow(/serial/)
    await expect(manager.disconnect('-a')).rejects.toThrow(/serial/)
  })
})

describe('BlueStacks', () => {
  it('reads instances, ports and the ADB switch from bluestacks.conf', () => {
    const conf = [
      'bst.enable_adb_access="1"',
      'bst.instance.Pie64.display_name="BlueStacks App Player"',
      'bst.instance.Pie64.status.adb_port="5555"',
      'bst.instance.Pie64_1.display_name="Testing"',
      'bst.instance.Pie64_1.status.adb_port="5565"',
      'bst.instance.Pie64_1.enable_adb_access="0"',
    ].join('\r\n')
    expect(parseBlueStacksConfig(conf)).toEqual([
      { id: 'Pie64', name: 'BlueStacks App Player', port: 5555, adbEnabled: true },
      { id: 'Pie64_1', name: 'Testing', port: 5565, adbEnabled: false },
    ])
  })

  it('names the device adb found for an instance, whichever way adb lists it', () => {
    const instances = [{ id: 'Pie64', name: 'BlueStacks App Player', port: 5555, adbEnabled: true, running: true }]
    const devices = parseDevices('emulator-5554 device model:SM_S908E\n127.0.0.1:5565 device\nemulator-5556 device\n')
    devices[2].avd = 'Pixel_8'
    const labelled = labelBlueStacks(devices, [...instances, { id: 'b', name: 'Second', port: 5565, adbEnabled: true, running: true }])
    expect(labelled.map(d => d.label ?? null)).toEqual(['BlueStacks App Player', 'Second', null])
  })
})

describe.runIf(process.platform !== 'win32')('remembered devices and BlueStacks reconnect', () => {
  let dir = ''
  let server: Server
  let port = 0

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'android-reconnect-'))
    server = createServer(socket => socket.destroy())
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    port = (server.address() as { port: number }).port
  })

  afterEach(async () => {
    await new Promise(resolve => server.close(resolve))
    await rm(dir, { recursive: true, force: true })
  })

  async function managerWith(instances: BlueStacksInstance[]) {
    const log = join(dir, 'adb.log')
    const adb = join(dir, 'adb')
    await writeFile(adb, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\ncase "$1" in connect) echo "connected to $2" ;; esac\n`)
    await chmod(adb, 0o755)
    const manager = new AndroidDeviceManager(async data => ({ data, mime: 'image/png', width: 1, height: 1 }), async () => instances)
    await manager.configure(join(dir, 'settings.json'), () => {})
    await manager.updateSettings({ adbPath: adb })
    return { manager, calls: async () => (await readFile(log, 'utf8')).trim().split('\n') }
  }

  it('connects to a running BlueStacks instance without being asked', async () => {
    const { manager, calls } = await managerWith([{ id: 'Pie64', name: 'BlueStacks', port, adbEnabled: true, running: true }])
    const status = await manager.status()
    expect(status.bluestacks).toHaveLength(1)
    expect(await calls()).toContain(`connect 127.0.0.1:${port}`)
    manager.shutdown()
  })

  it('remembers a connected device, reconnects it when reachable and forgets it on disconnect', async () => {
    const { manager, calls } = await managerWith([])
    await manager.connect(`127.0.0.1:${port}`)
    expect(manager.getSettings().autoConnect).toEqual([`127.0.0.1:${port}`])
    await manager.status()
    expect((await calls()).filter(c => c === `connect 127.0.0.1:${port}`)).toHaveLength(2)
    await manager.disconnect(`127.0.0.1:${port}`)
    expect(manager.getSettings().autoConnect).toEqual([])
    manager.shutdown()
  })

  it('skips an unreachable remembered device instead of waiting on adb', async () => {
    const { manager, calls } = await managerWith([])
    await manager.updateSettings({ autoConnect: ['127.0.0.1:1'] })
    await manager.status()
    expect(await calls()).not.toContain('connect 127.0.0.1:1')
    manager.shutdown()
  })
})
