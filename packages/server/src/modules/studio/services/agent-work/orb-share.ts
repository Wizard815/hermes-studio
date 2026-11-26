import type { AgentActivity, AgentWork } from './store'
import type { OrbClient } from '../orb/client'

/**
 * What Studio shares with Pondering Orb when "Share agent activity with
 * Pondering Orb" is on: each activity entry (orb_studio_activity) and approval
 * requests as Orb alerts that Orb clears once the work is decided anywhere
 * (orb_studio_approval). With the switch off nothing is sent.
 */
export interface OrbSharePort {
  connected(): Promise<boolean>
  activity(work: AgentWork, entry: AgentActivity): Promise<void>
  approval(work: AgentWork): Promise<void>
}

export function approvalState(work: AgentWork): 'pending' | 'approved' | 'rejected' | 'withdrawn' {
  if (work.decision === 'approved') return 'approved'
  if (work.decision === 'rejected') return 'rejected'
  return work.status === 'awaiting_approval' ? 'pending' : 'withdrawn'
}

export class OrbShare implements OrbSharePort {
  constructor(private readonly client: () => OrbClient) {}

  async connected(): Promise<boolean> {
    try { return !!(await this.client().publicSettings()).url } catch { return false }
  }

  async activity(work: AgentWork, entry: AgentActivity): Promise<void> {
    await this.client().tool('orb_studio_activity', {
      id: `${entry.id}`,
      workId: work.id,
      title: work.title,
      status: work.status,
      kind: entry.kind,
      message: entry.message,
      via: entry.via,
      actor: entry.actor,
      at: entry.at,
      ...(work.vikunjaTaskId ? { vikunjaTaskId: work.vikunjaTaskId } : {}),
      ...(work.agent ? { agent: work.agent } : {}),
    })
  }

  async approval(work: AgentWork): Promise<void> {
    await this.client().tool('orb_studio_approval', {
      workId: work.id,
      title: work.title,
      summary: work.summary,
      state: approvalState(work),
      ...(work.decidedVia ? { via: work.decidedVia } : {}),
      ...(work.decidedBy ? { by: work.decidedBy } : {}),
      ...(work.vikunjaTaskId ? { vikunjaTaskId: work.vikunjaTaskId } : {}),
      ...(work.agent ? { agent: work.agent } : {}),
    })
  }
}
