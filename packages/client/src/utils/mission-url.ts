import { openSessionInHerdr } from '@/api/coding-agents/herdr'

/** URL of the herdr Mission view, served by Studio at <base>/mission/. */
export function missionUrl(query: Record<string, string> = {}): string {
  const base = (import.meta.env.BASE_URL || '/').replace(/\/?$/, '/')
  const search = new URLSearchParams(query).toString()
  return `${base}mission/${search ? `?${search}` : ''}`
}

/**
 * Open a Studio chat in herdr (waking it into its space if it is asleep), then
 * go to its pane in the Mission view. The header's "Open in herdr" button, the
 * chat list's right-click menu and the `/herdr` command all do this.
 */
export async function openChatInHerdr(sessionId: string): Promise<void> {
  const { link } = await openSessionInHerdr(sessionId)
  // The Mission view is a separate page on Studio's origin (same tunnel port).
  window.location.assign(missionUrl({ pane: link.paneId }))
}
