import { dirname, join } from 'node:path'
import { HerdrBridge, type HerdrBridgeDeps, type HerdrBridgeState } from './bridge'
import { findPluginScript, installHerdrPlugin, pluginTokenMatches, readOrCreatePluginToken, type PluginInstallResult } from './plugin'
import { installHerdrRelease } from './install'
import { installStudioKeybinding, readHerdrKeys, readHerdrView, type HerdrKeys, type HerdrView, type KeybindResult } from './keybind'
import { herdrKindForStudioAgent } from './protocol'
import { SpaceFolderStore } from './folders'
import { homedir } from 'node:os'
import {
  DEFAULT_HERDR_SETTINGS,
  HerdrSettingsStore,
  herdrArgs,
  locateHerdrBinary,
  readHerdrServerStatus,
  runHerdr,
  sanitizeHerdrSettings,
  startHerdrServer,
  type HerdrServerStatus,
  type HerdrSettings,
} from './runtime'

/** What the herdr plugin (running inside herdr) may ask Studio for. */
export interface HerdrPluginDeps {
  listChats(limit: number): Array<{ id: string; title: string; agent: string; updatedAt: number }>
  listAgents(): Promise<Array<{ id: string; name: string }>>
  listProviders(profile: string): Promise<Array<{ provider: string; label: string; models: string[] }>>
  /** Studio profiles a herdr chat can belong to. */
  listProfiles(): string[]
  /** Loopback URL the plugin uses for API calls. */
  studioUrl(): string
  /** URL a person opens in a browser. */
  browserUrl(): string
  nodePath: string
  scriptCandidates: string[]
}

export interface HerdrSetupResult {
  version: string
  integrations: Array<{ kind: string; ok: boolean; message: string }>
  plugin: PluginInstallResult | { error: string }
  keybinding: KeybindResult | { error: string }
}

export interface HerdrStatus {
  settings: HerdrSettings
  installed: boolean
  binary: string
  version: string
  server: HerdrServerStatus | null
  error: string
  bridge: HerdrBridgeState | null
  /** Home folder on the herdr machine, for `~` in folder rules. */
  home: string
  /** herdr keys for Studio's herdr buttons (search, workspaces, settings, help). */
  keys: HerdrKeys
  /** herdr layout facts for Studio's embedded view. */
  view: HerdrView
  /** Where browsers reach Studio: HERMES_WEB_UI_PUBLIC_URL, else the last browser address (a public https one first). */
  publicUrl: string
}

/** Herdr agent kinds with a session-reporting integration. */
export const HERDR_INTEGRATIONS = ['claude', 'codex', 'pi', 'grok', 'opencode', 'copilot', 'cursor', 'antigravity-cli', 'kimi', 'qwen', 'qodercli', 'hermes'] as const

/**
 * Process-wide owner of herdr settings and the live bridge. Bootstrap injects
 * Studio dependencies with `configure`; routes only talk to this object.
 */
export class HerdrManager {
  private deps: HerdrBridgeDeps | null = null
  private store: HerdrSettingsStore | null = null
  private stateFile = ''
  private settings: HerdrSettings = { ...DEFAULT_HERDR_SETTINGS }
  private bridge: HerdrBridge | null = null
  private listeners = new Set<(state: HerdrBridgeState | null) => void>()
  private serverStartAttempted = false
  private pluginDeps: HerdrPluginDeps | null = null
  private settingsDir = ''
  private pluginToken = ''
  private setupRunning: Promise<HerdrSetupResult> | null = null
  private serverError = ''

  configure(deps: HerdrBridgeDeps, paths: { settingsFile: string; stateFile: string }, pluginDeps?: HerdrPluginDeps): void {
    this.deps = deps
    this.store = new HerdrSettingsStore(paths.settingsFile)
    this.stateFile = paths.stateFile
    this.settingsDir = dirname(paths.settingsFile)
    this.pluginDeps = pluginDeps ?? null
  }

  private folderStore: SpaceFolderStore | null = null

  folders(): SpaceFolderStore {
    if (!this.folderStore) this.folderStore = new SpaceFolderStore(join(this.settingsDir, 'space-folders.json'))
    return this.folderStore
  }

  getPluginDeps(): HerdrPluginDeps {
    if (!this.pluginDeps) throw Object.assign(new Error('herdr plugin support is not configured'), { status: 503 })
    return this.pluginDeps
  }

  private async token(): Promise<string> {
    if (!this.pluginToken) {
      const { mkdir } = await import('node:fs/promises')
      await mkdir(this.settingsDir, { recursive: true })
      this.pluginToken = await readOrCreatePluginToken(join(this.settingsDir, 'plugin-token'))
    }
    return this.pluginToken
  }

  /** Constant-time check of the token Studio handed to its herdr plugin. */
  async verifyPluginToken(provided: string): Promise<boolean> {
    if (!this.settings.enabled || !this.settingsDir) return false
    return pluginTokenMatches(await this.token(), provided)
  }

