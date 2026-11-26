import { onBeforeUnmount, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useChatStore } from '@/stores/hermes/chat'
import { parseStudioOwnShare, pendingComposerShare, shareFilesToFiles } from '@/utils/studio-own-share'

declare global {
  interface Window { __studioOwnShare?: unknown }
}

/**
 * Takes what the Studio Own app shared (see utils/studio-own-share.ts): a new
 * chat, or the chat that is open, with the text and images in its input. Nothing
 * is sent until the person presses Send.
 */
export function useStudioOwnShare(): void {
  const router = useRouter()

  async function take(raw: unknown) {
    const share = parseStudioOwnShare(raw)
    if (!share) return
    const chatStore = useChatStore()
    if (share.mode === 'new' || !chatStore.activeSessionId) chatStore.newChat()
    const current = router.currentRoute.value.name
    if (current !== 'hermes.chat' && current !== 'hermes.session') await router.push({ name: 'hermes.chat' })
    pendingComposerShare.value = { text: share.text, files: shareFilesToFiles(share.files) }
  }

  function pending() {
    const raw = window.__studioOwnShare
    if (raw === undefined) return
    window.__studioOwnShare = undefined
    void take(raw)
  }

  onMounted(() => {
    window.addEventListener('studio-own-share', pending)
    pending()
  })
  onBeforeUnmount(() => window.removeEventListener('studio-own-share', pending))
}
