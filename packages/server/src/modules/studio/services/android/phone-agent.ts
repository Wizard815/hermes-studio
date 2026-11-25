import { join } from 'node:path'
import { getWebUiHome } from '../../public/config'
import { getWatcher, recordWatcherEvent, watcherTrusts } from '../watcher'
import { observeApprovalAlertPhoneEvent } from '../approval-alerts'
import { PhoneTools } from './agent-tools'
import { androidDeviceManager, compressWithSharp } from './manager'

type Emit = (event: string, payload: unknown) => void
let emit: Emit = () => {}

/** The Android page's socket namespace hands its emitter here (sockets/android-devices.ts). */
export function setPhoneAgentEmitter(next: Emit) { emit = next }

/** Phone tools for agents, on Studio's adb layer (docs/android-devices.md, "Agents on the phone"). */
export const phoneAgent = new PhoneTools({
  adb: (args, timeoutMs) => androidDeviceManager.adb(args, timeoutMs),
  listDevices: () => androidDeviceManager.listDevices(),
  allowedDevices: () => androidDeviceManager.getSettings().agentDevices,
  installApk: (serial, path) => androidDeviceManager.installApk(serial, path),
  compress: compressWithSharp,
  approvalMode: sessionId => {
    try { return (sessionId && getWatcher().chatMode(sessionId)) || 'ask' } catch { return 'ask' }
  },
  trusted: ({ sessionId, agent, value }) => watcherTrusts({ sessionId, agentId: agent }, { kind: 'tool', values: [value] }, value),
  alert: ({ kind, severity, text, sessionId, agent, value }) => recordWatcherEvent({
    kind, severity, text, sessionId, agent, link: '/android',
    ...(kind === 'approval_asked' || kind === 'approval_denied' ? { action: { kind: 'tool', value } } : {}),
  }),
  emit: (event, payload) => {
    emit(event, payload)
    // Questions also reach paired phones and Mattermost (docs/approval-alerts.md).
    if (event === 'agent.approval' || event === 'agent.approval.resolved') observeApprovalAlertPhoneEvent(event, payload)
  },
  pullDir: () => join(getWebUiHome(), 'android', 'pulled'),
})
