import { runHerdr } from './runtime'

/**
 * herdr's remote machines: saved SSH machines whose herdr server shows up in
 * every herdr client (`herdr machine ...`). Studio runs herdr's own commands;
 * adding one prepares herdr on the remote over SSH, so SSH key access from the
 * Studio machine must already work (there is no terminal for a password).
 */
export interface HerdrMachine {
  id: string
  label: string
  target: string
  session: string
  enabled: boolean
  selected: boolean
  /** From `machine status`: reachable, auth required, error or disabled. */
  status?: string
  error?: string
}

const SSH_TARGET = /^(?!-)[A-Za-z0-9._@:[\]-]{1,255}$/
const MACHINE_ID = /^(?!-)[A-Za-z0-9._:-]{1,128}$/
const SESSION = /^[A-Za-z0-9_.-]{1,64}$/

function invalid(message: string): Error {
  return Object.assign(new Error(message), { status: 400 })
}

/** A label is shown in herdr's sidebar: one line, no leading dash. */
function cleanLabel(label: unknown): string {
  const value = String(label ?? '').replace(/[\r\n\t]+/g, ' ').trim()
  if (value.length > 64) throw invalid('Machine name is too long')
  if (value.startsWith('-')) throw invalid('Machine name cannot start with "-"')
  return value
}

export function machineAddArgs(input: { target?: unknown; label?: unknown; session?: unknown }): string[] {
  const target = String(input.target ?? '').trim()
  if (!SSH_TARGET.test(target)) throw invalid('Enter an SSH target like user@host or a Host from your SSH config')
  const label = cleanLabel(input.label)
  const session = String(input.session ?? '').trim()
  if (session && !SESSION.test(session)) throw invalid('Invalid herdr session name')
  return ['machine', 'add', ...(label ? ['--label', label] : []), ...(session ? ['--remote-session', session] : []), target]
}

export function machineId(value: unknown): string {
  const id = String(value ?? '').trim()
  if (!MACHINE_ID.test(id)) throw invalid('Invalid machine id')
  return id
}

function parseRows(text: string): any[] {
  try {
    const rows = JSON.parse(text)
    return Array.isArray(rows) ? rows : []
  } catch { return [] }
}

export async function listHerdrMachines(binary: string, options: { withStatus?: boolean } = {}): Promise<HerdrMachine[]> {
  const machines: HerdrMachine[] = parseRows(await runHerdr(binary, ['machine', 'list', '--json'], 15000)).map(row => ({
    id: String(row.id || ''),
    label: String(row.label || ''),
    target: String(row.target || ''),
    session: String(row.session || ''),
    enabled: row.enabled !== false,
    selected: row.selected === true,
  })).filter(machine => machine.id)
  if (!options.withStatus || !machines.length) return machines
  // Each enabled machine is checked over SSH without prompting.
  const statuses = parseRows(await runHerdr(binary, ['machine', 'status', '--json'], 60000).catch(() => '[]'))
  for (const machine of machines) {
    const row = statuses.find(item => String(item.id) === machine.id)
    if (row) { machine.status = String(row.status || ''); if (row.error) machine.error = String(row.error) }
  }
  return machines
}

export async function addHerdrMachine(binary: string, input: { target?: unknown; label?: unknown; session?: unknown }): Promise<string> {
  const output = await runHerdr(binary, machineAddArgs(input), 180000)
  return output.trim().split('\n')[0] || 'Saved'
}

export async function changeHerdrMachine(binary: string, id: unknown, change: { enabled?: boolean; label?: unknown; remove?: boolean }): Promise<void> {
  const machine = machineId(id)
  if (change.remove) { await runHerdr(binary, ['machine', 'remove', machine], 15000); return }
  if (change.label !== undefined) {
    const label = cleanLabel(change.label)
    if (!label) throw invalid('Enter a machine name')
    await runHerdr(binary, ['machine', 'rename', '--label', label, machine], 15000)
  }
  if (change.enabled !== undefined) await runHerdr(binary, ['machine', change.enabled ? 'enable' : 'disable', machine], 15000)
}
