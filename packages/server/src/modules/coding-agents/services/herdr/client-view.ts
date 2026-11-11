import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * Studio's embedded herdr UI gets its own herdr client preferences, so
 * choices made in Studio's herdr view (like hiding herdr's sidebar) do not
 * change herdr in the user's terminal.
 *
 * herdr names a client's preferences after the socket path it connects
 * through. The embedded client connects through a Studio folder of symlinks to
 * the same herdr sockets (`HERDR_SOCKET_PATH`), which gives it its own
 * preferences file and nothing else: same server, panes, config and plugins.
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

/** The preferences file earlier Studio versions wrote (sidebar hidden). */
const LEGACY_HIDDEN = `${JSON.stringify({ sidebar_collapsed: true })}\n`

export interface ClientViewLaunch {
  /** herdr arguments: no `--session`, the socket override picks the session. */
  args: string[]
  env: Record<string, string>
}

/**
 * Launch settings for the embedded herdr UI. `apiSocket` is the running
 * server's API socket. Returns null where this is not possible (Windows named
 * pipes, unknown socket); the caller then launches herdr as usual.
 */
export function studioClientView(apiSocket: string, options: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; baseDir?: string } = {}): ClientViewLaunch | null {
  const env = options.env ?? process.env
  if ((options.platform ?? process.platform) === 'win32' || !apiSocket.endsWith('.sock')) return null
  const clientSocket = join(dirname(apiSocket), 'herdr-client.sock')
  // Short and stable: Unix socket paths must fit in 108 bytes, and the
  // preferences file is named after this path.
  const dir = join(options.baseDir ?? tmpdir(), `herdr-studio-${createHash('sha1').update(apiSocket).digest('hex').slice(0, 10)}`)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  link(join(dir, 'herdr.sock'), apiSocket)
  link(join(dir, 'herdr-client.sock'), clientSocket)

  // herdr's sidebar is Studio's chat list in herdr mode (every chat is a
  // space), so it starts shown. Earlier Studio versions started it hidden: that
  // untouched first file is undone once; later choices (prefix+b) are herdr's.
  const preferences = join(herdrStateDir(env), 'client-shell', `local-${herdrEndpointHash(join(dir, 'herdr-client.sock'))}.json`)
  let current = ''
  try { current = readFileSync(preferences, 'utf8') } catch { /* first time */ }
  if (!current || current === LEGACY_HIDDEN) {
    mkdirSync(dirname(preferences), { recursive: true })
    writeFileSync(preferences, `${JSON.stringify({ sidebar_collapsed: false })}\n`)
  }
  return { args: [], env: { HERDR_SOCKET_PATH: join(dir, 'herdr.sock') } }
}
