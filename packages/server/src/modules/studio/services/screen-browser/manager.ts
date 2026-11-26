import { BrowserAutomation } from '../../../../../../desktop/src/main/browser/browser-automation'
import { BROWSER_BATCH_TIMEOUT_MS, parseBrowserBatchActions } from '../../../../../../desktop/src/main/browser/browser-batch'
import type { BrowserBrokerManager } from '../../../../../../desktop/src/main/browser/browser-broker'
import {
  BrowserDownloadStore,
  MAX_BROWSER_DOWNLOAD_BYTES,
  fileNameFromResponse,
  readLimitedBody,
  type BrowserDownloadChunk,
  type BrowserDownloadInfo,
  type BrowserUploadFile,
  type BrowserUploadMethod,
  type BrowserUploadResult,
} from '../../../../../../desktop/src/main/browser/browser-files'
import { observeBrowserState, type BrowserObservedState, type BrowserObservedTarget } from '../../../../../../desktop/src/main/browser/browser-observation'
import {
  MAX_BROWSER_TABS,
  type BrowserAgentControl,
  type BrowserBatchAction,
  type BrowserBatchResult,
  type BrowserConsoleEntry,
  type BrowserInteractAction,
  type BrowserInteractionResult,
  type BrowserNetworkEntry,
  type BrowserPageDialog,
  type BrowserReadTextOptions,
  type BrowserSnapshotOptions,
  type BrowserWaitOptions,
  type BrowserWaitResult,
  type DesktopBrowserState,
  type DesktopBrowserTab,
} from '../../../../../../desktop/src/main/browser/browser-types'
import { isAllowedBrowserRequest, normalizeBrowserUrl, publicBrowserUrl, redactBrowserText } from '../../../../../../desktop/src/main/browser/browser-url'
import { CdpConnection, CdpContents, type CdpTargetInfo } from './cdp-contents'

/**
 * The agents' screen Chrome as a Browser Broker manager: the Desktop app's
 * BrowserManager automation glue (interact / observe / batch / upload / wait /
 * download / screenshot) with Electron tabs replaced by the page targets of a
 * real Chrome reached over one DevTools connection. Tab ids are CDP target ids,
 * and tabs a person opens on the screen are tabs here too.
 */

interface TabRecord {
  tab: DesktopBrowserTab
  contents: CdpContents
  console: BrowserConsoleEntry[]
  documentGeneration: number
  openerTabId?: string
  /** Opened through createTab (an agent's tab, which may be recycled at the tab limit). */
  agentOpened?: boolean
  loadWaiters: Set<() => void>
}

export interface ScreenBrowserManagerOptions {
  /** DevTools port of the Chrome to drive. Throws with a person-readable reason when unavailable. */
  port: () => Promise<number>
  host?: string
  /** How long a resolved port is trusted before asking again (the check also notices a person's takeover). */
  portCacheMs?: number
}

/** Main frame id per tab (a page target's main frame id is normally its target id). */
const mainFrames = new WeakMap<TabRecord, string>()

const CONSOLE_LIMIT = 500
const NAVIGATION_TIMEOUT_MS = 30_000
const SCREEN_PROFILE_ID = 'screen'

const PAGE_FETCH_FUNCTION = `async function (url, limit) {
  const response = await fetch(url, { credentials: 'include' });
  if (!response.ok) throw new Error('Download failed with HTTP ' + response.status);
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > limit) throw new Error('Download exceeds the size limit');
  const blob = await response.blob();
  if (blob.size > limit) throw new Error('Download exceeds the size limit');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return { data: btoa(binary), type: blob.type || response.headers.get('content-type') || '', url: response.url || url,
    contentDisposition: response.headers.get('content-disposition') || '' };
}`

function copyTab(tab: DesktopBrowserTab): DesktopBrowserTab {
  return { ...tab }
}

function consoleLevel(type: string): number {
  if (type === 'debug') return 0
  if (type === 'warning') return 2
  if (type === 'error' || type === 'assert') return 3
  return 1
}

function remoteValue(value: any): string {
  if (!value) return ''
  if ('value' in value) return typeof value.value === 'string' ? value.value : JSON.stringify(value.value)
  return String(value.unserializableValue ?? value.description ?? value.type ?? '')
}

export class ScreenBrowserManager implements BrowserBrokerManager {
  readonly automation = new BrowserAutomation()
  private readonly records = new Map<string, TabRecord>()
  private readonly agentDownloads = new BrowserDownloadStore()
  private connection: CdpConnection | null = null
  private connecting: Promise<CdpConnection> | null = null
  private portCheckedAt = 0
  private activeTabId: string | undefined
  private tabMutationQueue: Promise<void> = Promise.resolve()

