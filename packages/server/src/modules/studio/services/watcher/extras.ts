import { accessSync, constants } from 'node:fs'
import { createConnection } from 'node:net'
import { delimiter, join } from 'node:path'
import type { WatcherExtraStatus, WatcherSettings } from '../../../../../../shared/watcher'

/**
 * The watcher's optional extras (docs/watcher.md), each off by default. They
 * only report what they find; a missing extra never stops a chat.
 *
 * - pipelock: clean-room traffic goes out through a pipelock proxy, which can
 *   refuse a connection that would leak a secret (the clean room's proxy
 *   chains to it; see cleanroom/index.ts `openUpstream`).
 * - innerwarden: the Community guard's Hermes hook (`innerwarden agents connect
 *   hermes`); Studio checks that the hook is in Hermes's config.yaml and alerts
 *   when it is on here but missing.
 * - langfuse: alerts for Hermes chats link to the chat's Langfuse session when
 *   the official langfuse plugin has keys in the profile's .env.
 */
export interface ExtrasDeps {
  /** Hermes's config.yaml for the active profile, as text ('' when none). */
  hermesConfigText: () => string
  /** The active profile's .env. */
  profileEnv: () => Record<string, string>
  /** Whether something answers at host:port. */
  reachable?: (url: string) => Promise<boolean>
  /** A program on PATH. */
  findProgram?: (name: string) => string
  fetchJson?: (url: string, headers: Record<string, string>) => Promise<any>
}

export function findOnPath(name: string, path = String(process.env.PATH || '')): string {
  for (const dir of path.split(delimiter).filter(Boolean)) {
    const candidate = join(dir, name)
    try { accessSync(candidate, constants.X_OK); return candidate } catch { /* next */ }
  }
  return ''
}

