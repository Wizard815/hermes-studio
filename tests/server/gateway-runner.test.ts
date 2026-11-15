import { EventEmitter } from 'events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const spawned = vi.hoisted(() => [] as Array<{ bin: string; args: string[]; env: NodeJS.ProcessEnv; child: any }>)
let nextPid = 1000

vi.mock('../../packages/server/src/modules/hermes/services/runtime/process', () => ({
  spawnHermesWithBin: vi.fn((bin: string, args: string[], options: any) => {
    const child: any = new EventEmitter()
    child.pid = nextPid++
    child.unref = () => {}
    child.kill = vi.fn(() => true)
    spawned.push({ bin, args: [...args], env: options?.env || {}, child })
    return child
  }),
  execHermesWithBin: vi.fn(),
}))

vi.mock('../../packages/server/src/modules/hermes/services/profiles/profile', () => ({
  getActiveProfileDir: () => '/tmp/hermes-home',
  getProfileDir: (name: string) => `/tmp/hermes-home/${name}`,
  getHermesBaseDir: () => '/tmp/hermes-home',
  listProfileNamesFromDisk: () => ['default'],
}))

vi.mock('../../packages/server/src/modules/studio/public/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import {
  classifyGatewayExit,
  isManagedGatewaySupervised,
  managedGatewayLaunch,
  recordedLiveGatewayPid,
  resetManagedGatewayRunnerForTests,
  setOtherGatewayProbeForTests,
  startGatewayRunManaged,
} from '../../packages/server/src/modules/hermes/services/gateway/runner'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { runSerializedGatewayRestart } from '../../packages/server/src/modules/hermes/services/gateway/autostart'

const HOME = '/tmp/hermes-home'

beforeEach(() => {
  vi.useFakeTimers()
  spawned.length = 0
  resetManagedGatewayRunnerForTests()
  setOtherGatewayProbeForTests(() => null)
})

afterEach(() => {
  resetManagedGatewayRunnerForTests()
  vi.useRealTimers()
})

describe('classifyGatewayExit', () => {
  const long = { ranMs: 60_000, externalSupervisorFlag: true }
  it('relaunches on the restart code', () => {
    expect(classifyGatewayExit(75, null, long)).toBe('restart')
  })
  it('separates a clean exit from a fatal config', () => {
    expect(classifyGatewayExit(0, null, long)).toBe('stopped')
    expect(classifyGatewayExit(78, null, long)).toBe('fatal')
  })
  it('treats signals and failures as crashes', () => {
    expect(classifyGatewayExit(null, 'SIGKILL', long)).toBe('crash')
    expect(classifyGatewayExit(1, null, long)).toBe('crash')
  })
  it('retries without the flag only on an early argparse exit', () => {
    expect(classifyGatewayExit(2, null, { ranMs: 800, externalSupervisorFlag: true })).toBe('retry-without-flag')
    expect(classifyGatewayExit(2, null, { ranMs: 800, externalSupervisorFlag: false })).toBe('crash')
    expect(classifyGatewayExit(2, null, long)).toBe('crash')
  })
})

describe('managedGatewayLaunch', () => {
  it('declares Studio as the external supervisor and turns off the storm backoff', () => {
    const launch = managedGatewayLaunch(HOME, { externalSupervisorFlag: true, env: { PATH: '/bin' } })
    expect(launch.args).toEqual(['gateway', 'run', '--replace', '--external-supervisor'])
    expect(launch.env).toMatchObject({
      PATH: '/bin',
      HERMES_HOME: HOME,
      HERMES_GATEWAY_EXTERNAL_SUPERVISOR: '1',
      HERMES_GATEWAY_MAX_STARTS: '0',
    })
  })
  it('keeps an operator-set storm limit and can drop the flag', () => {
    const launch = managedGatewayLaunch(HOME, { externalSupervisorFlag: false, env: { HERMES_GATEWAY_MAX_STARTS: '9' } })
    expect(launch.args).toEqual(['gateway', 'run', '--replace'])
    expect(launch.env.HERMES_GATEWAY_MAX_STARTS).toBe('9')
  })
})