  constructor(private readonly options: ScreenBrowserManagerOptions) {}

  /** Connect (or reconnect) to the screen's Chrome before an operation. */
  async beforeOperation(_method?: string): Promise<void> {
    await this.connect()
  }

  get connected(): boolean {
    return !!this.connection?.isOpen
  }

  async connect(): Promise<CdpConnection> {
    const cacheMs = this.options.portCacheMs ?? 2_000
    if (this.connection?.isOpen && Date.now() - this.portCheckedAt < cacheMs) return this.connection
    if (this.connecting) return this.connecting
    const connecting = (async () => {
      const port = await this.options.port()
      this.portCheckedAt = Date.now()
      if (this.connection?.isOpen && this.connection.port === port) return this.connection
      this.disconnect()
      const connection = await CdpConnection.connect(port, this.options.host)
      this.connection = connection
      connection.on('event', (method: string, params: any) => this.handleBrowserEvent(connection, method, params))
      connection.on('disconnected', () => {
        if (this.connection !== connection) return
        this.connection = null
        this.dropAllTabs()
      })
      await connection.send('Target.setDiscoverTargets', { discover: true })
      const { targetInfos } = await connection.send<{ targetInfos: CdpTargetInfo[] }>('Target.getTargets')
      for (const info of targetInfos || []) this.addTarget(connection, info, false)
      await Promise.all([...this.records.values()].map(record => record.contents.attach().catch(() => undefined)))
      if (!this.activeTabId || !this.records.has(this.activeTabId)) this.activeTabId = [...this.records.keys()][0]
      return connection
    })()
    this.connecting = connecting
    try { return await connecting } finally { this.connecting = null }
  }

  disconnect(): void {
    const connection = this.connection
    this.connection = null
    if (connection) connection.close()
    this.dropAllTabs()
  }

  private dropAllTabs(): void {
    for (const [tabId, record] of this.records) {
      record.contents.markDestroyed()
      this.automation.invalidate(tabId)
      for (const waiter of record.loadWaiters) waiter()
    }
    this.records.clear()
    this.activeTabId = undefined
  }

  // ── Tabs ────────────────────────────────────────────────────────────

  state(): DesktopBrowserState {
    return {
      available: this.connected,
      activeProfileId: SCREEN_PROFILE_ID,
      activeTabId: this.activeTabId,
      tabs: [...this.records.values()].map(record => copyTab(record.tab)),
      profiles: [],
      downloads: [],
      permissions: [],
      visible: true,
      maxTabs: MAX_BROWSER_TABS,
    }
  }

  private isTab(info: CdpTargetInfo): boolean {
    return info.type === 'page' && !/^(?:devtools|chrome-extension):/i.test(info.url || '')
  }

  private addTarget(connection: CdpConnection, info: CdpTargetInfo, created: boolean): TabRecord | undefined {
    if (!this.isTab(info)) return undefined
    const existing = this.records.get(info.targetId)
    if (existing) return existing
    const contents = new CdpContents(connection, info.targetId, info)
    const tab: DesktopBrowserTab = {
      id: info.targetId,
      profileId: SCREEN_PROFILE_ID,
      title: info.title || info.url || 'New Tab',
      url: info.url || 'about:blank',
      loading: false,
      canGoBack: false,
      canGoForward: false,
      crashed: false,
      agentControl: 'idle',
    }
    const record: TabRecord = { tab, contents, console: [], documentGeneration: 0, loadWaiters: new Set() }
    if (info.openerId && this.records.has(info.openerId)) record.openerTabId = info.openerId
    this.records.set(info.targetId, record)
    contents.onAttached = async sessionId => {
      await Promise.all([
        contents.sendTo(sessionId, 'Page.enable'),
        contents.sendTo(sessionId, 'Runtime.enable'),
      ].map(command => command.catch(() => undefined)))
      this.refreshHistory(record)
    }
    contents.debugger.on('message', (_event: unknown, method: string, params: any, sessionId?: string) => {
      if (!sessionId) this.handleTabEvent(record, method, params)
    })
    contents.debugger.on('detach', () => {
      this.invalidateDocument(record)
      if (!contents.isDestroyed() && this.records.get(tab.id) === record) {
        tab.agentControl = 'idle'
        tab.agentLabel = undefined
        tab.agentAction = undefined
      }
    })
    // Chrome focuses tabs it opens (window.open, a person's new tab).
    if (created) this.activeTabId = info.targetId
    return record
  }

