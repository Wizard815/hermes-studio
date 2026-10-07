/**
 * tmux-backed persistent terminal sessions.
 *
 * Terminals run inside tmux so they survive WebSocket drops, page reloads and
 * server restarts. Sessions are named deterministically per chat session so
 * reconnecting reattaches to the same shell.
 */

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'

const TMUX_BIN_CANDIDATES = ['/usr/bin/tmux', '/usr/local/bin/tmux', '/bin/tmux', '/opt/homebrew/bin/tmux']
export const TMUX_PREFIX = 'hermes_'

let tmuxPathCache: string | null | undefined

export function tmuxBinary(): string | null {
  if (tmuxPathCache !== undefined) return tmuxPathCache
  if (process.platform === 'win32') {
    tmuxPathCache = null
    return null
  }
  for (const candidate of TMUX_BIN_CANDIDATES) {
    if (existsSync(candidate)) {
      tmuxPathCache = candidate
      return candidate
    }
  }
  try {
    const resolved = execFileSync('which', ['tmux'], { encoding: 'utf-8' }).trim()
    tmuxPathCache = resolved || null
  } catch {
    tmuxPathCache = null
  }
  return tmuxPathCache
}

export function tmuxAvailable(): boolean {
  return tmuxBinary() !== null
}

/** tmux session names may not contain ':' or '.', and must be shell-safe. */
function sanitize(value: string): string {
  return String(value || '')
    .replace(/[^A-Za-z0-9_-]/g, '_')
    .slice(0, 64) || 'default'
}

/** Deterministic tmux session name for a chat session + terminal index. */
export function tmuxSessionName(chatSessionId: string, index: number): string {
  return `${TMUX_PREFIX}${sanitize(chatSessionId)}_${index}`
}

/** True when the name belongs to the given chat session. */
export function isSessionForChat(name: string, chatSessionId: string): boolean {
  return name.startsWith(`${TMUX_PREFIX}${sanitize(chatSessionId)}_`)
}

function runTmux(args: string[], options?: { timeout?: number }): string {
  const bin = tmuxBinary()
  if (!bin) throw new Error('tmux is not available')
  return execFileSync(bin, args, {
    encoding: 'utf-8',
    timeout: options?.timeout ?? 10_000,
  })
}

export interface TmuxSessionInfo {
  name: string
  createdAt: number
  attached: boolean
  windows: number
}

/** List tmux sessions belonging to a chat session, oldest first. */
export function listChatSessions(chatSessionId: string): TmuxSessionInfo[] {
  if (!tmuxAvailable()) return []
  let output = ''
  try {
    output = runTmux(['list-sessions', '-F', '#{session_name}\t#{session_created}\t#{session_attached}\t#{session_windows}'])
  } catch {
    // No tmux server / no sessions.
    return []
  }
  const sessions: TmuxSessionInfo[] = []
  for (const line of output.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const [name, created, attached, windows] = trimmed.split('\t')
    if (!name || !isSessionForChat(name, chatSessionId)) continue
    sessions.push({
      name,
      createdAt: Number(created || 0) * 1000 || Date.now(),
      attached: attached === '1',
      windows: Number(windows || 1) || 1,
    })
  }
  return sessions.sort((a, b) => a.createdAt - b.createdAt)
}

export function ensureTmuxSession(name: string, cwd: string): string {
  runTmux(['new-session', '-A', '-d', '-s', name, '-c', cwd])
  // Embedding tmux in an xterm.js client:
  //  - terminal-overrides smcup@/rmcup@: avoid the alternate screen so we do
  //    not lose as much rendering context.
  //  - mouse off: xterm keeps the drag, so plain drag-select works and Ctrl+C
  //    copies with no modifier. `mouse on` instead gave tmux the mouse, which
  //    meant dragging produced NO xterm selection at all -- copy then silently
  //    did nothing unless Shift was held -- and tmux's mouse-tracking sequences
  //    were echoed by bash as literal text into the prompt. The wheel now
  //    scrolls xterm's own scrollback rather than tmux copy-mode history.
  //  - window-size largest: a single client size wins, preventing the
  //    redraw/overdraw that came from two clients fighting over the pane.
  try {
    runTmux(['set-option', '-s', 'terminal-overrides', ',xterm-256color:smcup@:rmcup@'])
    runTmux(['set-option', '-t', name, 'status', 'off'])
    runTmux(['set-option', '-t', name, 'destroy-unattached', 'off'])
    runTmux(['set-option', '-t', name, 'history-limit', '50000'])
    runTmux(['set-option', '-t', name, 'window-size', 'largest'])
    runTmux(['set-window-option', '-t', name, 'aggressive-resize', 'off'])
    runTmux(['set-option', '-t', name, 'mouse', 'off'])
    runTmux(['set-option', '-t', name, 'focus-events', 'on'])
  } catch {
    // Option tuning is best-effort.
  }
  return name
}

/**
 * Detach every client currently attached to a tmux session. Used before we
 * attach our own client so only one client mirrors the pane and input is never
 * split across competing attachments.
 */
export function detachOtherClients(name: string): void {
  if (!tmuxAvailable()) return
  try {
    const output = runTmux(['list-clients', '-t', name, '-F', '#{client_tty}'])
    for (const tty of output.split('\n').map(line => line.trim()).filter(Boolean)) {
      try {
        runTmux(['detach-client', '-t', tty])
      } catch {
        // Client may have already gone.
      }
    }
  } catch {
    // No clients / no session.
  }
}

/** Capture pane history as text for restoring scrollback after a restart. */
export function capturePane(name: string, lines = 2000): string {
  if (!tmuxAvailable()) return ''
  try {
    return runTmux(['capture-pane', '-p', '-t', name, '-S', `-${Math.max(1, lines)}`])
  } catch {
    return ''
  }
}

/** Type literal text into a session (no implicit Enter). */
export function sendText(name: string, text: string): void {
  if (!tmuxAvailable()) throw new Error('tmux is not available')
  runTmux(['send-keys', '-t', name, '-l', text])
}

/** Send a named key (Enter, C-c, Escape, …) to a session. */
export function sendKey(name: string, key: string): void {
  if (!tmuxAvailable()) throw new Error('tmux is not available')
  runTmux(['send-keys', '-t', name, key])
}

/** Current working directory of the pane's foreground process. */
export function paneCwd(name: string): string {
  if (!tmuxAvailable()) return ''
  try {
    return runTmux(['display-message', '-p', '-t', name, '#{pane_current_path}']).trim()
  } catch {
    return ''
  }
}

export function killTmuxSession(name: string): void {
  if (!tmuxAvailable()) return
  try {
    runTmux(['kill-session', '-t', name])
  } catch {
    // Already gone.
  }
}

/** True when the named tmux session currently exists. */
export function tmuxSessionExists(name: string): boolean {
  if (!tmuxAvailable()) return false
  try {
    runTmux(['has-session', '-t', name])
    return true
  } catch {
    return false
  }
}

/** Highest numeric suffix used by this chat session, or 0 when none exist. */
export function nextSessionIndex(chatSessionId: string): number {
  const sessions = listChatSessions(chatSessionId)
  let max = 0
  for (const session of sessions) {
    const match = session.name.match(/_(\d+)$/)
    if (match) max = Math.max(max, Number(match[1]))
  }
  return max + 1
}
