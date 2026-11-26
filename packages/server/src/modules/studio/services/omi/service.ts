import { randomBytes } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { OrbWork, OrbWorkTracker } from '../orb/work'
import type { AgentWork } from '../agent-work/store'
import type { DecisionResult } from '../agent-work/service'
import { OMI_SKILL_MD } from './skill'
import { OmiError, cleanUrl, publicKey, type OmiKeyRecord, type OmiPublicKey, type OmiSettingsFile } from './settings'

/**
 * Omi (Wizard815/omi-local) and Studio, Connections → Omi (docs/omi.md):
 * - Omi sends work to Studio with a Studio key made for it, which can only start
 *   and follow Omi's own work chats and answer their Agent work approvals;
 * - Studio sends the results back on Omi's signed webhook, only for those chats;
 * - the MCP page adds Omi's MCP server, and this installs Omi's Hermes skill.
 */

/** Where Omi listens for Studio's results (omi-local backend/routers/agent_jobs.py). */
export const OMI_WEBHOOK_PATH = '/v1/integrations/studio/events'
/** What Omi does with them: a finished chat, a failed one, a chat waiting for an approval. */
export const OMI_WEBHOOK_EVENTS = ['chat.run.completed', 'chat.run.failed', 'chat.approval.requested'] as const

export interface WebhookPort {
  create(input: { name: string; url: string; secret: string; event_types: string[]; include_content: boolean; allow_private_network: boolean; max_retries: number }): Promise<{ id: string } | null>
  get(id: string): { id: string; url: string; enabled: boolean } | null
  remove(id: string): boolean
  status(id: string): unknown
  reload(): void
  setFilter(id: string, filter: ((event: { subject?: { session_id?: string } }) => boolean) | null): void
}

export interface AgentWorkPort {
  list(filter: { status?: string[]; limit?: number }): AgentWork[]
  get(id: string): { work: AgentWork }
  decide(id: string, decision: 'approve' | 'reject', via: 'omi', by: string): Promise<DecisionResult>
}

export interface OmiDeps {
  settings: OmiSettingsFile
  work: () => OrbWorkTracker
  agentWork: () => AgentWorkPort
  webhooks: WebhookPort
  profiles: () => string[]
  profileDir: (profile: string) => string
  /** A short-lived Studio login for the key's owner, used only inside Studio to drive the chat run. */
  issueToken: (userId: number) => Promise<string>
  fetcher?: typeof fetch
}

export interface OmiStatus {
  settings: { url: string; webUrl: string; profile: string }
  keys: OmiPublicKey[]
  webhook: { registered: boolean; url: string; enabled: boolean; runtime: unknown }
  mcpUrl: string
}

export class OmiService {
  constructor(private readonly deps: OmiDeps) {}

  private get fetcher(): typeof fetch { return this.deps.fetcher ?? fetch }

  /** After a restart: the results webhook still only carries Omi's chats. */
  async start(): Promise<void> {
    const settings = await this.deps.settings.load()
    await this.deps.work().list().catch(() => [])
    if (settings.webhookEndpointId) this.deps.webhooks.setFilter(settings.webhookEndpointId, this.webhookFilter)
  }

  private readonly webhookFilter = (event: { subject?: { session_id?: string } }) => this.deps.work().hasSession(event?.subject?.session_id, 'omi')

  async status(): Promise<OmiStatus> {
    const settings = await this.deps.settings.load()
    const endpoint = settings.webhookEndpointId ? this.deps.webhooks.get(settings.webhookEndpointId) : null
    return {
      settings: { url: settings.url, webUrl: settings.webUrl, profile: settings.profile },
      keys: settings.keys.map(publicKey),
      webhook: {
        registered: !!endpoint,
        url: endpoint?.url || (settings.url ? `${settings.url}${OMI_WEBHOOK_PATH}` : ''),
        enabled: !!endpoint?.enabled,
        runtime: endpoint ? this.deps.webhooks.status(endpoint.id) : null,
      },
      mcpUrl: settings.url ? `${settings.url}/v1/mcp` : '',
    }
  }

  async saveSettings(input: { url?: unknown; webUrl?: unknown; profile?: unknown }): Promise<OmiStatus> {
    const patch: { url?: string; webUrl?: string; profile?: string } = {}
    if (input.url !== undefined) patch.url = cleanUrl(input.url, "Omi's address")
    if (input.webUrl !== undefined) patch.webUrl = cleanUrl(input.webUrl, "Omi's web page")
    if (input.profile !== undefined) {
      const profile = String(input.profile || '').trim()
      if (profile && !this.deps.profiles().includes(profile)) throw new OmiError(`There is no Hermes profile called "${profile}".`)
      patch.profile = profile
    }
    await this.deps.settings.update(patch)
    return this.status()
  }

