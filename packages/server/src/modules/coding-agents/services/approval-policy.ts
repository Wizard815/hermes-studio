import { homedir } from 'node:os'
import { isAbsolute, relative, resolve } from 'node:path'

/**
 * Which agent requests Studio puts in front of you. The agent's own rules
 * decide when it asks; this decides which of those questions you see, and
 * Studio answers the rest. Modes, per agent:
 *
 * - ask (default): reading anywhere and writing inside the chat's folder go
 *   ahead; commands, writes outside the folder and other tools ask.
 * - guarded: the agent acts on its own, but dangerous actions still ask:
 *   deleting or moving things outside the folder (or the folder itself),
 *   sudo, disk and system tools, killing processes, force pushes, piping a
 *   download into a shell, writing outside the folder.
 * - auto: the agent never asks (its yolo mode; Studio is not consulted).
 */
export type AgentApprovalPolicyMode = 'ask' | 'guarded' | 'auto'

export interface AgentAction {
  kind: 'read' | 'write' | 'command' | 'other'
  /** Files or folders the action touches. */
  paths?: string[]
  /** The command line, for commands. */
  command?: string
}

const DAY_TO_DAY_READS = new Set(['read', 'search', 'fetch', 'think'])

/** An ACP tool call (kind, locations, rawInput) as an action. */
export function acpAction(toolCall: any): AgentAction {
  const raw = toolCall?.rawInput && typeof toolCall.rawInput === 'object' ? toolCall.rawInput : {}
  const paths = [
    ...(Array.isArray(toolCall?.locations) ? toolCall.locations.map((item: any) => item?.path) : []),
    raw.path, raw.file_path, raw.filePath, raw.absolute_path,
  ].filter((value): value is string => typeof value === 'string' && !!value)
  const command = Array.isArray(raw.command) ? raw.command.join(' ') : typeof raw.command === 'string' ? raw.command : typeof raw.cmd === 'string' ? raw.cmd : ''
  const kind = String(toolCall?.kind || '')
  if (kind === 'execute' || command) return { kind: 'command', command, paths }
  if (DAY_TO_DAY_READS.has(kind)) return { kind: 'read', paths }
  if (kind === 'edit' || kind === 'delete' || kind === 'move') return { kind: 'write', paths }
  return { kind: 'other', paths }
}

/** Whether a path is inside the folder (the folder itself counts as outside for deleting). */
export function insideFolder(path: string, folder: string, cwd = folder): boolean {
  if (!folder) return false
  const expanded = path === '~' ? homedir() : path.startsWith('~/') ? resolve(homedir(), path.slice(2)) : path
  const target = isAbsolute(expanded) ? resolve(expanded) : resolve(cwd || folder, expanded)
  const rel = relative(resolve(folder), target)
  return !!rel && !rel.startsWith('..') && !isAbsolute(rel)
}

function writesOutside(paths: string[] | undefined, folder: string): boolean {
  return (paths || []).some(path => !insideFolder(path, folder) && resolve(path) !== resolve(folder))
}

/** Split a shell line into simple commands (good enough to spot dangerous ones). */
function segments(command: string): string[][] {
  const out: string[][] = []
  let current: string[] = []
  let word = ''
  let quote = ''
  const push = () => { if (word) { current.push(word); word = '' } }
  const end = () => { push(); if (current.length) out.push(current); current = [] }
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]
    if (quote) {
      if (char === quote) quote = ''
      else if (char === '\\' && quote === '"' && index + 1 < command.length) word += command[++index]
      else word += char
      continue
    }
    if (char === '"' || char === "'") { quote = char; continue }
    if (char === '\\' && index + 1 < command.length) { word += command[++index]; continue }
    if (/\s/.test(char)) { push(); continue }
    if (char === ';' || char === '\n' || char === '&' || char === '|' || char === '(' || char === ')' || char === '`') {
      // A pipe into a shell is checked by the caller; mark it.
      if (char === '|' && command[index + 1] !== '|') { end(); out.push(['|']); continue }
      end()
      continue
    }
    if (char === '$' && command[index + 1] === '(') { end(); index += 1; continue }
    if (char === '>' ) {
      // A redirection: the next word is a file being written.
      push()
      let next = index + 1
      if (command[next] === '>') next += 1
      while (/\s/.test(command[next] || '')) next += 1
      let target = ''
      while (next < command.length && !/[\s;&|]/.test(command[next])) target += command[next++]
      if (target && !target.startsWith('&')) current.push(`>${target}`)
      index = next - 1
      continue
    }
    word += char
  }
  end()
  return out
}

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish'])
const ALWAYS_DANGEROUS = new Set([
  'sudo', 'su', 'doas', 'mkfs', 'fdisk', 'parted', 'sfdisk', 'wipefs', 'mount', 'umount', 'dd', 'shutdown', 'reboot', 'halt',
  'poweroff', 'systemctl', 'service', 'launchctl', 'kill', 'killall', 'pkill', 'crontab', 'useradd', 'userdel', 'passwd', 'visudo', 'iptables',
])
const DELETES_OR_MOVES = new Set(['rm', 'rmdir', 'unlink', 'shred', 'mv', 'truncate'])
const CHANGES_OWNER = new Set(['chmod', 'chown', 'chgrp'])

