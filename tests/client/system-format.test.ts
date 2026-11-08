import { describe, expect, it } from 'vitest'
import { formatBytes, formatRate, formatUptime, pushHistory, sortProcesses } from '@/utils/system-format'

const proc = (pid: number, name: string, cpuPercent: number, memRssBytes: number, user = 'root', command = name) => ({ pid, name, cpuPercent, memRssBytes, user, command })

describe('System page helpers', () => {
  it('formats sizes, rates and uptime', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(16 * 1024 ** 3)).toBe('16.0 GB')
    expect(formatRate(null)).toBe('–')
    expect(formatRate(2048)).toBe('2.0 KB/s')
    expect(formatUptime(3 * 86400 + 5 * 3600)).toBe('3d 5h')
    expect(formatUptime(125)).toBe('2m')
  })

  it('keeps a fixed-length history', () => {
    let history: number[] = []
    for (let i = 0; i < 65; i++) history = pushHistory(history, i)
    expect(history).toHaveLength(60)
    expect(history[0]).toBe(5)
    expect(pushHistory([], Number.NaN)).toEqual([0])
  })

  it('sorts and filters processes like top', () => {
    const list = [proc(10, 'node', 12, 300), proc(20, 'dockerd', 40, 100), proc(30, 'bash', 0, 5, 'agent', 'bash -l')]
    expect(sortProcesses(list, 'cpuPercent', true).map(p => p.pid)).toEqual([20, 10, 30])
    expect(sortProcesses(list, 'memRssBytes', true).map(p => p.pid)).toEqual([10, 20, 30])
    expect(sortProcesses(list, 'name', false).map(p => p.name)).toEqual(['bash', 'dockerd', 'node'])
    expect(sortProcesses(list, 'cpuPercent', true, 'DOCK').map(p => p.pid)).toEqual([20])
    expect(sortProcesses(list, 'cpuPercent', true, '30').map(p => p.pid)).toEqual([30])
    expect(sortProcesses(list, 'cpuPercent', true, 'agent').map(p => p.pid)).toEqual([30])
  })
})