  /** Omi's /v1/health (and /health on older builds) answers. */
  async test(): Promise<{ ok: boolean; detail: string; error: string }> {
    const { url } = await this.deps.settings.load()
    if (!url) return { ok: false, detail: '', error: "Add Omi's address first." }
    let last = ''
    for (const path of ['/v1/health', '/health']) {
      try {
        const response = await this.fetcher(`${url}${path}`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000) })
        if (response.ok) {
          const body = await response.json().catch(() => ({})) as { status?: string }
          return { ok: true, detail: `Omi answered ${path}${body?.status ? ` (${body.status})` : ''}`, error: '' }
        }
        last = `Omi answered ${path} with ${response.status}`
      } catch (error) {
        last = `Omi is not reachable at ${url}: ${error instanceof Error ? error.message : String(error)}. Check the address and that Omi's backend is running.`
      }
    }
    return { ok: false, detail: '', error: last }
  }

  createKey(userId: number, name: unknown) { return this.deps.settings.createKey(userId, name) }

  async revokeKey(id: string): Promise<{ revoked: true }> {
    if (!(await this.deps.settings.revokeKey(id))) throw new OmiError('No such key', 404)
    return { revoked: true }
  }

  /**
   * Register Omi's results webhook (a chat webhook to Omi, Settings → Webhooks)
   * with a new secret, replacing the one registered before. The secret is
   * returned once: Omi needs it to check Studio's signature.
   */
  async registerWebhook(): Promise<{ status: OmiStatus; secret: string }> {
    const settings = await this.deps.settings.load()
    if (!settings.url) throw new OmiError("Add Omi's address first.")
    await this.removeWebhook()
    const secret = randomBytes(32).toString('hex')
    const endpoint = await this.deps.webhooks.create({
      name: 'Omi results',
      url: `${settings.url}${OMI_WEBHOOK_PATH}`,
      secret,
      event_types: [...OMI_WEBHOOK_EVENTS],
      // Omi puts the chat's answer on its job (chat.run.completed's message.text).
      include_content: true,
      // Omi is usually on the home network.
      allow_private_network: true,
      max_retries: 3,
    })
    if (!endpoint) throw new OmiError('Webhook storage is unavailable', 503)
    this.deps.webhooks.setFilter(endpoint.id, this.webhookFilter)
    this.deps.webhooks.reload()
    await this.deps.settings.update({ webhookEndpointId: endpoint.id })
    return { status: await this.status(), secret }
  }

  async removeWebhook(): Promise<OmiStatus> {
    const settings = await this.deps.settings.load()
    if (settings.webhookEndpointId) {
      this.deps.webhooks.setFilter(settings.webhookEndpointId, null)
      this.deps.webhooks.remove(settings.webhookEndpointId)
      this.deps.webhooks.reload()
      await this.deps.settings.update({ webhookEndpointId: '' })
    }
    return this.status()
  }

  /** Copy Omi's Hermes skill into a profile's skills (it needs the Omi MCP server in that profile). */
  async installSkill(profile: unknown): Promise<{ profile: string; path: string }> {
    const name = String(profile || '').trim() || 'default'
    if (!this.deps.profiles().includes(name)) throw new OmiError(`There is no Hermes profile called "${name}".`)
    const dir = join(this.deps.profileDir(name), 'skills', 'productivity', 'omi')
    await mkdir(dir, { recursive: true })
    const path = join(dir, 'SKILL.md')
    await writeFile(path, OMI_SKILL_MD)
    return { profile: name, path }
  }

  // --- what the key can do --------------------------------------------------

  /** The key's record, or null. */
  async authenticate(token: string): Promise<OmiKeyRecord | null> {
    const key = await this.deps.settings.findKey(token)
    if (key) void this.deps.settings.touchKey(key.id)
    return key
  }

  async startWork(input: { userId: number; profile?: string; body: Record<string, unknown> }): Promise<OrbWork> {
    const settings = await this.deps.settings.load()
    return this.deps.work().start({
      token: await this.deps.issueToken(input.userId),
      profile: input.profile || settings.profile || 'default',
      agentId: input.body.agentId,
      title: input.body.title,
      prompt: input.body.prompt,
      workspace: input.body.workspace,
      source: 'omi',
    })
  }

  async listWork(): Promise<OrbWork[]> {
    return (await this.deps.work().list()).filter(item => item.source === 'omi')
  }

  /** Agent work waiting for approval in the chats Omi started. */
  async approvals(): Promise<AgentWork[]> {
    await this.deps.work().list()
    return this.deps.agentWork().list({ status: ['awaiting_approval'], limit: 200 })
      .filter(work => this.deps.work().hasSession(work.sessionId, 'omi'))
  }

  /** Omi answers an approval it was asked about. Work in any other chat looks like it does not exist. */
  async decide(id: string, decision: 'approve' | 'reject', key: Pick<OmiKeyRecord, 'name'>, by: unknown): Promise<DecisionResult> {
    await this.deps.work().list()
    let work: AgentWork
    try { work = this.deps.agentWork().get(id).work } catch { throw new OmiError('No such agent work', 404) }
    if (!this.deps.work().hasSession(work.sessionId, 'omi')) throw new OmiError('No such agent work', 404)
    const who = String(by ?? '').trim().slice(0, 60)
    return this.deps.agentWork().decide(id, decision, 'omi', who ? `${who} (Omi)` : `Omi (${key.name})`)
  }
}
