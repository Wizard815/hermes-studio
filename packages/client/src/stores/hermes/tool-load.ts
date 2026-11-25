import { ref } from 'vue'
import { defineStore } from 'pinia'
import { dismissChatToolLoad, fetchChatToolLoad, fetchHermesToolSearch } from '@/api/studio/tool-load'
import type { ToolLoadNotice } from '../../../../shared/tool-load'

/**
 * Too many tools for a small model (docs/hermes-tool-load.md): each chat's notice,
 * from the chat's `session.command` event (action `tool_load`) or loaded when the
 * chat opens, until the user dismisses it.
 */
export const useToolLoadStore = defineStore('toolLoad', () => {
  const notices = ref(new Map<string, ToolLoadNotice | null>())

  function set(sessionId: string, notice: ToolLoadNotice | null) {
    const next = new Map(notices.value)
    next.set(sessionId, notice)
    notices.value = next
  }

  async function load(sessionId: string) {
    if (!sessionId || notices.value.has(sessionId)) return
    try {
      const { notice } = await fetchChatToolLoad(sessionId)
      if (!notices.value.has(sessionId)) set(sessionId, notice)
    } catch { /* no notice: nothing to show */ }
  }

  /**
   * The saved notice keeps the tool search value from when it was made. When the notice
   * is shown, read the profile's current value, so a chat whose profile already turned
   * tool search off does not offer to turn it off again.
   */
  async function refreshToolSearch(sessionId: string) {
    const notice = notices.value.get(sessionId)
    if (!notice || notice.dismissed) return
    try {
      const toolSearch = await fetchHermesToolSearch(notice.profile)
      const current = notices.value.get(sessionId)
      if (current && current.toolSearch !== toolSearch) set(sessionId, { ...current, toolSearch })
    } catch { /* keep the saved value */ }
  }

  function active(sessionId: string): ToolLoadNotice | null {
    const notice = notices.value.get(sessionId)
    return notice && !notice.dismissed ? notice : null
  }

  async function dismiss(sessionId: string) {
    const current = notices.value.get(sessionId)
    if (current) set(sessionId, { ...current, dismissed: true })
    await dismissChatToolLoad(sessionId)
  }

  return { notices, set, load, refreshToolSearch, active, dismiss }
})
