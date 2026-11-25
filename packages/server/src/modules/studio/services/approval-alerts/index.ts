import type { WatcherEvent } from '../../../../../../shared/watcher'
import type { ApprovalAlertKind } from '../../../../../../shared/approval-alerts'
import { ApprovalAlertsService, type ApprovalAlertsDeps } from './service'

export { ApprovalAlertsService } from './service'
export { ApprovalAlertsFile, ApprovalAlertsError } from './settings'
export { phoneKeyAllows, looksLikePhoneKey, checkPhoneKey, setPhoneKeyLookup } from './scope'

/** Process-wide service; bootstrap/approval-alerts.ts sets it up. The helpers below are no-ops before that. */
let service: ApprovalAlertsService | null = null

export function configureApprovalAlerts(deps: ApprovalAlertsDeps): ApprovalAlertsService {
  service?.close()
  service = new ApprovalAlertsService(deps)
  return service
}

export function getApprovalAlerts(): ApprovalAlertsService {
  if (!service) throw Object.assign(new Error('Approval alerts are not set up'), { status: 503 })
  return service
}

export function closeApprovalAlerts(): void {
  service?.close()
  service = null
}

/** The chat-run stream (sockets/chat-run.ts). Never throws. */
export function observeApprovalAlertChatEvent(sessionId: string, event: string, payload: Record<string, any> | undefined, agent = ''): void {
  try { service?.observeChat(sessionId, event, payload, agent) } catch { /* alerts never break a run */ }
}

/** The phone tools' live events (services/android/phone-agent.ts). Never throws. */
export function observeApprovalAlertPhoneEvent(event: string, payload: unknown): void {
  try { service?.observePhone(event, payload) } catch { /* alerts never break a phone action */ }
}

/** Agent work changed. Never throws. */
export function approvalAlertsWorkChanged(): void {
  try { service?.workChanged() } catch { /* ignore */ }
}

/** A watcher Blocked alert. Never throws. */
export function observeApprovalAlertBlocked(event: WatcherEvent, title: string): void {
  try { service?.observeBlocked(event, title) } catch { /* ignore */ }
}

/** Whether Mattermost gets this kind. Before setup: what Studio did before (Agent work only). */
export function approvalAlertsWantMattermost(kind: ApprovalAlertKind): boolean {
  try { return service ? service.mattermostWants(kind) : kind === 'work' } catch { return kind === 'work' }
}
