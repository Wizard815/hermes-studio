import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * Agent work settings (Connections → Agent work). Nothing about Mattermost is
 * built in: the channel and who gets an @mention are whatever is saved here,
 * and an empty value means "not set". Secrets (ALLGlance and wiki tokens) are
 * never sent to browsers.
 */
export interface AgentWorkSettings {
  /** Send agent activity and approval requests to Pondering Orb. Off by default. */
  shareToOrb: boolean
  mattermost: {
    /** Channel name to post to (in the team Studio set Mattermost up with). Empty: no posts. */
    channel: string
    /** Resolved when saved, so posts need no lookup. */
    channelId: string
    teamId: string
    /** Usernames to @mention on #blocked posts. Empty: no mention. */
    mention: string[]
    /** Also @mention them on approval requests (they need you too). */
    mentionOnApproval: boolean
    /** Studio's address as Mattermost can reach it, for the Approve / Reject buttons. Empty: no buttons (reactions still work). */
    actionUrl: string
  }
  allglance: { url: string; token: string }
  wiki: {
    /** The wiki's REST address (the Obsidian Local REST API Orb uses), e.g. http://llmwiki:27123. Empty: no digest. */
    url: string
    token: string
    /** Folder of the daily notes in the vault. */
    folder: string
    /** The section Studio owns in each daily note. */
    section: string
  }
}

export interface AgentWorkPublicSettings {
  shareToOrb: boolean
  mattermost: AgentWorkSettings['mattermost']
  allglance: { url: string; hasToken: boolean; fromEnv: boolean }
  wiki: { url: string; hasToken: boolean; folder: string; section: string }
}

export const DEFAULT_SETTINGS: AgentWorkSettings = {
  shareToOrb: false,
  mattermost: { channel: '', channelId: '', teamId: '', mention: [], mentionOnApproval: true, actionUrl: '' },
  allglance: { url: '', token: '' },
  wiki: { url: '', token: '', folder: 'daily', section: 'Hermes Studio' },
}

const trimSlash = (url: string) => String(url || '').trim().replace(/\/+$/, '')

export function parseMentions(value: unknown): string[] {
  const raw = Array.isArray(value) ? value.join(',') : String(value ?? '')
  const names = raw.split(/[\s,]+/).map(s => s.trim().replace(/^@/, '').toLowerCase()).filter(Boolean)
  for (const name of names) if (!/^[a-z0-9._-]{1,64}$/.test(name)) throw Object.assign(new Error(`"${name}" is not a Mattermost username`), { status: 400 })
  return [...new Set(names)]
}

function normalize(raw: any): AgentWorkSettings {
  const mm = raw?.mattermost || {}, ag = raw?.allglance || {}, wiki = raw?.wiki || {}
  let mention: string[] = []
  try { mention = parseMentions(mm.mention) } catch { mention = [] }
  return {
    shareToOrb: raw?.shareToOrb === true,
    mattermost: {
      channel: String(mm.channel || '').trim().replace(/^[#~]/, ''),
      channelId: String(mm.channelId || ''),
      teamId: String(mm.teamId || ''),
      mention,
      mentionOnApproval: mm.mentionOnApproval !== false,
      actionUrl: trimSlash(mm.actionUrl),
    },
    allglance: { url: trimSlash(ag.url), token: String(ag.token || '') },
    wiki: {
      url: trimSlash(wiki.url), token: String(wiki.token || ''),
      folder: String(wiki.folder || DEFAULT_SETTINGS.wiki.folder).trim().replace(/^\/+|\/+$/g, '') || DEFAULT_SETTINGS.wiki.folder,
      section: String(wiki.section || DEFAULT_SETTINGS.wiki.section).trim() || DEFAULT_SETTINGS.wiki.section,
    },
  }
}

export class AgentWorkSettingsFile {
  private settings: AgentWorkSettings = normalize({})
  private loaded = false

  constructor(private readonly file: string, private readonly env: NodeJS.ProcessEnv = process.env) {}

  private get allglanceFromEnv(): boolean { return !!this.env.ALLGLANCE_URL }

  async load(): Promise<AgentWorkSettings> {
    if (!this.loaded) {
      this.loaded = true
      try { this.settings = normalize(JSON.parse(await readFile(this.file, 'utf8'))) } catch { /* defaults */ }
    }
    const out = structuredClone(this.settings)
    if (this.allglanceFromEnv) out.allglance = { url: trimSlash(this.env.ALLGLANCE_URL || ''), token: String(this.env.ALLGLANCE_TOKEN || '') }
    return out
  }

  async publicSettings(): Promise<AgentWorkPublicSettings> {
    const s = await this.load()
    return {
      shareToOrb: s.shareToOrb,
      mattermost: s.mattermost,
      allglance: { url: s.allglance.url, hasToken: !!s.allglance.token, fromEnv: this.allglanceFromEnv },
      wiki: { url: s.wiki.url, hasToken: !!s.wiki.token, folder: s.wiki.folder, section: s.wiki.section },
    }
  }

  /** Merge a change (tokens left empty keep the stored ones) and save it. */
  async save(next: AgentWorkSettings): Promise<AgentWorkPublicSettings> {
    await this.load()
    const merged = normalize(next)
    if (!merged.allglance.token) merged.allglance.token = this.settings.allglance.token
    if (!merged.wiki.token) merged.wiki.token = this.settings.wiki.token
    this.settings = merged
    await mkdir(dirname(this.file), { recursive: true })
    const temp = `${this.file}.${process.pid}.tmp`
    await writeFile(temp, `${JSON.stringify(this.settings, null, 2)}\n`, { mode: 0o600 })
    await rename(temp, this.file)
    return this.publicSettings()
  }
}

export { normalize as normalizeAgentWorkSettings }
