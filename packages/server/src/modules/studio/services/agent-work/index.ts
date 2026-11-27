import { getDb } from '../../infrastructure/database'
import { getOrbClient } from '../orb/client'
import { logger } from '../../public/logging'
import { AgentWorkStore } from './store'
import { AgentWorkSettingsFile } from './settings'
import { MattermostRest, decidedPlace } from './mattermost'
import { OrbShare } from './orb-share'
import { AllGlanceMcp } from './allglance'
import { ObsidianWiki } from './wiki'
import { AgentWorkService } from './service'
import { recordWatcherEvent } from '../watcher'
import { approvalAlertsWantMattermost, approvalAlertsWorkChanged } from '../approval-alerts'
import type { AgentWork } from './store'

/** Agent work in the watcher's feed (docs/watcher.md): waiting for approval, blocked, decided. */
export function watchAgentWork(work: AgentWork, change: 'created' | 'status' | 'decided'): void {
  const base = { taskId: work.id, sessionId: work.sessionId || undefined, agent: work.agent || undefined, link: '/hermes/connections?tab=agent-work' }
  if (change === 'decided' && work.decision) {
    recordWatcherEvent({ ...base, kind: 'work_decided', severity: 'info', text: `${work.decision === 'approved' ? 'Approved' : 'Rejected'} ${decidedPlace(work.decidedVia, work.decidedBy)}: ${work.title}` })
  } else if (work.status === 'awaiting_approval') {
    recordWatcherEvent({ ...base, kind: 'work_approval', severity: 'warn', text: `Waiting for your approval: ${work.title}` })
  } else if (work.status === 'blocked') {
    recordWatcherEvent({ ...base, kind: 'work_blocked', severity: 'warn', text: `Blocked: ${work.title}${work.summary ? ` (${work.summary.slice(0, 160)})` : ''}` })
  }
}

/** What agent work reads from the Hermes profile; bootstrap supplies it, since Studio must not import Hermes. */
export interface AgentWorkHermesProfile {
  activeProfile(): string | null | undefined
  env(profile: string): Record<string, string>
  mattermostSetup(profile: string): { team: { id: string }; user: { id: string } } | null
}

let service: AgentWorkService | null = null
let timers: ReturnType<typeof setInterval>[] = []

/** Process-wide agent work service; bootstrap sets the settings file under HERMES_WEB_UI_HOME. */
export function configureAgentWork(settingsFile: string, hermes: AgentWorkHermesProfile): AgentWorkService {
  closeAgentWork()
  const db = getDb()
  if (!db) throw new Error('Agent work needs SQLite (Node 22.5 or newer)')
  const settings = new AgentWorkSettingsFile(settingsFile)
  const profile = () => hermes.activeProfile() || 'default'
  const mattermost = new MattermostRest(() => {
    const env = hermes.env(profile())
    return { url: String(env.MATTERMOST_URL || '').trim().replace(/\/+$/, ''), token: String(env.MATTERMOST_TOKEN || '').trim() }
  })
  service = new AgentWorkService({
    store: new AgentWorkStore(db),
    settings,
    mattermost,
    setupRecord: () => {
      const record = hermes.mattermostSetup(profile())
      return record ? { teamId: record.team.id, userId: record.user.id } : null
    },
    orb: new OrbShare(getOrbClient),
    allglance: new AllGlanceMcp(async () => (await settings.load()).allglance),
    wiki: new ObsidianWiki(async () => (await settings.load()).wiki),
    onError: (what, error) => logger.warn({ err: error }, '[agent-work] %s failed', what),
    observe: (work, change) => { watchAgentWork(work, change); approvalAlertsWorkChanged() },
    approvalPostWanted: () => approvalAlertsWantMattermost('work'),
  })
  const current = service
  // ✅ / ❌ reactions on approval posts, and Vikunja tasks still to mark done.
  timers = [
    setInterval(() => { void current.pollMattermostReactions().catch(error => logger.warn({ err: error }, '[agent-work] reaction poll failed')) }, 15_000),
    setInterval(() => { void current.retryVikunja().catch(() => undefined) }, 5 * 60_000),
  ]
  for (const timer of timers) timer.unref?.()
  return service
}

export function getAgentWork(): AgentWorkService {
  if (!service) throw Object.assign(new Error('Agent work is not set up'), { status: 503 })
  return service
}

export function closeAgentWork(): void {
  for (const timer of timers) clearInterval(timer)
  timers = []
  service?.close()
  service = null
}
