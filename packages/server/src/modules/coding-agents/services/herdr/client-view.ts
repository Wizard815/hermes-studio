import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { herdrConfigPath } from './keybind'

/**
 * Studio's embedded herdr UI gets its own herdr client preferences, so
 * choices made in Studio's herdr view (like hiding herdr's sidebar) do not
 * change herdr in the user's terminal.
 *
 * herdr names a client's preferences after the socket path it connects
 * through. The embedded client connects through a Studio folder of symlinks to
 * the same herdr sockets (`HERDR_SOCKET_PATH`), which gives it its own
 * preferences file and nothing else: same server, panes, config and plugins.
 *
 * Studio's herdr page draws its own Spaces sidebar (space folders), so there
 * herdr's sidebar is hidden: the embedded client starts collapsed and reads a
 * copy of the user's config with `sidebar_collapsed_mode = "hidden"` (herdr's
 * collapsed sidebar is otherwise a narrow rail). With "herdr's own sidebar"
 * picked in Studio, it starts shown and reads the user's config as is.
 */

/** FNV-1a 64, as herdr's `path_for_local_endpoint` hashes a socket path. */
export function herdrEndpointHash(socketPath: string): string {
  let hash = 0xcbf29ce484222325n
  for (const byte of Buffer.from(socketPath, 'utf8')) {
    hash ^= BigInt(byte)
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn
  }
  return hash.toString(16).padStart(16, '0')
}

/** herdr's state directory (`config::state_dir`, release builds). */
export function herdrStateDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.XDG_STATE_HOME) return join(env.XDG_STATE_HOME, 'herdr')
  return join(env.HOME || homedir(), '.local', 'state', 'herdr')
}

function link(path: string, target: string) {
  try {
    if (lstatSync(path).isSymbolicLink() && readlinkSync(path) === target) return
    unlinkSync(path)
  } catch { /* missing */ }
  symlinkSync(target, path)
}

export interface ClientViewLaunch {
  /** herdr arguments: no `--session`, the socket override picks the session. */
  args: string[]
  env: Record<string, string>
}

/** Which sidebar Studio's herdr page shows: Studio's Spaces (default) or herdr's own. */
export type ClientSidebar = 'studio' | 'herdr'

/**
 * The user's herdr config with herdr's sidebar hidden when collapsed (the
 * `[ui]` table's `sidebar_collapsed_mode`), everything else as it was.
 */
export function configWithHiddenSidebar(text: string): string {
  const lines = text.split('\n')
  const out: string[] = []
  let table = ''
  let placed = false
  for (const line of lines) {
    const header = /^\s*\[([^\]]+)\]\s*(#.*)?$/.exec(line)
    if (header) {
      table = header[1].trim()
      out.push(line)
      if (table === 'ui' && !placed) { out.push('sidebar_collapsed_mode = "hidden"'); placed = true }
      continue
    }
    if (table === 'ui' && /^\s*sidebar_collapsed_mode\s*=/.test(line)) continue
    out.push(line)
  }
  if (placed) return out.join('\n')
  // No [ui] table: a top-level key must come before the first table, so add one at the end.
  const body = out.join('\n').replace(/\n*$/, '')
  return `${body}${body ? '\n\n' : ''}[ui]\nsidebar_collapsed_mode = "hidden"\n`
}

/**
 * Launch settings for the embedded herdr UI. `apiSocket` is the running
 * server's API socket. Returns null where this is not possible (Windows named
 * pipes, unknown socket); the caller then launches herdr as usual.
 */
export function studioClientView(apiSocket: string, options: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; baseDir?: string; sidebar?: ClientSidebar } = {}): ClientViewLaunch | null {
  const env = options.env ?? process.env
  if ((options.platform ?? process.platform) === 'win32' || !apiSocket.endsWith('.sock')) return null
  const sidebar: ClientSidebar = options.sidebar === 'herdr' ? 'herdr' : 'studio'
  const clientSocket = join(dirname(apiSocket), 'herdr-client.sock')
  // Short and stable: Unix socket paths must fit in 108 bytes, and the
  // preferences file is named after this path.
  const dir = join(options.baseDir ?? tmpdir(), `herdr-studio-${createHash('sha1').update(apiSocket).digest('hex').slice(0, 10)}`)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  link(join(dir, 'herdr.sock'), apiSocket)
  link(join(dir, 'herdr-client.sock'), clientSocket)

  // The sidebar Studio's page shows decides herdr's: collapsed under Studio's
  // Spaces, shown when herdr's own is picked. Other preferences stay herdr's.
  const preferences = join(herdrStateDir(env), 'client-shell', `local-${herdrEndpointHash(join(dir, 'herdr-client.sock'))}.json`)
  let current: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(readFileSync(preferences, 'utf8')) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) current = parsed as Record<string, unknown>
  } catch { /* first time */ }
  const collapsed = sidebar === 'studio'
  if (current.sidebar_collapsed !== collapsed) {
    mkdirSync(dirname(preferences), { recursive: true })
    writeFileSync(preferences, `${JSON.stringify({ ...current, sidebar_collapsed: collapsed }, null, 2)}\n`)
  }
  const launchEnv: Record<string, string> = { HERDR_SOCKET_PATH: join(dir, 'herdr.sock') }
  if (sidebar === 'studio') {
    let config = ''
    try { config = readFileSync(herdrConfigPath(env), 'utf8') } catch { /* no config yet: herdr's defaults */ }
    const copy = join(dir, 'config.toml')
    writeFileSync(copy, configWithHiddenSidebar(config))
    launchEnv.HERDR_CONFIG_PATH = copy
  }
  return { args: [], env: launchEnv }
}
