import { openSessionInHerdr, returnHerdrSession } from '@/api/coding-agents/herdr'
import { herdrPageHash } from '@/utils/herdr-page-url'
import { useHerdrStore } from '@/stores/hermes/herdr'

/**
 * Elevate a Studio chat to herdr: its herdr space is made and its agent
 * starts (or resumes) there, then the herdr page (Studio's chat page in herdr
 * mode) shows it. The header's "Elevate to herdr" button, the chat list's
 * right-click menu and the `/herdr` command all do this. Opening a chat that
 * is already elevated only shows it.
 */
export async function openChatInHerdr(sessionId: string): Promise<void> {
  const { link } = await openSessionInHerdr(sessionId)
  try { useHerdrStore().noteElevated(sessionId, true) } catch { /* no store (tests) */ }
  window.location.assign(herdrPageHash({ pane: link.paneId, session: sessionId }))
}

/**
 * Return an elevated chat to Studio: its herdr space closes (its agent stops
 * the normal way), the chat keeps its history and runs in Studio again. The
 * header menu's "Return to Studio", the right-click menu and `/studio` do this.
 */
export async function returnChatToStudio(sessionId: string): Promise<void> {
  await returnHerdrSession(sessionId)
  try {
    const store = useHerdrStore()
    store.noteElevated(sessionId, false)
    void store.refresh().catch(() => undefined)
  } catch { /* no store (tests) */ }
}