  private handleBrowserEvent(connection: CdpConnection, method: string, params: any): void {
    if (this.connection !== connection) return
    switch (method) {
      case 'Target.targetCreated': {
        const record = this.addTarget(connection, params.targetInfo, true)
        if (record) void record.contents.attach().catch(() => undefined)
        return
      }
      case 'Target.targetInfoChanged': {
        const info = params.targetInfo as CdpTargetInfo
        const record = this.records.get(info.targetId)
        if (!record) return
        record.contents.url = info.url
        record.contents.title = info.title
        record.tab.url = info.url || 'about:blank'
        record.tab.title = info.title || record.tab.url
        return
      }
      case 'Target.targetDestroyed':
        this.removeRecord(params.targetId)
        return
      case 'Target.targetCrashed': {
        const record = this.records.get(params.targetId)
        if (!record) return
        record.tab.crashed = true
        record.tab.loading = false
        record.contents.loading = false
        this.invalidateDocument(record)
        return
      }
    }
  }

  private handleTabEvent(record: TabRecord, method: string, params: any): void {
    switch (method) {
      case 'Page.frameStartedLoading':
        if (!this.isMainFrame(record, params.frameId)) return
        record.tab.loading = true
        record.contents.loading = true
        return
      case 'Page.frameStoppedLoading':
        if (!this.isMainFrame(record, params.frameId)) return
        record.tab.loading = false
        record.contents.loading = false
        this.refreshHistory(record)
        this.releaseLoadWaiters(record)
        return
      case 'Page.loadEventFired':
        this.releaseLoadWaiters(record)
        return
      case 'Page.frameNavigated':
        if (params.frame?.parentId) return
        mainFrames.set(record, params.frame?.id)
        if (params.frame?.url) {
          record.contents.url = params.frame.url + (params.frame.urlFragment || '')
          record.tab.url = record.contents.url
        }
        record.tab.crashed = false
        this.invalidateDocument(record)
        this.refreshHistory(record)
        return
      case 'Page.navigatedWithinDocument':
        if (!this.isMainFrame(record, params.frameId)) return
        if (params.url) { record.contents.url = params.url; record.tab.url = params.url }
        this.automation.invalidate(record.tab.id)
        this.refreshHistory(record)
        return
      case 'Runtime.consoleAPICalled': {
        const frame = params.stackTrace?.callFrames?.[0]
        this.pushConsole(record, {
          level: consoleLevel(String(params.type || 'log')),
          message: (params.args || []).map(remoteValue).join(' '),
          line: typeof frame?.lineNumber === 'number' ? frame.lineNumber + 1 : 0,
          sourceId: String(frame?.url || ''),
          timestamp: new Date().toISOString(),
        })
        return
      }
      case 'Runtime.exceptionThrown': {
        const details = params.exceptionDetails || {}
        this.pushConsole(record, {
          level: 3,
          message: String(details.exception?.description || details.text || 'Uncaught exception'),
          line: typeof details.lineNumber === 'number' ? details.lineNumber + 1 : 0,
          sourceId: String(details.url || ''),
          timestamp: new Date().toISOString(),
        })
        return
      }
    }
  }

  private isMainFrame(record: TabRecord, frameId: unknown): boolean {
    const main = mainFrames.get(record)
    // Before the first navigation is seen, a page target's main frame id is its target id.
    return frameId === (main || record.tab.id)
  }

  private pushConsole(record: TabRecord, entry: BrowserConsoleEntry): void {
    record.console.push(entry)
    if (record.console.length > CONSOLE_LIMIT) record.console.splice(0, record.console.length - CONSOLE_LIMIT)
  }

  private invalidateDocument(record: TabRecord): void {
    record.documentGeneration += 1
    this.automation.invalidate(record.tab.id)
  }

  private releaseLoadWaiters(record: TabRecord): void {
    for (const waiter of [...record.loadWaiters]) waiter()
  }

  private refreshHistory(record: TabRecord): void {
    void this.refreshTab(record)
  }

