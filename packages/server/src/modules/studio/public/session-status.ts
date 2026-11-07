import type { SessionHerdrLink, SessionListChange } from '../../../../../shared/session-state'

/**
 * Process-local hub for chat-list liveness.
 *
 * Agent modules (for example the herdr bridge) publish external pane status and
 * row changes here; the Studio session-state socket fans them out to clients.
 */
type HerdrListener = (sessionId: string) => void
type ListListener = (change: SessionListChange) => void

const herdrLinks = new Map<string, SessionHerdrLink>()
const herdrListeners = new Set<HerdrListener>()
const listListeners = new Set<ListListener>()

export function getSessionHerdrLink(sessionId: string): SessionHerdrLink | undefined {
  return herdrLinks.get(sessionId)
}

export function listSessionHerdrLinks(): Array<[string, SessionHerdrLink]> {
  return [...herdrLinks.entries()]
}

function sameLink(a?: SessionHerdrLink, b?: SessionHerdrLink): boolean {
  return a?.paneId === b?.paneId && a?.status === b?.status && a?.workspaceId === b?.workspaceId
}

/** Set or clear (null) the herdr pane linked to a chat. Only real changes notify. */
export function setSessionHerdrLink(sessionId: string, link: SessionHerdrLink | null): void {
  const previous = herdrLinks.get(sessionId)
  if (link) {
    if (sameLink(previous, link)) return
    herdrLinks.set(sessionId, { ...link })
  } else {
    if (!previous) return
    herdrLinks.delete(sessionId)
  }
  for (const listener of herdrListeners) listener(sessionId)
}

export function onSessionHerdrLinkChanged(listener: HerdrListener): () => void {
  herdrListeners.add(listener)
  return () => herdrListeners.delete(listener)
}

export function notifySessionListChanged(change: SessionListChange): void {
  for (const listener of listListeners) {
    try { listener(change) } catch { /* listeners must not break writers */ }
  }
}

export function onSessionListChanged(listener: ListListener): () => void {
  listListeners.add(listener)
  return () => listListeners.delete(listener)
}

/** Test helper: drop all links and listeners. */
export function resetSessionStatusHub(): void {
  herdrLinks.clear()
  herdrListeners.clear()
  listListeners.clear()
}