  async installPlugin(): Promise<PluginInstallResult> {
    const deps = this.getPluginDeps()
    const binary = this.requireBinary()
    const scriptPath = findPluginScript(deps.scriptCandidates)
    if (!scriptPath) throw Object.assign(new Error('Studio plugin script for herdr was not found'), { status: 500 })
    return installHerdrPlugin({
      binary,
      settings: this.settings,
      pluginDir: join(this.settingsDir, 'plugin'),
      nodePath: deps.nodePath,
      scriptPath,
      studioUrl: deps.studioUrl(),
      browserUrl: deps.browserUrl(),
      token: await this.token(),
    })
  }

  /** Folder for the copy of herdr Studio installs itself. */
  managedBinDir(): string {
    return join(this.settingsDir, 'bin')
  }

  async init(): Promise<void> {
    if (!this.store) return
    const firstRun = !this.store.exists()
    this.settings = await this.store.load()
    // First start with herdr present: turn the integration on without asking.
    if (firstRun && this.binary()) {
      this.settings = { ...this.settings, enabled: true }
      await this.store.save(this.settings)
    }
    if (this.settings.enabled) {
      await this.startBridge()
      void this.ensureSetup()
    }
  }

  /** Run the one-time setup once per herdr version, in the background. */
  private async ensureSetup(): Promise<void> {
    try {
      const binary = this.binary()
      if (!binary) return
      const version = (await readHerdrServerStatus(binary, this.settings)).version || 'unknown'
      if (this.settings.setupVersion === version) return
      await this.setup()
    } catch {
      /* setup reports its own failures through status; startup must not fail */
    }
  }

  /**
   * Everything that makes herdr and Studio work together: start herdr, install
   * session-reporting integrations for agents Studio has, link the Studio
   * plugin and bind a free key to the Studio chat picker.
   */
  setup(): Promise<HerdrSetupResult> {
    if (this.setupRunning) return this.setupRunning
    this.setupRunning = (async () => {
      const binary = this.requireBinary()
      if (!this.settings.enabled) await this.updateSettings({ enabled: true })
      const version = (await readHerdrServerStatus(binary, this.settings)).version
      let kinds: string[] = []
      try {
        const agents = await this.getPluginDeps().listAgents()
        const integration = (agentId: string) => {
          const kind = herdrKindForStudioAgent(agentId)
          return kind === 'agy' ? 'antigravity-cli' : kind
        }
        kinds = agents.map(agent => integration(agent.id)).filter((kind): kind is string => !!kind && (HERDR_INTEGRATIONS as readonly string[]).includes(kind))
      } catch { kinds = [] }
      const integrations = kinds.length ? await this.installIntegrations([...new Set(kinds)]) : []
      const plugin = await this.installPlugin().catch(error => ({ error: error instanceof Error ? error.message : String(error) }))
      const keybinding = await installStudioKeybinding(binary, this.settings).catch(error => ({ error: error instanceof Error ? error.message : String(error) }))
      await this.updateSettings({ setupVersion: version || 'unknown' })
      return { version, integrations, plugin, keybinding }
    })()
    return this.setupRunning.finally(() => { this.setupRunning = null })
  }

  /** Download herdr (checksum-verified) into Studio's folder, then set everything up. */
  async installHerdr(options: { manifestUrl?: string } = {}): Promise<HerdrSetupResult & { binary: string }> {
    const installed = await installHerdrRelease({
      installDir: this.managedBinDir(),
      manifestUrl: options.manifestUrl || process.env.HERDR_MANIFEST_URL,
    })
    // Restart the bridge on the new binary.
    await this.updateSettings({ binaryPath: installed.binary, enabled: true })
    const result = await this.setup()
    return { ...result, binary: installed.binary }
  }

  shutdown(): void {
    this.bridge?.stop()
    this.bridge = null
  }

  getSettings(): HerdrSettings { return { ...this.settings } }

  getBridge(): HerdrBridge | null { return this.bridge }

  requireBridge(): HerdrBridge {
    if (!this.settings.enabled) throw Object.assign(new Error('herdr integration is turned off'), { status: 409 })
    if (!this.bridge) throw Object.assign(new Error('herdr is not connected'), { status: 503 })
    return this.bridge
  }

