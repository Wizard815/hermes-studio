import type { ChildProcess } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import type { AgentApprovalChoice, AgentApprovalRequest } from '../runtime/run-manager'

/**
 * One Studio turn on `codex app-server`: the protocol where Codex asks before
 * acting (`codex exec` cannot ask anyone). Notifications go to Studio's usual
 * Codex event handler; approval requests go to Studio's approval card.
 */
export interface CodexAppServerTurnInput {
  threadId?: string
  cwd: string
  text: string
  /** Local image files sent with the message. */
  images?: string[]
  developerInstructions?: string
}

export interface CodexAppServerTurnHandlers {
  notify(method: string, params: any): void
  ask(request: AgentApprovalRequest): Promise<AgentApprovalChoice>
}

/** Codex asks for anything it does not know to be safe; commands run with the agent's usual access. */
const APPROVAL_POLICY = 'untrusted'
const SANDBOX = 'danger-full-access'

export function codexApprovalRequest(method: string, params: any, knownPaths: string[] = []): AgentApprovalRequest {
  const command = Array.isArray(params?.command) ? params.command.join(' ') : String(params?.command || '')
  if (method === 'item/fileChange/requestApproval' || method === 'applyPatchApproval') {
    const paths = [
      ...(params?.fileChanges && typeof params.fileChanges === 'object' ? Object.keys(params.fileChanges) : []),
      ...knownPaths,
      ...(params?.grantRoot ? [String(params.grantRoot)] : []),
    ]
    return { key: 'edit', action: { kind: 'write', paths }, title: 'Codex wants to change files', description: String(params?.reason || 'Apply a patch'), ...(paths.length ? { command: paths.join(', ') } : {}) }
  }
  const executable = command.trim().split(/\s+/)[0] || ''
  return { key: `command:${executable}`, action: { kind: 'command', command }, title: 'Codex wants to run a command', description: String(params?.reason || 'Run a command'), ...(command ? { command: command.slice(0, 4000) } : {}) }
}

/** The answer in the shape each Codex request expects. */
export function codexApprovalResponse(method: string, choice: AgentApprovalChoice): any {
  if (method === 'execCommandApproval' || method === 'applyPatchApproval') {
    return { decision: choice === 'deny' ? 'denied' : choice === 'session' ? 'approved_for_session' : 'approved' }
  }
  return { decision: choice === 'deny' ? 'decline' : choice === 'session' ? 'acceptForSession' : 'accept' }
}

const APPROVAL_METHODS = new Set(['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'execCommandApproval', 'applyPatchApproval'])

export class CodexAppServerTurn {
  private buffer = ''
  private decoder = new StringDecoder('utf8')
  private sequence = 0
  private pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>()
  private threadId = ''
  /** Files each file-change item touches (its approval request carries only the item id). */
  private itemPaths = new Map<string, string[]>()
  private done?: { resolve(): void; reject(error: Error): void }

  constructor(private child: ChildProcess, private handlers: CodexAppServerTurnHandlers) {
    child.stdout?.on('data', (chunk: Buffer) => {
      this.buffer += this.decoder.write(chunk)
      let end: number
      while ((end = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, end).trim()
        this.buffer = this.buffer.slice(end + 1)
        if (line.startsWith('{')) this.receive(line)
      }
    })
    child.on('close', () => this.fail(new Error('Codex app-server closed before the turn completed')))
  }

  private write(message: any) {
    this.child.stdin?.write(`${JSON.stringify(message)}\n`)
  }

  private request(method: string, params: any): Promise<any> {
    const id = ++this.sequence
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.write({ id, method, params })
    })
  }

  private fail(error: Error) {
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
    this.done?.reject(error)
    this.done = undefined
  }

  private receive(line: string) {
    let message: any
    try { message = JSON.parse(line) } catch { return }
    // A request from Codex (it is waiting on our answer).
    if (message.method && message.id !== undefined) {
      if (APPROVAL_METHODS.has(message.method)) {
        const { id, method, params } = message
        void this.handlers.ask(codexApprovalRequest(method, params, this.itemPaths.get(String(params?.itemId || '')) || []))
          .then(choice => this.write({ id, result: codexApprovalResponse(method, choice) }))
          .catch(() => this.write({ id, result: codexApprovalResponse(method, 'deny') }))
      } else {
        this.write({ id: message.id, error: { code: -32601, message: 'Studio does not handle this request' } })
      }
      return
    }
    if (message.method) {
      const item = message.params?.item
      if (item?.id && Array.isArray(item.changes)) {
        this.itemPaths.set(String(item.id), item.changes.map((change: any) => String(change?.path || '')).filter(Boolean))
      }
      this.handlers.notify(message.method, message.params || {})
      if (message.method === 'turn/completed' && (!this.threadId || message.params?.threadId === this.threadId)) {
        this.done?.resolve()
        this.done = undefined
      }
      return
    }
    const pending = this.pending.get(message.id)
    if (!pending) return
    this.pending.delete(message.id)
    if (message.error) pending.reject(new Error(message.error.message || 'Codex app-server error'))
    else pending.resolve(message.result)
  }

  /** Run the turn; resolves when Codex reports it completed. */
  async run(input: CodexAppServerTurnInput): Promise<void> {
    await this.request('initialize', { clientInfo: { name: 'hermes-studio', version: '1' } })
    this.write({ method: 'initialized' })
    const common = { cwd: input.cwd, approvalPolicy: APPROVAL_POLICY, sandbox: SANDBOX, ...(input.developerInstructions ? { developerInstructions: input.developerInstructions } : {}) }
    const opened = input.threadId
      ? await this.request('thread/resume', { ...common, threadId: input.threadId })
      : await this.request('thread/start', common)
    this.threadId = String(opened?.thread?.id || input.threadId || '')
    if (!this.threadId) throw new Error('Codex app-server did not open a thread')
    this.handlers.notify('thread/started', { threadId: this.threadId })
    const finished = new Promise<void>((resolve, reject) => { this.done = { resolve, reject } })
    await this.request('turn/start', { threadId: this.threadId, input: [{ type: 'text', text: input.text }, ...(input.images || []).map(path => ({ type: 'localImage', path }))], approvalPolicy: APPROVAL_POLICY })
    await finished
  }
}