function base(word: string): string {
  return word.split('/').pop() || word
}

/** A dangerous command: what guarded mode still asks about. */
export function dangerousCommand(command: string, folder: string, depth = 0): string | null {
  const parts = segments(command)
  for (let index = 0; index < parts.length; index += 1) {
    let words = parts[index]
    if (words[0] === '|') {
      // A download piped into a shell runs code nobody has read.
      const next = parts[index + 1]
      const previous = parts[index - 1]
      if (next && SHELLS.has(base(next[0] || '')) && previous && ['curl', 'wget'].includes(base(previous[0] || ''))) return 'runs a downloaded script'
      continue
    }
    // Leading VAR=value assignments and wrappers.
    while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words = words.slice(1)
    while (words.length && ['env', 'nohup', 'time', 'nice', 'command', 'exec', 'xargs'].includes(base(words[0]))) words = words.slice(1).filter(word => !word.startsWith('-') || word === '--')
    if (!words.length) continue
    const name = base(words[0])
    const args = words.slice(1)
    for (const word of args) if (word.startsWith('>') && !insideFolder(word.slice(1), folder) && !['/dev/null', '/dev/stdout', '/dev/stderr'].includes(word.slice(1))) return `writes ${word.slice(1)}`
    const plain = args.filter(word => !word.startsWith('>'))
    if (ALWAYS_DANGEROUS.has(name)) return `uses ${name}`
    if (SHELLS.has(name)) {
      const at = plain.findIndex(word => /^-[a-z]*c[a-z]*$/.test(word))
      if (at >= 0 && plain[at + 1] && depth < 3) {
        const inner = dangerousCommand(plain[at + 1], folder, depth + 1)
        if (inner) return inner
      }
      continue
    }
    const targets = plain.filter(word => !word.startsWith('-'))
    if (DELETES_OR_MOVES.has(name)) {
      if (!targets.length) continue
      // A $VARIABLE path cannot be checked, so it counts as outside.
      const outside = targets.find(target => target.includes('$') || !insideFolder(target, folder) || /[*?]/.test(target) && !insideFolder(target.replace(/[*?].*$/, 'x'), folder))
      if (outside !== undefined) return `${name === 'mv' ? 'moves' : 'deletes'} ${outside}`
      continue
    }
    if (CHANGES_OWNER.has(name)) {
      const outside = targets.slice(1).find(target => !insideFolder(target, folder))
      if (outside !== undefined) return `changes permissions of ${outside}`
      continue
    }
    if (name === 'find' && (plain.includes('-delete') || plain.includes('-exec'))) {
      const start = targets[0] || '.'
      if (!insideFolder(start, folder) || plain.includes('-exec') && plain.some(word => base(word) === 'rm') && !insideFolder(start, folder)) return `deletes under ${start}`
      continue
    }
    if (name === 'git') {
      const sub = targets[0]
      if (sub === 'push' && plain.some(word => word === '--force' || word === '-f' || word.startsWith('--force') || word.startsWith('+'))) return 'force-pushes'
      if (sub === 'reset' && plain.includes('--hard')) return 'resets with --hard'
      if (sub === 'clean' && plain.some(word => /^-[a-z]*f/.test(word))) return 'cleans untracked files'
      if (sub === 'branch' && plain.includes('-D')) return 'deletes a branch'
      continue
    }
  }
  return null
}

/** Whether Studio should show you this request (true) or answer it itself (false). */
export function needsApproval(mode: AgentApprovalPolicyMode, action: AgentAction | undefined, folder: string): boolean {
  if (mode === 'auto') return false
  if (!action) return true
  if (mode === 'guarded') {
    if (action.kind === 'command') return dangerousCommand(action.command || '', folder) !== null
    if (action.kind === 'write') return writesOutside(action.paths, folder)
    return false
  }
  if (action.kind === 'read') return false
  if (action.kind === 'write') return !(action.paths || []).length || writesOutside(action.paths, folder)
  return true
}