  onState(listener: (state: HerdrBridgeState | null) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit() {
    const state = this.bridge?.getState() ?? null
    for (const listener of this.listeners) {
      try { listener(state) } catch { /* ignore */ }
    }
  }

  binary(): string | null {
    return locateHerdrBinary(this.settings, process.env, this.settingsDir ? this.managedBinDir() : '')
  }

  requireBinary(): string {
    const binary = this.binary()
    if (!binary) throw Object.assign(new Error('herdr is not installed. Install it from https://herdr.dev or set its path in settings.'), { status: 404 })
    return binary
  }

  async updateSettings(input: Partial<HerdrSettings>): Promise<HerdrSettings> {
    if (!this.store) throw new Error('herdr manager is not configured')
    const previous = this.settings
    const next = sanitizeHerdrSettings(input, previous)
    await this.store.save(next)
    this.settings = next
    const restart = next.enabled !== previous.enabled || next.session !== previous.session || next.binaryPath !== previous.binaryPath
    if (restart) {
      this.bridge?.stop()
      this.bridge = null
      this.serverStartAttempted = false
      if (next.enabled) {
        await this.startBridge()
        if (!previous.enabled) void this.ensureSetup()
      } else this.emit()
    } else {
      this.bridge?.updateSettings(next)
      if (next.autoImport && !previous.autoImport) this.bridge?.scheduleRefresh(0)
    }
    return { ...next }
  }

  private async resolveSocket(): Promise<string> {
    const binary = this.requireBinary()
    let server = await readHerdrServerStatus(binary, this.settings)
    if (!server.running && !this.serverStartAttempted && this.settings.autoStart) {
      // First connect after enabling: bring up a headless server so panes survive Studio.
      this.serverStartAttempted = true
      this.serverError = ''
      startHerdrServer(binary, this.settings, message => { this.serverError = message })
      for (let attempt = 0; attempt < 20 && !server.running && !this.serverError; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 250))
        server = await readHerdrServerStatus(binary, this.settings)
      }
    }
    if (!server.running || !server.socket) throw new Error(this.serverError ? `herdr server could not start: ${this.serverError}` : 'herdr server is not running')
    return server.socket
  }

  private async startBridge() {
    if (!this.deps || this.bridge) return
    const bridge = new HerdrBridge(this.settings, this.deps, this.stateFile, () => this.resolveSocket())
    this.bridge = bridge
    bridge.onChange(() => this.emit())
    await bridge.start()
  }

  async status(): Promise<HerdrStatus> {
    const binary = this.binary()
    let server: HerdrServerStatus | null = null
    let error = ''
    if (binary) {
      try { server = await readHerdrServerStatus(binary, this.settings) } catch (err) {
        error = err instanceof Error ? err.message : String(err)
      }
    }
    return {
      settings: this.getSettings(),
      installed: !!binary,
      binary: binary || '',
      version: server?.version || '',
      server,
      error: error || this.bridge?.getState().error || this.serverError || '',
      bridge: this.bridge?.getState() ?? null,
      home: homedir(),
      keys: await readHerdrKeys(),
      view: await readHerdrView(),
      publicUrl: this.publicUrl(),
    }
  }

  private user: { id: number; username: string; role: string } | null = null

  /** The Studio admin using herdr; agents in herdr act for them. */
  noteUser(user: unknown): void {
    const value = user as { id?: unknown; username?: unknown; role?: unknown } | null
    if (value && typeof value.id === 'number' && typeof value.username === 'string' && typeof value.role === 'string') {
      this.user = { id: value.id, username: value.username, role: value.role }
    }
  }

  actingUser(): { id: number; username: string; role: string } | null {
    return this.user
  }

  private browserOrigins = { public: '', any: '' }

  noteBrowserOrigin(origin: string): void {
    if (!origin) return
    this.browserOrigins.any = origin
    const host = new URL(origin).hostname
    const local = host === 'localhost' || /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) || host.startsWith('[') || !host.includes('.')
    if (origin.startsWith('https://') && !local) this.browserOrigins.public = origin
  }

  publicUrl(): string {
    return (process.env.HERMES_WEB_UI_PUBLIC_URL || '').replace(/\/+$/, '') || this.browserOrigins.public || this.browserOrigins.any
  }

  async startServer(): Promise<HerdrStatus> {
    const binary = this.requireBinary()
    const current = await readHerdrServerStatus(binary, this.settings)
    if (!current.running) {
      this.serverError = ''
      startHerdrServer(binary, this.settings, message => { this.serverError = message })
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 250))
        if ((await readHerdrServerStatus(binary, this.settings)).running) break
      }
    }
    this.bridge?.scheduleRefresh(0)
    if (this.bridge && !this.bridge.getState().connected) {
      this.bridge.stop(); this.bridge = null
      await this.startBridge()
    }
    return this.status()
  }

  /** Install herdr's session-reporting integrations so agent sessions link to chats. */
  async installIntegrations(kinds: string[]): Promise<Array<{ kind: string; ok: boolean; message: string }>> {
    const binary = this.requireBinary()
    const allowed = new Set<string>(HERDR_INTEGRATIONS)
    const results = []
    for (const kind of kinds) {
      if (!allowed.has(kind)) {
        results.push({ kind, ok: false, message: 'Unsupported integration' })
        continue
      }
      try {
        const output = await runHerdr(binary, herdrArgs(this.settings, ['integration', 'install', kind]), 30000)
        results.push({ kind, ok: true, message: output.trim().split('\n').pop() || 'installed' })
      } catch (error) {
        results.push({ kind, ok: false, message: error instanceof Error ? error.message : String(error) })
      }
    }
    return results
  }
}

export const herdrManager = new HerdrManager()
