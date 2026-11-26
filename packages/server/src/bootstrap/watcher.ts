import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { getWebUiHome } from '../modules/studio/public/config'
import { logger } from '../modules/studio/public/logging'
import { getChatRunServer } from '../modules/studio/public/chat-run'
import { getActiveProfileName, getProfileDir } from '../modules/studio/public/profile-config'
import { getDb } from '../modules/studio/infrastructure/database'
import { getSession } from '../modules/studio/repositories/session-store'
import { getAgentWork } from '../modules/studio/services/agent-work'
import { approvalAlertsWantMattermost, observeApprovalAlertBlocked } from '../modules/studio/services/approval-alerts'
import { readProfileEnv } from '../modules/hermes/controllers/mattermost-setup'
import { chatApprovalOverride, setChatApprovalOverride } from '../modules/coding-agents/services/approvals'
import { closeWatcher, configureWatcher, recordWatcherEvent, WatcherConfigFile, WatcherExtras, WatcherStore } from '../modules/studio/services/watcher'

/**
 * The Watcher (docs/watcher.md): its feed in Studio's database, its settings
 * and trust rules in `HERMES_WEB_UI_HOME/watcher.json`, live updates over the
 * chat-run socket, and Agent work's Mattermost channel for the kinds Settings
 * sends there. Sources call `recordWatcherEvent` (studio/public/watcher.ts).
 */
export function startWatcher(): { close: () => void } {
  let timer: ReturnType<typeof setInterval> | null = null
  try {
    // Without Studio's SQLite (old Node), the feed lives in memory until restart.
    const db = getDb() || new DatabaseSync(':memory:')
    const profile = () => getActiveProfileName() || 'default'
    const extras = new WatcherExtras({
      hermesConfigText: () => {
        const file = join(getProfileDir(profile()), 'config.yaml')
        return existsSync(file) ? readFileSync(file, 'utf8') : ''
      },
      profileEnv: () => readProfileEnv(profile()),
    })
    const service = configureWatcher({
      store: new WatcherStore(db),
      config: new WatcherConfigFile(() => join(getWebUiHome(), 'watcher.json')),
      extras,
      emit: (event, payload) => getChatRunServer()?.emitWatcher?.(event, payload),
      sessionInfo: sessionId => {
        const session = getSession(sessionId)
        if (!session) return null
        // The same agent ids approvals use (run.launch.agentId), so "Trust this" for an agent matches.
        const stored = session.agent === 'claude' || session.agent === 'claude_code' ? 'claude-code' : session.agent
        const agent = session.source === 'coding_agent' ? stored : stored === 'ekko-agent' ? 'ekko' : stored || 'hermes'
        return { title: session.title || '', agent, folder: session.workspace || '' }
      },
      // A task's or chat's own mode is the one `/yolo` sets (coding-agent chats) and Hermes chats follow too.
      chatApprovalMode: sessionId => chatApprovalOverride(sessionId),
      setChatApprovalMode: (sessionId, mode) => setChatApprovalOverride(sessionId, mode),
      tasksForSession: sessionId => {
        try { return getAgentWork().list({ limit: 500 }).filter(work => work.sessionId === sessionId && !work.decision).map(work => work.id) } catch { return [] }
      },
      mattermost: async (event, title) => {
        let agentWork
        try { agentWork = getAgentWork() } catch { return false }
        // Run limits keep the post they always had (#agentlimit #blocked with the @mentions).
        if (event.kind === 'run_limit' || event.kind === 'loop') return agentWork.alertBlocked(title || 'A chat', event.text)
        return agentWork.postAlert(['studiowatcher', event.kind], title, event.text, event.severity === 'block')
      },
      // Settings → Watcher → "Where approvals reach you": Blocked alerts to Mattermost and phones (docs/approval-alerts.md).
      blocked: {
        mattermost: () => approvalAlertsWantMattermost('blocked'),
        notify: (event, title) => observeApprovalAlertBlocked(event, title),
      },
      onError: (what, error) => logger.warn({ err: error }, '[watcher] %s failed', what),
    })
    // InnerWarden switched on but not hooked into Hermes: say so once a day (the repeat window keeps it to one alert).
    const checkExtras = () => {
      try {
        if (extras.innerwardenMissing(service.settings())) {
          recordWatcherEvent({ kind: 'connection', severity: 'warn', text: 'InnerWarden is on in Settings → Watcher, but Hermes\'s config.yaml has no innerwarden hook. Run "innerwarden agents connect hermes".', link: '/hermes/config/settings?tab=watcher' })
        }
      } catch { /* next time */ }
    }
    timer = setInterval(() => { service.prune(); checkExtras() }, 6 * 3600_000)
    timer.unref?.()
    setTimeout(checkExtras, 30_000).unref?.()
  } catch (error) {
    logger.warn({ err: error }, '[watcher] not started')
  }
  return { close: () => { if (timer) clearInterval(timer); closeWatcher() } }
}
