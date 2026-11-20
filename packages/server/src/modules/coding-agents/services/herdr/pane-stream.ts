import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { herdrArgs, type HerdrSettings } from './runtime'
import { NdjsonReader } from './socket-client'

/**
 * One herdr pane as a terminal stream: `herdr terminal session observe|control
 * <pane>`, herdr's own API for apps that draw a pane themselves (as Herdr App
 * does). herdr sends that pane's screen as `terminal.frame` lines (base64
 * ANSI at the size asked for) and, in control mode, takes `terminal.input`,
 * `terminal.resize`, `terminal.scroll` and `terminal.release` lines. Control
 * sizes the pane's terminal to this stream (one controller per pane;
 * `takeover` replaces another). Studio's Herdr App layout draws each pane with
 * one of these instead of herdr's whole terminal UI.
 */
export interface PaneStream {
  mode: 'observe' | 'control'
  write(data: string): void
  resize(cols: number, rows: number): void
  scroll(direction: 'up' | 'down', lines: number): void
  close(): void
}

export function paneStream(binary: string, settings: Pick<HerdrSettings, 'session'>, mode: 'observe' | 'control', target: string, cols: number, rows: number, takeover: boolean,
  onData: (bytes: string) => void, onClose: (reason: string) => void): PaneStream {
  const args = herdrArgs(settings, ['terminal', 'session', mode, target, '--cols', String(cols), '--rows', String(rows), ...(mode === 'control' && takeover ? ['--takeover'] : [])])
  const child: ChildProcessWithoutNullStreams = spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'], env: process.env })
  const reader = new NdjsonReader()
  let closed = false
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    for (const record of reader.push(chunk) as any[]) {
      if (record?.type === 'terminal.frame' && typeof record.bytes === 'string') onData(record.bytes)
      else if (record?.type === 'terminal.closed') finish(String(record.reason || 'closed'))
    }
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-2000) })
  child.on('error', error => finish(error.message))
  child.on('exit', () => finish(stderr.trim() || 'closed'))
  const send = (command: Record<string, unknown>) => {
    if (mode !== 'control' || closed || !child.stdin.writable) return
    child.stdin.write(`${JSON.stringify(command)}\n`)
  }
  function finish(reason: string) {
    if (closed) return
    closed = true
    try { child.stdin.end() } catch { /* ignore */ }
    if (child.exitCode === null) child.kill()
    onClose(reason)
  }
  return {
    mode,
    write: data => send({ type: 'terminal.input', text: data }),
    resize: (c, r) => send({ type: 'terminal.resize', cols: c, rows: r }),
    scroll: (direction, lines) => send({ type: 'terminal.scroll', direction, lines }),
    close: () => {
      send({ type: 'terminal.release' })
      finish('closed_by_client')
    },
  }
}