  /** Back/forward availability and the current URL and title, as the Desktop manager's refreshTab. */
  private async refreshTab(record: TabRecord): Promise<void> {
    const contents = record.contents
    if (contents.isDestroyed()) return
    await Promise.all([
      contents.send<{ currentIndex: number; entries: Array<{ id: number }> }>('Page.getNavigationHistory').then(history => {
        record.tab.canGoBack = history.currentIndex > 0
        record.tab.canGoForward = history.currentIndex < history.entries.length - 1
      }),
      this.connection?.send<{ targetInfo: CdpTargetInfo }>('Target.getTargetInfo', { targetId: record.tab.id }).then(({ targetInfo }) => {
        contents.url = targetInfo.url
        contents.title = targetInfo.title
        record.tab.url = targetInfo.url || 'about:blank'
        record.tab.title = targetInfo.title || record.tab.url
      }),
    ].map(work => Promise.resolve(work).catch(() => undefined)))
  }

  private removeRecord(tabId: string): void {
    const record = this.records.get(tabId)
    if (!record) return
    const ids = [...this.records.keys()]
    const index = ids.indexOf(tabId)
    record.contents.markDestroyed()
    this.automation.invalidate(tabId)
    this.releaseLoadWaiters(record)
    this.records.delete(tabId)
    if (this.activeTabId === tabId) this.activeTabId = [...this.records.keys()][Math.max(0, index - 1)]
  }

