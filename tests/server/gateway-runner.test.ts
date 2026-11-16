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
  adoptRunningGateway,
  classifyGatewayExit,
  detachManagedGatewaysForShutdown,
  setGatewayPidAliveForTests,
  isManagedGatewaySupervised,
  managedGatewayLaunch,
  procStatIsZombie,
  recordedLiveGatewayPid,
  releaseManagedGatewayForStop,
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

  it('does not respawn a gateway released for a planned stop, and does not warn', async () => {
    const { logger } = await import('../../packages/server/src/modules/studio/public/logging')
    vi.mocked(logger.warn).mockClear()
    startGatewayRunManaged('hermes', { profileDir: HOME })
    vi.advanceTimersByTime(10_000)
    expect(releaseManagedGatewayForStop(HOME)).toBe(spawned[0].child.pid)
    expect(isManagedGatewaySupervised(HOME)).toBe(false)
    // `hermes gateway stop` takes longer than the respawn delay
    vi.advanceTimersByTime(5_000)
    spawned[0].child.emit('exit', 0, null)
    vi.advanceTimersByTime(60_000)
    expect(spawned).toHaveLength(1)
    expect(logger.warn).not.toHaveBeenCalled()
    // the restart's own start then supervises the new gateway as usual
    startGatewayRunManaged('hermes', { profileDir: HOME })
    expect(isManagedGatewaySupervised(HOME)).toBe(true)
    expect(releaseManagedGatewayForStop('/tmp/other-home')).toBeNull()
  })

  it('a fresh start cancels a pending respawn', () => {
    startGatewayRunManaged('hermes', { profileDir: HOME })
    spawned[0].child.emit('exit', null, 'SIGKILL')
    startGatewayRunManaged('hermes', { profileDir: HOME })
    vi.advanceTimersByTime(10_000)
    expect(spawned).toHaveLength(2)
  })
})

describe('a gateway left by an earlier Studio', () => {
  it('is adopted without a restart and relaunched when it exits', () => {
    const alive = new Set([4242])
    setGatewayPidAliveForTests(pid => alive.has(pid))
    expect(adoptRunningGateway('hermes', HOME, 4242)).toBe(true)
    expect(adoptRunningGateway('hermes', HOME, 4242)).toBe(true)
    expect(isManagedGatewaySupervised(HOME)).toBe(true)
    vi.advanceTimersByTime(30_000)
    expect(spawned).toHaveLength(0)
    // Hermes's own restart hands it back by exiting
    alive.delete(4242)
    vi.advanceTimersByTime(1_000)
    expect(spawned).toHaveLength(0)
    vi.advanceTimersByTime(500)
    expect(spawned).toHaveLength(1)
    expect(spawned[0].args).toContain('--replace')
    vi.advanceTimersByTime(30_000)
    expect(spawned).toHaveLength(1)
  })

  it('is not relaunched over a gateway that replaced it', () => {
    const alive = new Set([4242])
    setGatewayPidAliveForTests(pid => alive.has(pid))
    setOtherGatewayProbeForTests(() => 5000)
    adoptRunningGateway('hermes', HOME, 4242)
    alive.delete(4242)
    vi.advanceTimersByTime(10_000)
    expect(spawned).toHaveLength(0)
  })

  it('is not adopted when dead, and a planned stop or a fresh start ends the watch', () => {
    const alive = new Set([4242])
    setGatewayPidAliveForTests(pid => alive.has(pid))
    expect(adoptRunningGateway('hermes', HOME, 7)).toBe(false)
    adoptRunningGateway('hermes', HOME, 4242)
    expect(releaseManagedGatewayForStop(HOME)).toBe(4242)
    alive.delete(4242)
    vi.advanceTimersByTime(10_000)
    expect(spawned).toHaveLength(0)

    alive.add(4242)
    adoptRunningGateway('hermes', HOME, 4242)
    startGatewayRunManaged('hermes', { profileDir: HOME })
    alive.delete(4242)
    vi.advanceTimersByTime(10_000)
    expect(spawned).toHaveLength(1)
  })
})

describe('detachManagedGatewaysForShutdown', () => {
  it('leaves the gateway running and never respawns after shutdown begins', () => {
    startGatewayRunManaged('hermes', { profileDir: HOME })
    spawned[0].child.emit('exit', 1, null)
    startGatewayRunManaged('hermes', { profileDir: HOME })
    expect(detachManagedGatewaysForShutdown()).toBe(1)
    expect(spawned[1].child.kill).not.toHaveBeenCalled()
    spawned[1].child.emit('exit', 75, null)
    vi.advanceTimersByTime(60_000)
    expect(spawned).toHaveLength(2)
    expect(startGatewayRunManaged('hermes', { profileDir: HOME }).pid).toBeNull()
  })
})

describe('procStatIsZombie', () => {
  it('reads the state after the command name, even one with spaces and parens', () => {
    expect(procStatIsZombie('339177 (hermes) Z 1 339177 339177 0 -1')).toBe(true)
    expect(procStatIsZombie('339177 (python (x) y) S 1 339177')).toBe(false)
    expect(procStatIsZombie('')).toBe(false)
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
