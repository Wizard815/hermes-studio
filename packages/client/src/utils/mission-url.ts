import { openSessionInHerdr } from '@/api/coding-agents/herdr'
import { herdrPageHash } from '@/utils/herdr-page-url'

/**
 * Open a Studio chat in herdr (waking it into its space if it is asleep), then
 * show it on the herdr page (Studio's chat page in herdr mode, with Mission's
 * tools docked). The header's "Open in herdr" button, the chat list's
 * right-click menu and the `/herdr` command all do this.
 */
export async function openChatInHerdr(sessionId: string): Promise<void> {
  const { link } = await openSessionInHerdr(sessionId)
  window.location.assign(herdrPageHash({ pane: link.paneId, session: sessionId }))
}
