import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'

/**
 * In-memory registry for terminal_exec(background=true) processes, so a later
 * process_exec(poll|log|kill) call can find the same child. Scoped to this
 * server process's lifetime: a Studio restart loses track of (but does not
 * necessarily kill, if the OS keeps it running) any background process — that
 * limitation is stated in both tools' descriptions, not hidden.
 *
 * One registry per server process (module-level singleton), not per session —
 * a processId is an opaque UUID the model must have been handed by
 * terminal_exec, so cross-session access requires already knowing that UUID.
 */

export interface BackgroundProcess {
  processId: string
  pid: number
  command: string
  args: string[]
  cwd: string
  startedAt: number
  child: ChildProcessWithoutNullStreams
  /** Bounded, append-only capture — same shape terminal_exec uses for foreground output. */
  stdout: { append(chunk: Buffer): void; text(): string; totalBytes: number; truncated: boolean }
  stderr: { append(chunk: Buffer): void; text(): string; totalBytes: number; truncated: boolean }
  status: 'running' | 'exited' | 'killed' | 'error'
  exitCode: number | null
  exitedAt: number | null
  error: string | null
  /** Set by process_exec(kill) before the signal takes effect, so the
   * eventual 'close' handler can tell a requested kill apart from the
   * process just exiting on its own — status only flips once the OS
   * actually confirms it via 'close', never synchronously on the kill call. */
  killRequested: boolean
}

const registry = new Map<string, BackgroundProcess>()

// Bound how many finished processes we remember so a long session doesn't leak
// memory across dozens of background launches; running ones are never evicted.
const MAX_FINISHED_ENTRIES = 50

export function registerBackgroundProcess(
  entry: Omit<BackgroundProcess, 'processId'>,
): BackgroundProcess {
  const processId = randomUUID()
  const full: BackgroundProcess = { ...entry, processId }
  registry.set(processId, full)
  pruneFinished()
  return full
}

export function getBackgroundProcess(processId: string): BackgroundProcess | undefined {
  return registry.get(processId)
}

export function listBackgroundProcesses(): BackgroundProcess[] {
  return Array.from(registry.values())
}

function pruneFinished(): void {
  const finished = Array.from(registry.values())
    .filter(p => p.status !== 'running')
    .sort((a, b) => (a.exitedAt ?? 0) - (b.exitedAt ?? 0))
  const excess = finished.length - MAX_FINISHED_ENTRIES
  for (let i = 0; i < excess; i++) registry.delete(finished[i].processId)
}
