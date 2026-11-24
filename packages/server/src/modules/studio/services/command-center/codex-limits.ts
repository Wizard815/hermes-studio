import { open, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { getWebUiHome } from '../../public/config'
import { getCodingAgentGlobalHome } from '../../public/coding-agent-global-home'

/**
 * Codex plan limits for the Usage strip (Command Center's usage bars). Codex
 * writes its rate-limit windows into each session's rollout file with every
 * token count; the newest rollout's last report is what the plan has left.
 * Claude Code keeps no such record locally, so Studio shows only its tokens.
 */

export interface PlanWindow { usedPercent: number; windowMinutes: number | null; resetsAt: number | null }
export interface PlanLimits { agent: 'codex'; at: number; primary: PlanWindow | null; secondary: PlanWindow | null }

function window(raw: any, at: number): PlanWindow | null {
  if (!raw || typeof raw !== 'object') return null
  const used = Number(raw.used_percent)
  if (!Number.isFinite(used)) return null
  const minutes = Number(raw.window_minutes)
  const resetsAt = Number.isFinite(Number(raw.resets_at)) && Number(raw.resets_at) > 0
    ? Number(raw.resets_at) * 1000
    : Number.isFinite(Number(raw.resets_in_seconds)) ? at + Number(raw.resets_in_seconds) * 1000 : null
  return { usedPercent: Math.max(0, Math.min(100, used)), windowMinutes: Number.isFinite(minutes) && minutes > 0 ? minutes : null, resetsAt }
}

/** The last rate-limit report in rollout lines (newest last). */
export function parseRolloutLimits(text: string, fallbackAt = Date.now()): PlanLimits | null {
  const lines = String(text || '').split('\n')
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]
    if (!line.includes('"rate_limits"')) continue
    let entry: any
    try { entry = JSON.parse(line) } catch { continue }
    const limits = entry?.payload?.rate_limits ?? entry?.rate_limits ?? entry?.msg?.rate_limits
    if (!limits) continue
    const at = Date.parse(String(entry.timestamp || '')) || fallbackAt
    const primary = window(limits.primary, at)
    const secondary = window(limits.secondary, at)
    if (primary || secondary) return { agent: 'codex', at, primary, secondary }
  }
  return null
}

async function dirs(path: string): Promise<string[]> {
  try { return (await readdir(path, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name) } catch { return [] }
}

/** The newest rollout under one Codex home (sessions/YYYY/MM/DD). */
async function newestRollout(home: string): Promise<{ path: string; mtime: number } | null> {
  const sessions = join(home, 'sessions')
  for (const year of (await dirs(sessions)).sort().reverse().slice(0, 2)) {
    for (const month of (await dirs(join(sessions, year))).sort().reverse()) {
      for (const day of (await dirs(join(sessions, year, month))).sort().reverse()) {
        const folder = join(sessions, year, month, day)
        let best: { path: string; mtime: number } | null = null
        let names: string[] = []
        try { names = (await readdir(folder)).filter(name => name.startsWith('rollout-') && name.endsWith('.jsonl')) } catch { names = [] }
        for (const name of names) {
          try {
            const info = await stat(join(folder, name))
            if (!best || info.mtimeMs > best.mtime) best = { path: join(folder, name), mtime: info.mtimeMs }
          } catch { /* gone */ }
        }
        if (best) return best
      }
    }
  }
  return null
}

async function tail(path: string, bytes = 512 * 1024): Promise<string> {
  const handle = await open(path, 'r')
  try {
    const { size } = await handle.stat()
    const start = Math.max(0, size - bytes)
    const buffer = Buffer.alloc(size - start)
    await handle.read(buffer, 0, buffer.length, start)
    return buffer.toString('utf8')
  } finally { await handle.close() }
}

/** Codex homes Studio knows: the global one and each profile/provider's. */
export async function codexHomes(): Promise<string[]> {
  const homes = [process.env.CODEX_HOME?.trim() || join(getCodingAgentGlobalHome(), '.codex')]
  const model = join(getWebUiHome(), 'coding-agent', 'model')
  for (const profile of await dirs(model)) {
    for (const provider of await dirs(join(model, profile))) homes.push(join(model, profile, provider, 'codex'))
  }
  return [...new Set(homes)]
}

export async function codexPlanLimits(homes?: string[]): Promise<PlanLimits | null> {
  let newest: { path: string; mtime: number } | null = null
  for (const home of homes || await codexHomes()) {
    const found = await newestRollout(home)
    if (found && (!newest || found.mtime > newest.mtime)) newest = found
  }
  if (!newest) return null
  try { return parseRolloutLimits(await tail(newest.path), newest.mtime) } catch { return null }
}