describe('managed gateway supervision', () => {
  it('relaunches promptly when Hermes hands a restart back (exit 75), without using the crash budget', () => {
    startGatewayRunManaged('hermes', { profileDir: HOME })
    for (let i = 0; i < 6; i++) {
      vi.advanceTimersByTime(10_000)
      spawned[spawned.length - 1].child.emit('exit', 75, null)
      vi.advanceTimersByTime(499)
      expect(spawned).toHaveLength(i + 1)
      vi.advanceTimersByTime(1)
      expect(spawned).toHaveLength(i + 2)
    }
    expect(spawned.every(s => s.args.includes('--external-supervisor'))).toBe(true)
    expect(isManagedGatewaySupervised(HOME)).toBe(true)
  })

  it('does not respawn over a gateway that replaced ours', () => {
    setOtherGatewayProbeForTests((_dir, exited) => exited + 500)
    startGatewayRunManaged('hermes', { profileDir: HOME })
    vi.advanceTimersByTime(10_000)
    spawned[0].child.emit('exit', 0, null)
    vi.advanceTimersByTime(60_000)
    expect(spawned).toHaveLength(1)
    expect(isManagedGatewaySupervised(HOME)).toBe(false)
  })

  it('respawns a clean exit when no other gateway serves the profile', () => {
    startGatewayRunManaged('hermes', { profileDir: HOME })
    vi.advanceTimersByTime(10_000)
    spawned[0].child.emit('exit', 0, null)
    vi.advanceTimersByTime(2_000)
    expect(spawned).toHaveLength(2)
  })

  it('never respawns a fatal configuration exit', () => {
    startGatewayRunManaged('hermes', { profileDir: HOME })
    spawned[0].child.emit('exit', 78, null)
    vi.advanceTimersByTime(60_000)
    expect(spawned).toHaveLength(1)
  })

  it('stops respawning a crash loop after three tries', () => {
    startGatewayRunManaged('hermes', { profileDir: HOME })
    for (let i = 0; i < 5; i++) {
      spawned[spawned.length - 1].child.emit('exit', 1, null)
      vi.advanceTimersByTime(2_000)
    }
    expect(spawned).toHaveLength(4)
  })

  it('counts an immediate restart exit (lost lock race) as a failed start', () => {
    startGatewayRunManaged('hermes', { profileDir: HOME })
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(1_000)
      spawned[spawned.length - 1].child.emit('exit', 75, null)
      vi.advanceTimersByTime(2_000)
    }
    expect(spawned).toHaveLength(4)
  })

  it('falls back to a plain run --replace when Hermes rejects --external-supervisor', () => {
    startGatewayRunManaged('hermes', { profileDir: HOME })
    vi.advanceTimersByTime(700)
    spawned[0].child.emit('exit', 2, null)
    vi.advanceTimersByTime(0)
    expect(spawned).toHaveLength(2)
    expect(spawned[1].args).toEqual(['gateway', 'run', '--replace'])
    startGatewayRunManaged('hermes', { profileDir: HOME })
    expect(spawned[2].args).toEqual(['gateway', 'run', '--replace'])
  })

  it('ignores the exit of a child that a newer start already replaced', () => {
    startGatewayRunManaged('hermes', { profileDir: HOME })
    startGatewayRunManaged('hermes', { profileDir: HOME })
    spawned[0].child.emit('exit', 1, null)
    vi.advanceTimersByTime(10_000)
    expect(spawned).toHaveLength(2)
  })

  it('a fresh start cancels a pending respawn', () => {
    startGatewayRunManaged('hermes', { profileDir: HOME })
    spawned[0].child.emit('exit', null, 'SIGKILL')
    startGatewayRunManaged('hermes', { profileDir: HOME })
    vi.advanceTimersByTime(10_000)
    expect(spawned).toHaveLength(2)
  })
})

describe('recordedLiveGatewayPid', () => {
  it('reads the live PID Hermes recorded', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gw-pid-'))
    try {
      expect(recordedLiveGatewayPid(dir, () => true)).toBeNull()
      writeFileSync(join(dir, 'gateway.pid'), JSON.stringify({ pid: 4242, argv: ['gateway', 'run'] }))
      expect(recordedLiveGatewayPid(dir, () => true)).toBe(4242)
      expect(recordedLiveGatewayPid(dir, () => false)).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('runSerializedGatewayRestart', () => {
  it('runs overlapping restarts one after another and folds extra requests into the queued one', async () => {
    vi.useRealTimers()
    const events: string[] = []
    let release!: () => void
    const firstGate = new Promise<void>(resolve => { release = resolve })
    let runs = 0
    const restart = async () => {
      const n = ++runs
      events.push(`start${n}`)
      if (n === 1) await firstGate
      events.push(`end${n}`)
      return n
    }
    const a = runSerializedGatewayRestart('p', restart)
    const b = runSerializedGatewayRestart('p', restart)
    const c = runSerializedGatewayRestart('p', restart)
    await Promise.resolve()
    expect(events).toEqual(['start1'])
    release()
    expect(await a).toBe(1)
    expect(await b).toBe(2)
    expect(await c).toBe(2)
    expect(events).toEqual(['start1', 'end1', 'start2', 'end2'])
    expect(await runSerializedGatewayRestart('p', restart)).toBe(3)
  })

  it('still runs the queued restart when the running one fails', async () => {
    vi.useRealTimers()
    const first = runSerializedGatewayRestart('q', async () => { throw new Error('boom') })
    const second = runSerializedGatewayRestart('q', async () => 'ok')
    await expect(first).rejects.toThrow('boom')
    await expect(second).resolves.toBe('ok')
  })
})
