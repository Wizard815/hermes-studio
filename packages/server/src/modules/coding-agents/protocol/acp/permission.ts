import type { AgentApprovalChoice, AgentApprovalRequest } from '../../services/runtime/run-manager'
import { acpAction } from '../../services/approval-policy'

/** Ask Studio about an ACP `session/request_permission` (the agent decides when to ask). */
export type AcpAsk = (request: AgentApprovalRequest) => Promise<AgentApprovalChoice>

function toolText(toolCall: any): { title: string; command: string; key: string } {
  const raw = toolCall?.rawInput && typeof toolCall.rawInput === 'object' ? toolCall.rawInput : {}
  const command = String(raw.command ?? raw.cmd ?? raw.file_path ?? raw.path ?? raw.filePath ?? raw.url ?? '')
    || (Array.isArray(toolCall?.locations) ? toolCall.locations.map((item: any) => item?.path).filter(Boolean).join(', ') : '')
  const title = String(toolCall?.title || toolCall?.kind || 'a tool')
  const executable = typeof raw.command === 'string' ? raw.command.trim().split(/\s+/)[0] || '' : ''
  return { title, command, key: `${toolCall?.kind || 'tool'}${executable ? `:${executable}` : ''}` }
}

/**
 * The ACP result for a permission request: Studio's answer picks the agent's
 * own option. "For this chat" is remembered by Studio, so the agent is only
 * told "once" and keeps no rule of its own.
 */
export async function answerAcpPermission(params: any, agentName: string, ask: AcpAsk): Promise<any> {
  const options: any[] = Array.isArray(params?.options) ? params.options : []
  const tool = toolText(params?.toolCall)
  const choice = await ask({
    action: acpAction(params?.toolCall),
    key: tool.key,
    title: `${agentName} wants to ${tool.title}`,
    description: tool.title,
    ...(tool.command ? { command: tool.command.slice(0, 4000) } : {}),
  })
  const kinds = choice === 'deny' ? ['reject_once', 'reject_always'] : ['allow_once', 'allow_always']
  const option = kinds.map(kind => options.find(entry => entry?.kind === kind)).find(Boolean)
  return { outcome: option ? { outcome: 'selected', optionId: option.optionId } : { outcome: 'cancelled' } }
}
