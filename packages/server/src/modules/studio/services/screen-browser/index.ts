import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BrowserBroker } from '../../../../../../desktop/src/main/browser/browser-broker'
import { getWebUiHome } from '../../public/config'
import { DESKTOP_BROWSER_METHODS } from '../browser/desktop-relay'
import { screenManager } from '../screen'
import type { ScreenManager } from '../screen/manager'
import { ScreenBrowserManager } from './manager'

export { ScreenBrowserManager } from './manager'

export const SCREEN_TAKEN_OVER = 'A person has taken over the screen; wait until they hand it back'
const RECHECK_MS = 5 * 60_000
const MAX_REQUEST_CHARS = 1_000_000
const MAX_UPLOAD_REQUEST_CHARS = 16_000_000

/** The DevTools port of the screen's Chrome; starts an installed screen that is not running. */
export async function screenBrowserPort(screen: ScreenManager = screenManager): Promise<number> {
  const ask = async () => {
    try { return (await screen.browserPort()).port } catch (error) {
      if ((error as { exitCode?: number }).exitCode === 42) throw new Error(SCREEN_TAKEN_OVER)
      throw error
    }
  }
  try { return await ask() } catch (error) {
    if ((error as { exitCode?: number }).exitCode !== 41) throw error
    const status = await screen.hermesStatus()
    if (!status?.installed) throw new Error("The agents' screen is not installed; install it from the Screen view")
    await screen.start()
    return ask()
  }
}

function processAlive(pid: unknown): boolean {
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' }
}

export interface ScreenBrowserServiceOptions {
  brokerRoot?: string
  port?: () => Promise<number>
  /** Whether the agents' screen is installed (the broker only runs where it is). */
  installed?: () => Promise<boolean>
}

/**
 * Studio's Browser Broker for the agents' screen: the same protocol and broker code as
 * the Desktop app, driving the screen's Chrome. It writes `<Studio home>/desktop-browser/
 * broker.json` (where the MCP looks) unless a Desktop app on this machine already
 * publishes its own broker there, and serves MCP requests relayed from other machines.
 */
export class ScreenBrowserService {
  manager: ScreenBrowserManager | null = null
  broker: BrowserBroker | null = null
  private starting: Promise<boolean> | null = null
  private recheck: NodeJS.Timeout | null = null
  private stopped = false
  readonly brokerRoot: string

  constructor(private readonly options: ScreenBrowserServiceOptions = {}) {
    this.brokerRoot = options.brokerRoot || join(getWebUiHome(), 'desktop-browser')
  }

  get running(): boolean {
    return !!this.broker
  }

  private async installed(): Promise<boolean> {
    if (this.options.installed) return this.options.installed()
    const status = await screenManager.hermesStatus().catch(() => null)
    return !!status?.installed
  }

  /** A Desktop app (another process) already publishes a live broker on this machine. */
  private async desktopPublishes(): Promise<boolean> {
    try {
      const descriptor = JSON.parse(await readFile(join(this.brokerRoot, 'broker.json'), 'utf8'))
      return descriptor?.desktopPid !== process.pid && processAlive(descriptor?.desktopPid)
    } catch { return false }
  }

  /** Start when the screen is installed; otherwise check again later. */
  watch(): void {
    this.stopped = false
    void this.start().then(started => {
      if (started || this.stopped || this.recheck) return
      this.recheck = setInterval(() => {
        void this.start().then(ok => {
          if (ok && this.recheck) { clearInterval(this.recheck); this.recheck = null }
        }).catch(() => undefined)
      }, RECHECK_MS)
      this.recheck.unref?.()
    }).catch(error => console.warn('[screen-browser] failed to start:', error instanceof Error ? error.message : error))
  }

  start(): Promise<boolean> {
    if (this.broker) return Promise.resolve(true)
    if (this.starting) return this.starting
    this.starting = (async () => {
      if (!(await this.installed())) return false
      const manager = new ScreenBrowserManager({ port: this.options.port || (() => screenBrowserPort()) })
      const broker = new BrowserBroker(manager, this.brokerRoot, { publishDescriptor: !(await this.desktopPublishes()) })
      await broker.start()
      if (this.stopped) { await broker.stop(); return false }
      this.manager = manager
      this.broker = broker
      return true
    })().finally(() => { this.starting = null })
    return this.starting
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.recheck) { clearInterval(this.recheck); this.recheck = null }
    await this.starting?.catch(() => undefined)
    const broker = this.broker
    const manager = this.manager
    this.broker = null
    this.manager = null
    await broker?.stop()
    await manager?.destroy()
  }

  /** One MCP request relayed through Studio's API; the same envelope a Desktop relay returns. */
  async request(clientKey: string, input: Record<string, unknown>): Promise<{ operation_id: string; result: unknown }> {
    if (typeof input.method !== 'string' || !DESKTOP_BROWSER_METHODS.has(input.method)) throw new Error('Unsupported browser method')
    const limit = input.method === 'upload' ? MAX_UPLOAD_REQUEST_CHARS : MAX_REQUEST_CHARS
    if (JSON.stringify(input).length > limit) throw new Error(`Browser request exceeds ${limit / 1_000_000} MB`)
    if (this.stopped || !(await this.start()) || !this.broker) {
      throw new Error("No authorized active Desktop browser, and the agents' screen is not installed here.")
    }
    return this.broker.localRequest(clientKey, { method: input.method, params: input.params || {}, operation_id: randomUUID() })
  }
}

export const screenBrowser = new ScreenBrowserService()

/** Starts the screen's Browser Broker once the screen is installed. Returns its shutdown step. */
export function startScreenBrowser(): () => Promise<void> {
  screenBrowser.watch()
  return () => screenBrowser.stop()
}