  private mutateTabs<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tabMutationQueue.then(operation)
    this.tabMutationQueue = result.then(() => undefined, () => undefined)
    return result
  }

  private requireTab(tabId: string): TabRecord {
    const record = this.records.get(tabId)
    if (!record) throw new Error('Browser tab not found')
    return record
  }

  /** Resolves when the main frame finishes loading (or the timeout passes). */
  private waitForLoad(record: TabRecord, timeoutMs = NAVIGATION_TIMEOUT_MS): { promise: Promise<void>; cancel: () => void } {
    let done!: () => void
    let timer: NodeJS.Timeout | undefined
    const promise = new Promise<void>(resolve => {
      done = () => {
        if (timer) clearTimeout(timer)
        record.loadWaiters.delete(done)
        resolve()
      }
      record.loadWaiters.add(done)
      timer = setTimeout(done, timeoutMs)
      timer.unref?.()
    })
    return { promise, cancel: done }
  }

  private async load(record: TabRecord, url: string): Promise<void> {
    const loaded = this.waitForLoad(record)
    try {
      const result = await record.contents.send<{ errorText?: string; loaderId?: string }>('Page.navigate', { url })
      if (result.errorText) throw new Error(`Navigation failed: ${result.errorText}`)
      // Same-document navigations commit without a new load.
      if (result.loaderId) await loaded.promise
    } finally {
      loaded.cancel()
    }
    await this.refreshTab(record)
  }

  async createTab(url = 'about:blank', activate = true): Promise<DesktopBrowserTab> {
    const normalized = normalizeBrowserUrl(url, { allowBlank: true })
    const connection = await this.connect()
    const record = await this.mutateTabs(async () => {
      while (this.records.size >= MAX_BROWSER_TABS) {
        // Only tabs agents opened are recycled; a person's tabs on the screen stay.
        const oldest = [...this.records.values()].find(item => item.agentOpened)
        if (!oldest) throw new Error(`The screen's browser already has ${this.records.size} tabs; close one first`)
        await this.closeTabRecord(oldest.tab.id)
      }
      const { targetId } = await connection.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank', background: !activate })
      let record = this.records.get(targetId)
      if (!record) {
        const { targetInfo } = await connection.send<{ targetInfo: CdpTargetInfo }>('Target.getTargetInfo', { targetId })
        record = this.addTarget(connection, targetInfo, false)
      }
      if (!record) throw new Error('Chrome did not open a tab')
      record.agentOpened = true
      if (activate || !this.activeTabId) this.activeTabId = targetId
      await record.contents.attach()
      return record
    })
    if (normalized !== 'about:blank') await this.load(record, normalized).catch(() => undefined)
    return copyTab(record.tab)
  }

  async closeTab(tabId: string): Promise<DesktopBrowserState> {
    return this.mutateTabs(() => this.closeTabRecord(tabId))
  }

  private async closeTabRecord(tabId: string): Promise<DesktopBrowserState> {
    this.requireTab(tabId)
    await this.connection?.send('Target.closeTarget', { targetId: tabId }).catch(() => undefined)
    this.removeRecord(tabId)
    return this.state()
  }

  activateTab(tabId: string): DesktopBrowserState {
    this.requireTab(tabId)
    this.activeTabId = tabId
    void this.connection?.send('Target.activateTarget', { targetId: tabId }).catch(() => undefined)
    return this.state()
  }

  async navigate(tabId: string, url: string): Promise<DesktopBrowserTab> {
    const record = this.requireTab(tabId)
    await this.load(record, normalizeBrowserUrl(url))
    return copyTab(record.tab)
  }

  async navigationAction(tabId: string, action: 'back' | 'forward' | 'reload' | 'stop'): Promise<DesktopBrowserTab> {
    const record = this.requireTab(tabId)
    const contents = record.contents
    if (action === 'back' || action === 'forward') {
      const history = await contents.send<{ currentIndex: number; entries: Array<{ id: number }> }>('Page.getNavigationHistory')
      const entry = history.entries[history.currentIndex + (action === 'back' ? -1 : 1)]
      if (entry) await contents.send('Page.navigateToHistoryEntry', { entryId: entry.id })
    } else if (action === 'reload') await contents.send('Page.reload')
    else await contents.send('Page.stopLoading')
    return copyTab(record.tab)
  }

  // ── Automation (ported from the Desktop BrowserManager) ─────────────

  /** Electron WebContents stand-in, typed for the Desktop automation code. */
  private wc(record: TabRecord): never {
    return record.contents as never
  }

  async snapshot(tabId: string, options: BrowserSnapshotOptions = {}) {
    const record = this.requireTab(tabId)
    let snapshot = await this.automation.snapshot(tabId, this.wc(record), options)
    // Loading tabs can expose only the document root for a short time. Never retry an action.
    for (let attempt = 0; !options.snapshotId && snapshot.totalNodes! <= 1 && attempt < 3; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 100))
      snapshot = await this.automation.snapshot(tabId, this.wc(record), options)
    }
    return snapshot
  }

  async readText(tabId: string, options: BrowserReadTextOptions) {
    const record = this.requireTab(tabId)
    return this.automation.readText(tabId, this.wc(record), options)
  }

  async interact(tabId: string, action: BrowserInteractAction, assertActive: () => void = () => {}): Promise<BrowserInteractionResult> {
    assertActive()
    const record = this.requireTab(tabId)
    const before = this.automation.observedState(tabId)
    const options = this.automation.snapshotSelection(tabId)
    const targets = this.automation.observedTargets(tabId, 'snapshot_id' in action ? action.snapshot_id : undefined, [action])
    const generation = record.documentGeneration
    const tabs = new Set(this.records.keys())
    const started = Date.now()
    return this.withAutomationView(record, async () => {
      await this.automation.interact(tabId, this.wc(record), action, assertActive)
      const pointer = this.automation.lastPointer(this.wc(record))
      const evidence = await this.observeOperation(record, before, targets, options, generation, tabs, assertActive, started)
      if (pointer && evidence.observation) evidence.observation.pointer = pointer
      return { ...copyTab(record.tab), ...evidence }
    })
  }

  pageDialog(tabId: string): BrowserPageDialog | undefined {
    return this.automation.pageDialog(this.wc(this.requireTab(tabId)))
  }

  async handleDialog(tabId: string, accept: boolean, promptText?: string): Promise<BrowserInteractionResult & { dialog: BrowserPageDialog }> {
    const record = this.requireTab(tabId)
    const before = this.automation.observedState(tabId)
    const options = this.automation.snapshotSelection(tabId)
    const generation = record.documentGeneration
    const tabs = new Set(this.records.keys())
    const dialog = await this.automation.handleDialog(tabId, this.wc(record), accept, promptText)
    const evidence = await this.observeOperation(record, before, [], options, generation, tabs, () => {}, Date.now())
    return { ...copyTab(record.tab), ...evidence, dialog }
  }

  networkEntries(tabId: string): BrowserNetworkEntry[] {
    return this.automation.networkEntries(this.wc(this.requireTab(tabId)))
  }

  clearNetwork(tabId: string): void {
    this.automation.clearNetwork(this.wc(this.requireTab(tabId)))
  }

  private async observeOperation(
    record: TabRecord, before: BrowserObservedState | undefined, targets: BrowserObservedTarget[],
    options: BrowserSnapshotOptions, generation: number, tabs: Set<string>, assertActive: () => void, started = Date.now(),
  ): Promise<Pick<BrowserInteractionResult, 'snapshot' | 'snapshotError' | 'observation'>> {
    const tabId = record.tab.id
    const contents = this.wc(record)
    // The page is blocked until the dialog is answered, so report it instead of reading a snapshot.
    const dialog = this.automation.pageDialog(contents)
    if (dialog) {
      return { observation: { status: 'observed', tabId, changed: true, dialog,
        hint: `The page opened a ${dialog.type} dialog and is blocked until it is answered. Call ekko_studio_browser_dialog with action=accept or action=dismiss, then take a new snapshot.` } }
    }
    try {
      assertActive()
      const newDocument = () => record.documentGeneration !== generation
      const read = async () => {
        try { return await this.snapshot(tabId, newDocument() ? {} : options) }
        catch (error) {
          // A clicked control may remove its own scoped region.
          if (!options.selector) throw error
          assertActive()
          return this.snapshot(tabId)
        }
      }
      const observe = () => observeBrowserState(newDocument() ? undefined : before,
        this.automation.observedState(tabId)!, newDocument() ? [] : targets)
      let snapshot = await read()
      let observation = observe()
      // Read-only settling catches async rendering and popup creation; dispatched actions are never replayed.
      for (let attempt = 0; attempt < 3; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 100))
        assertActive()
        snapshot = await read()
        observation = observe()
        if (observation.changed && !record.contents.isLoading()) break
      }
      const openedTabs = [...this.records.values()].filter(item => !tabs.has(item.tab.id) && item.openerTabId === tabId)
        .map(item => ({ id: item.tab.id, title: redactBrowserText(item.tab.title), url: publicBrowserUrl(item.tab.url) }))
      observation.tabId = tabId
      observation.navigation = newDocument() ? 'new_document' : before && before.url !== snapshot.url ? 'same_document' : undefined
      if (newDocument()) observation.changed = true
      if (openedTabs.length) {
        observation.openedTabs = openedTabs
        observation.changed = true
        observation.hint = 'A new tab opened. Use its tab_id and snapshot to inspect the destination; the originating tab is not destination evidence.'
        if (openedTabs.length === 1) snapshot = await this.snapshot(openedTabs[0].id)
      }
      const fileChooser = this.automation.fileChooserSince(contents, started)
      if (fileChooser) {
        observation.fileChooser = fileChooser
        observation.changed = true
        observation.hint = `The page tried to open a file picker; the OS dialog was suppressed. Call ekko_studio_browser_upload without ref to give it ${fileChooser.multiple ? 'files' : 'one file'}.`
      }
      assertActive()
      return { snapshot, observation }
    } catch (error) {
      const lateDialog = this.automation.pageDialog(contents)
      if (lateDialog) {
        return { observation: { status: 'observed', tabId, changed: true, dialog: lateDialog,
          hint: `The page opened a ${lateDialog.type} dialog. Call ekko_studio_browser_dialog with action=accept or action=dismiss, then take a new snapshot.` } }
      }
      assertActive()
      const message = redactBrowserText(error instanceof Error ? error.message : String(error), 500)
      return { snapshotError: message, observation: { status: 'unavailable',
        hint: 'The action was already dispatched, but follow-up evidence is unavailable. Read a fresh snapshot before deciding what to do; do not replay the action automatically.' } }
    }
  }

  async interactBatch(tabId: string, input: unknown, snapshotId: unknown, assertControl: () => void): Promise<BrowserBatchResult> {
    assertControl()
    const record = this.requireTab(tabId)
    return this.withAutomationView(record, () => this.runBatch(tabId, input, snapshotId, assertControl))
  }

  private async runBatch(tabId: string, input: unknown, snapshotId: unknown, assertControl: () => void): Promise<BrowserBatchResult> {
    const actions = parseBrowserBatchActions(input)
    const record = this.requireTab(tabId)
    const snapshotOptions = this.automation.snapshotSelection(tabId)
    const prepared = this.automation.prepareBatch(tabId, snapshotId, actions)
    const before = this.automation.observedState(tabId)
    const targets = this.automation.observedTargets(tabId, snapshotId, actions)
    const tabs = new Set(this.records.keys())
    const generation = record.documentGeneration
    const deadline = Date.now() + BROWSER_BATCH_TIMEOUT_MS
    const assertActive = () => {
      assertControl()
      if (Date.now() >= deadline) throw new Error('Browser batch timed out; remaining actions were skipped')
      if (this.records.get(tabId) !== record || record.contents.isDestroyed()) throw new Error('Browser tab is closed')
      if (record.documentGeneration !== generation) {
        throw new Error('Browser page navigated; take a new snapshot before continuing')
      }
    }
    const result: BrowserBatchResult = { tabId, completed: 0, total: actions.length, results: [] }
    const started = Date.now()
    for (let index = 0; index < prepared.length; index += 1) {
      const action = (actions[index] as BrowserBatchAction).action
      // A page dialog blocks the page; the remaining steps would act on an unknown state.
      if (result.completed !== index || this.automation.pageDialog(this.wc(record))) {
        result.results.push({ index, action, status: 'skipped' })
        continue
      }
      try {
        assertActive()
        const resolved = await this.automation.resolveBatchAction(tabId, this.wc(record), prepared[index])
        assertActive()
        await this.automation.interact(tabId, this.wc(record), resolved, assertActive)
        result.completed += 1
        result.results.push({ index, action, status: 'completed' })
      } catch (error) {
        result.results.push({ index, action, status: 'failed', error: redactBrowserText(error instanceof Error ? error.message : String(error), 500) })
      }
    }
    try {
      assertControl()
      if (Date.now() >= deadline) throw new Error('Browser batch timed out')
      Object.assign(result, await this.observeOperation(record, before, targets.filter(target => target.actionIndex < result.completed), snapshotOptions, generation, tabs, () => {
        assertControl()
        if (Date.now() >= deadline) throw new Error('Browser batch timed out')
      }, started))
      assertControl()
    } catch (error) {
      delete result.snapshot
      result.snapshotError = redactBrowserText(error instanceof Error ? error.message : String(error), 500)
    }
    return result
  }

  async upload(
    tabId: string, snapshotId: string | undefined, ref: string | undefined, files: BrowserUploadFile[], method: BrowserUploadMethod,
    assertActive: () => void = () => {},
  ): Promise<BrowserInteractionResult & { upload: BrowserUploadResult }> {
    assertActive()
    const record = this.requireTab(tabId)
    const before = this.automation.observedState(tabId)
    const options = this.automation.snapshotSelection(tabId)
    const generation = record.documentGeneration
    const tabs = new Set(this.records.keys())
    return this.withAutomationView(record, async () => {
      const upload = await this.automation.upload(tabId, this.wc(record), snapshotId, ref, files, method, assertActive)
      const evidence = await this.observeOperation(record, before, [], options, generation, tabs, assertActive)
      return { ...copyTab(record.tab), ...evidence, upload }
    })
  }

  async wait(tabId: string, options: BrowserWaitOptions, assertActive: () => void = () => {}): Promise<BrowserWaitResult> {
    const record = this.requireTab(tabId)
    return this.withAutomationView(record, () => this.automation.wait(tabId, this.wc(record), options, () => {
      assertActive()
      if (this.records.get(tabId) !== record || record.contents.isDestroyed()) throw new Error('Browser tab is closed')
    }))
  }

  /** Fetch a link/media target with the page's own cookies and hold it in memory for chunked reads. */
  async downloadStart(tabId: string, source: { url?: string; snapshotId?: string; ref?: string }): Promise<BrowserDownloadInfo> {
    const record = this.requireTab(tabId)
    const contents = this.wc(record)
    let url = source.url || ''
    let suggested = ''
    if (!url) {
      if (!source.snapshotId || !source.ref) throw new Error('url or snapshot_id and ref are required')
      ;({ url, fileName: suggested } = await this.automation.downloadSource(tabId, contents, source.snapshotId, source.ref))
    } else if (!/^(?:blob|data):/i.test(url)) {
      url = new URL(url, record.contents.getURL()).toString()
    }
    if (/^blob:/i.test(url)) {
      const blob = await this.automation.readPageBlob(contents, url, MAX_BROWSER_DOWNLOAD_BYTES)
      return this.agentDownloads.add(blob.data, { fileName: suggested || 'download', mimeType: blob.type, sourceUrl: 'blob:' })
    }
    if (/^data:/i.test(url)) {
      const response = await fetch(url)
      const data = await readLimitedBody(response, MAX_BROWSER_DOWNLOAD_BYTES)
      return this.agentDownloads.add(data, { fileName: suggested || 'download', mimeType: (response.headers.get('content-type') || '').split(';')[0], sourceUrl: 'data:' })
    }
    if (!isAllowedBrowserRequest(url)) throw new Error('This address is blocked by the browser security policy')
    // First from inside the page (its cookies, the way a click would fetch it); a cross-origin
    // file the page may not read falls back to Studio fetching it with the browser's cookies.
    const downloaded = await this.pageFetch(record, url).catch(() => this.cookieFetch(record, url))
    if (!isAllowedBrowserRequest(downloaded.url)) throw new Error('This address is blocked by the browser security policy')
    return this.agentDownloads.add(downloaded.data, {
      fileName: fileNameFromResponse(downloaded.url, downloaded.contentDisposition, suggested),
      mimeType: downloaded.mimeType, sourceUrl: publicBrowserUrl(downloaded.url),
    })
  }

  private async pageFetch(record: TabRecord, url: string): Promise<{ data: Buffer; url: string; contentDisposition: string; mimeType: string }> {
    if (this.automation.pageDialog(this.wc(record))) throw new Error('A page dialog is open')
    const response = await record.contents.send<{ result?: { value?: any }; exceptionDetails?: unknown }>('Runtime.evaluate', {
      expression: `(${PAGE_FETCH_FUNCTION})(${JSON.stringify(url)}, ${MAX_BROWSER_DOWNLOAD_BYTES})`, awaitPromise: true, returnByValue: true,
    })
    const value = response.result?.value
    if (response.exceptionDetails || typeof value?.data !== 'string') throw new Error('The page could not fetch the file')
    return {
      data: Buffer.from(value.data, 'base64'), url: String(value.url || url),
      contentDisposition: String(value.contentDisposition || ''), mimeType: String(value.type || '').split(';')[0],
    }
  }

  private async cookieFetch(record: TabRecord, url: string): Promise<{ data: Buffer; url: string; contentDisposition: string; mimeType: string }> {
    const page = record.contents.getURL()
    const referer = /^https?:/i.test(page) ? `${new URL(page).origin}/` : undefined
    let current = url
    for (let redirects = 0; redirects <= 5; redirects++) {
      if (!isAllowedBrowserRequest(current)) throw new Error('This address is blocked by the browser security policy')
      const { cookies } = await record.contents.send<{ cookies: Array<{ name: string; value: string }> }>('Network.getCookies', { urls: [current] })
        .catch(() => ({ cookies: [] }))
      const headers: Record<string, string> = {}
      if (cookies.length) headers.cookie = cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ')
      if (referer) headers.referer = referer
      const response = await fetch(current, { headers, redirect: 'manual', signal: AbortSignal.timeout(120_000) })
      if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
        current = new URL(response.headers.get('location')!, current).toString()
        continue
      }
      if (response.status < 200 || response.status >= 300) throw new Error(`Download failed with HTTP ${response.status}`)
      if (Number(response.headers.get('content-length')) > MAX_BROWSER_DOWNLOAD_BYTES) throw new Error('Download exceeds the 20 MB limit')
      const data = await readLimitedBody(response, MAX_BROWSER_DOWNLOAD_BYTES)
      return { data, url: current, contentDisposition: response.headers.get('content-disposition') || '',
        mimeType: (response.headers.get('content-type') || '').split(';')[0] }
    }
    throw new Error('Download redirected too many times')
  }

  downloadRead(downloadId: string, offset: number): BrowserDownloadChunk {
    return this.agentDownloads.read(downloadId, offset)
  }

  async screenshot(tabId: string, fullPage = false) {
    const record = this.requireTab(tabId)
    return this.withAutomationView(record, () => this.automation.screenshot(tabId, this.wc(record), fullPage))
  }

  consoleEntries(tabId: string): BrowserConsoleEntry[] {
    return this.requireTab(tabId).console.map(entry => ({ ...entry }))
  }

  clearConsole(tabId: string): void {
    this.requireTab(tabId).console = []
  }

  setAgentControl(tabId: string, control: BrowserAgentControl, label?: string, action?: string): void {
    const record = this.requireTab(tabId)
    const tab = record.tab
    if ((tab.agentControl === 'active') !== (control === 'active')) {
      // Agent clicks on upload buttons must not open the OS file dialog on the screen.
      void this.automation.setFileChooserInterception(this.wc(record), control === 'active').catch(() => undefined)
    }
    tab.agentControl = control
    tab.agentLabel = label
    tab.agentAction = action
  }

  revokeAgentControl(tabId: string): void {
    this.setAgentControl(tabId, 'idle')
  }

  cancelAgentOperation(tabId: string): void {
    const record = this.requireTab(tabId)
    if (record.contents.isLoading()) void record.contents.send('Page.stopLoading').catch(() => undefined)
    this.automation.invalidate(tabId)
    this.revokeAgentControl(tabId)
  }

  /**
   * A real Chrome only paints (and screenshots) its front tab, and throttles the timers of
   * background tabs, so automation brings the tab to the front of the screen first.
   */
  private async withAutomationView<T>(record: TabRecord, operation: () => Promise<T>): Promise<T> {
    if (this.activeTabId !== record.tab.id) {
      await record.contents.send('Page.bringToFront').catch(() => undefined)
      this.activeTabId = record.tab.id
    }
    return operation()
  }

  async destroy(): Promise<void> {
    this.agentDownloads.clear()
    this.disconnect()
  }
}
