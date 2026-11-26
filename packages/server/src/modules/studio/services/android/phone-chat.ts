/**
 * Which chat a phone tool call comes from (docs/android-devices.md, "Which chat asks").
 * The chat decides the approval mode and the trust rules, and the bell links to it.
 *
 * 1. A run credential's chat (Ekko, plugin agents, group chats): Studio issued it for that chat.
 * 2. A live turn's context id (Hermes and any agent shown Studio's turn context): only that turn knows it.
 * 3. The chat the MCP process was started for (`HERMES_STUDIO_SESSION_ID`, coding agents).
 *
 * A run credential always wins, so a run-bound agent cannot name another chat.
 */
export function phoneToolChat(input: {
  runSessionId?: string
  contextId?: string
  claimedSessionId?: string
  chatForContext: (contextId: string) => string
}): string {
  const bound = String(input.runSessionId || '').trim()
  if (bound) return bound
  const contextId = String(input.contextId || '').trim()
  if (contextId) {
    let chat = ''
    try { chat = input.chatForContext(contextId) } catch { chat = '' }
    if (chat) return chat
  }
  return String(input.claimedSessionId || '').trim()
}

/** Where a phone alert in the bell opens: a question is answered on the Android page, an outcome opens the chat that asked ('' lets the watcher link the chat). */
export function phoneAlertLink(kind: string, sessionId: string): string {
  return kind === 'approval_asked' || !sessionId ? '/android' : ''
}
