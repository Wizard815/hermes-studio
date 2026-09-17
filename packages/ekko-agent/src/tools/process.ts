import type { AgentTool, AgentToolContext, AgentToolResult } from './types'
import { getBackgroundProcess, listBackgroundProcesses, type BackgroundProcess } from './background-process-registry'

export interface ProcessExecInput extends Record<string, unknown> {
  action: 'poll' | 'log' | 'kill' | 'list'
  processId?: string
}

/**
 * Companion to terminal_exec(background=true): checks on, reads output from,
 * or stops a background process started earlier in the same session by its
 * processId. Deliberately simple — poll/log/kill/list, no notify-on-complete
 * (the model must actively check back; there is no push channel from a
 * background process into the chat yet).
 */
export class ProcessExecTool implements AgentTool<ProcessExecInput> {
  readonly definition: AgentTool['definition'] = {
    name: 'process_exec',
    description: [
      'Check on, read output from, list, or stop a background process started by terminal_exec(background=true) in this session.',
      'action="poll" reports whether it is still running and its exit code if it has finished.',
      'action="log" returns the output captured so far (bounded, same truncation rules as terminal_exec).',
      'action="kill" sends a termination signal.',
      'action="list" (no processId needed) lists every background process from this session, running or finished.',
      'A processId only exists after terminal_exec(background=true) returns one — this tool cannot start anything itself.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['poll', 'log', 'kill', 'list'], description: 'What to do.' },
        processId: { type: 'string', description: 'The processId returned by terminal_exec(background=true). Not needed for action="list".' },
      },
      required: ['action'],
      additionalProperties: false,
    },
  }

  async execute(input: ProcessExecInput, _context: AgentToolContext = {}): Promise<AgentToolResult> {
    if (input.action === 'list') {
      const all = listBackgroundProcesses()
      if (all.length === 0) {
        return { ok: true, content: 'No background processes in this session.', data: { processes: [] } }
      }
      return {
        ok: true,
        content: all.map(describeOneLine).join('\n'),
        data: { processes: all.map(summarize) },
      }
    }

    const processId = input.processId
    if (!processId) {
      return { ok: false, content: 'processId is required for this action.', error: 'missing processId' }
    }
    const proc = getBackgroundProcess(processId)
    if (!proc) {
      return {
        ok: false,
        content: `No background process found with id ${processId}. It may never have existed, or the server has restarted since it was started.`,
        error: 'not found',
      }
    }

    switch (input.action) {
      case 'poll':
        return {
          ok: true,
          content: describeOneLine(proc),
          data: summarize(proc),
        }
      case 'log': {
        const stdout = proc.stdout.text()
        const stderr = proc.stderr.text()
        const content = [stdout, stderr].filter(Boolean).join('\n') || '(no output yet)'
        return { ok: true, content: `${describeOneLine(proc)}\n\n${content}`, data: summarize(proc) }
      }
      case 'kill': {
        if (proc.status !== 'running') {
          return { ok: true, content: `Process ${processId} already ${proc.status}, nothing to kill.`, data: summarize(proc) }
        }
        // Signal only — status flips to 'killed' once the OS actually
        // confirms termination via the child's 'close' event, not here.
        proc.killRequested = true
        proc.child.kill('SIGTERM')
        return {
          ok: true,
          content: `Sent SIGTERM to process ${processId} (pid ${proc.pid}). Poll again to confirm it has actually exited.`,
          data: summarize(proc),
        }
      }
      default:
        return { ok: false, content: `Unknown action "${input.action}".`, error: 'invalid action' }
    }
  }
}

function summarize(proc: BackgroundProcess) {
  return {
    processId: proc.processId,
    pid: proc.pid,
    command: proc.command,
    args: proc.args,
    cwd: proc.cwd,
    status: proc.status,
    exitCode: proc.exitCode,
    startedAt: proc.startedAt,
    exitedAt: proc.exitedAt,
    error: proc.error,
    stdoutBytes: proc.stdout.totalBytes,
    stderrBytes: proc.stderr.totalBytes,
  }
}

function describeOneLine(proc: BackgroundProcess): string {
  const age = Math.round((Date.now() - proc.startedAt) / 1000)
  const cmd = [proc.command, ...proc.args].join(' ')
  if (proc.status === 'running') {
    return `${proc.processId}: running (pid ${proc.pid}, ${age}s) — ${cmd}`
  }
  const took = proc.exitedAt ? Math.round((proc.exitedAt - proc.startedAt) / 1000) : age
  const detail = proc.status === 'error' ? `error: ${proc.error}` : `exit code ${proc.exitCode}`
  return `${proc.processId}: ${proc.status} after ${took}s (${detail}) — ${cmd}`
}

export function createProcessTools(): AgentTool[] {
  return [new ProcessExecTool()]
}