export function tcpReachable(url: string, timeoutMs = 1500): Promise<boolean> {
  let host = ''
  let port = 0
  try { const parsed = new URL(url); host = parsed.hostname.replace(/^\[|\]$/g, ''); port = Number(parsed.port) || (parsed.protocol === 'https:' ? 443 : 80) } catch { return Promise.resolve(false) }
  return new Promise(resolve => {
    const socket = createConnection({ host, port })
    const done = (ok: boolean) => { socket.destroy(); resolve(ok) }
    socket.setTimeout(timeoutMs, () => done(false))
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}

/** The Langfuse keys and server the official plugin reads (HERMES_LANGFUSE_* first, then LANGFUSE_*). */
export function langfuseConfig(env: Record<string, string>): { publicKey: string; secretKey: string; baseUrl: string } | null {
  const pick = (name: string) => String(env[`HERMES_LANGFUSE_${name}`] || env[`LANGFUSE_${name}`] || '').trim()
  const publicKey = pick('PUBLIC_KEY')
  const secretKey = pick('SECRET_KEY')
  if (!publicKey || !secretKey) return null
  return { publicKey, secretKey, baseUrl: (pick('BASE_URL') || pick('HOST') || 'https://cloud.langfuse.com').replace(/\/+$/, '') }
}

/** Whether Hermes's config.yaml has InnerWarden's pre_tool_call hook. */
export function innerwardenHooked(configText: string): boolean {
  return /pre_tool_call/.test(configText) && /innerwarden/i.test(configText)
}

export class WatcherExtras {
  private projects = new Map<string, { id: string; at: number }>()
  private pending = new Set<string>()

  constructor(private readonly deps: ExtrasDeps) {}

  private findProgram(name: string) { return (this.deps.findProgram || findOnPath)(name) }

  async status(settings: WatcherSettings): Promise<WatcherExtraStatus[]> {
    const { pipelock, innerwarden, langfuse } = settings.extras
    const pipelockUp = await (this.deps.reachable || tcpReachable)(pipelock.proxyUrl).catch(() => false)
    const program = this.findProgram('innerwarden')
    const hooked = innerwardenHooked(safe(this.deps.hermesConfigText))
    const keys = langfuseConfig(safeEnv(this.deps.profileEnv))
    return [
      {
        id: 'pipelock', enabled: pipelock.enabled, available: pipelockUp,
        detail: pipelockUp
          ? `pipelock answers at ${pipelock.proxyUrl}.${pipelock.enabled ? ' Clean-room traffic goes out through it; a connection it refuses is blocked and shows here.' : ' Turn this on to send clean-room traffic through it.'}`
          : `Not available here: nothing answers at ${pipelock.proxyUrl}. Start pipelock as an HTTP proxy there (pipelock run, see docs/watcher.md).${pipelock.enabled ? ' Until it answers, clean rooms go out without it and the bell says so.' : ''}`,
      },
      {
        id: 'innerwarden', enabled: innerwarden.enabled, available: !!program,
        detail: !program
          ? 'Not available here: the innerwarden program is not installed on this host. Install the Community guard, run "innerwarden agents connect hermes", then turn this on.'
          : hooked
            ? `Installed (${program}); its hook is in Hermes's config.yaml, so Hermes checks each tool call with it.`
            : `Installed (${program}), but Hermes's config.yaml has no innerwarden hook. Run "innerwarden agents connect hermes".${innerwarden.enabled ? ' The bell says so until it is connected.' : ''}`,
      },
      {
        id: 'langfuse', enabled: langfuse.enabled, available: !!keys,
        detail: keys
          ? `Keys found for ${keys.baseUrl}.${langfuse.enabled ? ' Alerts for Hermes chats link to the chat\'s Langfuse session.' : ' Turn this on to link alerts to Langfuse.'}`
          : 'Not available here: the profile has no HERMES_LANGFUSE_PUBLIC_KEY and HERMES_LANGFUSE_SECRET_KEY. Install the langfuse plugin and add its keys under Channels or the profile .env.',
      },
    ]
  }

  /** Whether InnerWarden is switched on here but its hook is missing (the bell says so). */
  innerwardenMissing(settings: WatcherSettings): boolean {
    return settings.extras.innerwarden.enabled && !innerwardenHooked(safe(this.deps.hermesConfigText))
  }

  /**
   * The chat's Langfuse session page, or '' (not on, no keys, project not
   * known yet). The project id is looked up once in the background.
   */
  traceLink(settings: WatcherSettings, sessionId: string): string {
    if (!settings.extras.langfuse.enabled || !sessionId) return ''
    const keys = langfuseConfig(safeEnv(this.deps.profileEnv))
    if (!keys) return ''
    const key = `${keys.baseUrl}|${keys.publicKey}`
    const project = this.projects.get(key)
    if (!project || Date.now() - project.at > 6 * 3600_000) void this.lookupProject(key, keys)
    return project?.id ? `${keys.baseUrl}/project/${encodeURIComponent(project.id)}/sessions/${encodeURIComponent(sessionId)}` : ''
  }

  async lookupProject(key: string, keys: { publicKey: string; secretKey: string; baseUrl: string }): Promise<string> {
    if (this.pending.has(key)) return ''
    this.pending.add(key)
    try {
      const fetchJson = this.deps.fetchJson || defaultFetchJson
      const body = await fetchJson(`${keys.baseUrl}/api/public/projects`, { authorization: `Basic ${Buffer.from(`${keys.publicKey}:${keys.secretKey}`).toString('base64')}` })
      const id = String(body?.data?.[0]?.id || '')
      this.projects.set(key, { id, at: Date.now() })
      return id
    } catch {
      this.projects.set(key, { id: '', at: Date.now() })
      return ''
    } finally {
      this.pending.delete(key)
    }
  }
}

function safe(read: () => string): string { try { return read() || '' } catch { return '' } }
function safeEnv(read: () => Record<string, string>): Record<string, string> { try { return read() || {} } catch { return {} } }

async function defaultFetchJson(url: string, headers: Record<string, string>): Promise<any> {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(5000) })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.json()
}
