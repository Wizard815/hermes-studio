import { onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { useSessionSearch } from './useSessionSearch'

/** The chat center mod+shift+H swaps to: the opposite of the saved one. */
export function nextChatCenter(): 'chat' | 'herdr' {
  try { return localStorage.getItem('studio_chat_center') === 'herdr' ? 'chat' : 'herdr' } catch { return 'herdr' }
}

export function useKeyboard() {
  const router = useRouter()
  const { sessionSearchOpen, openSessionSearch, closeSessionSearch } = useSessionSearch()

  function handleKeydown(e: KeyboardEvent) {
    const mod = e.ctrlKey || e.metaKey

    if (mod && e.key === 'n') {
      e.preventDefault()
      void import('@/stores/hermes/chat').then(({ useChatStore }) => {
        useChatStore().newChat()
      })
      return
    }

    if (mod && e.key === 'j') {
      e.preventDefault()
      router.push({ name: 'hermes.jobs' })
      return
    }

    if (mod && e.key === ',') {
      if (router.currentRoute.value.name === 'login') return
      e.preventDefault()
      router.push({ name: 'hermes.settings' })
      return
    }

    if (mod && e.key.toLowerCase() === 'k') {
      if (router.currentRoute.value.name === 'login') return
      e.preventDefault()
      openSessionSearch()
      return
    }

    // Swap the chat center between Chat and herdr (the Chat | herdr switch),
    // from anywhere in Studio. ChatPanel applies ?center and clears it from
    // the URL, so this works on the chat page and jumps there from elsewhere.
    if (mod && e.shiftKey && e.key.toLowerCase() === 'h') {
      const route = router.currentRoute.value
      if (route.name === 'login') return
      e.preventDefault()
      const onChat = route.name === 'hermes.chat' || route.name === 'hermes.session'
      void router.push(onChat
        ? { query: { ...route.query, center: nextChatCenter() } }
        : { name: 'hermes.chat', query: { center: nextChatCenter() } })
      return
    }

    if (e.key === 'Escape') {
      if (sessionSearchOpen.value) {
        e.preventDefault()
        closeSessionSearch()
        return
      }
      // Close any open modals — naive-ui handles this internally
      const modal = document.querySelector('.n-modal-mask')
      if (modal) {
        const closeBtn = modal.querySelector('.n-base-close') as HTMLElement
        closeBtn?.click()
      }
    }
  }

  onMounted(() => {
    window.addEventListener('keydown', handleKeydown)
  })

  onUnmounted(() => {
    window.removeEventListener('keydown', handleKeydown)
  })
}
