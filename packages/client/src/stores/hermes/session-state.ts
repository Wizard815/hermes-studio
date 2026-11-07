import { ref, onScopeDispose } from 'vue'
import { defineStore } from 'pinia'
import { connectSessionState } from '@/api/studio/session-state'
import { onAuthInvalidated } from '@/api/auth-invalidation'
import { resolveDisplayStatus, type AgentDisplayStatus, type SessionListChange, type SessionListState, type SessionStateSnapshot } from '../../../../shared/session-state'

export const useSessionStateStore = defineStore('sessionState', () => {
  const sessions = ref(new Map<string, SessionListState>())
  let socket: ReturnType<typeof connectSessionState> | null = null
  let stopAuth: (() => void) | null = null
  const pendingReads = new Map<string, { messageId: number; attentionId: number }>()
  const connected = ref(false)
  const listListeners = new Set<(change: SessionListChange) => void>()

  /** Subscribe to chats created, updated or deleted anywhere (other tabs, MCP, herdr). */
  function onListChanged(listener: (change: SessionListChange) => void): () => void {
    listListeners.add(listener)
    return () => listListeners.delete(listener)
  }

  function start() {
    if (socket) return
    const owner = connectSessionState()
    socket = owner
    owner.on('sessions.state.snapshot', (snapshot: SessionStateSnapshot) => {
      if (socket !== owner) return
      pendingReads.clear()
      sessions.value = new Map(snapshot.sessions.map(state => [state.sessionId, state]))
    })
    owner.on('sessions.list.changed', (change: SessionListChange) => {
      if (socket !== owner || !change?.sessionId) return
      if (change.type === 'deleted') sessions.value.delete(change.sessionId)
      for (const listener of listListeners) {
        try { listener(change) } catch { /* listeners must not break the stream */ }
      }
    })
    owner.on('connect', () => { if (socket === owner) connected.value = true })
    owner.on('sessions.state.updated', (state: SessionListState) => {
      if (socket !== owner) return
      sessions.value.set(state.sessionId, state)
      const pending = pendingReads.get(state.sessionId)
      if (pending && state.readMessageId >= pending.messageId && (state.readAttentionId || 0) >= pending.attentionId) pendingReads.delete(state.sessionId)
    })
    // Do not replay buffered read receipts after a reconnect; use its fresh snapshot.
    owner.on('disconnect', () => {
      pendingReads.clear()
      if (socket === owner) connected.value = false
    })
    stopAuth = onAuthInvalidated(stop)
  }

  function stop() {
    const previous = socket
    socket = null
    previous?.removeAllListeners(); previous?.disconnect()
    stopAuth?.(); stopAuth = null
    sessions.value.clear(); pendingReads.clear()
    connected.value = false
  }

  function markRead(sessionId: string) {
    const state = sessions.value.get(sessionId)
    if (!socket?.connected || state?.working || !state?.unread) return
    const messageId = state.lastMessageId
    const attentionId = state.lastAttentionId || 0
    const pending = pendingReads.get(sessionId)
    if (pending?.messageId === messageId && pending.attentionId === attentionId) return
    const receipt = { messageId, attentionId }
    pendingReads.set(sessionId, receipt)
    socket.emit('sessions.read', { sessionId, messageId, ...(state.lastAttentionId != null ? { attentionId } : {}) }, (result: { ok: boolean }) => {
      if (!result?.ok && pendingReads.get(sessionId) === receipt) pendingReads.delete(sessionId)
    })
  }

  onScopeDispose(stop)
  /**
   * Local stream state and server state are combined with OR: the tab that sent
   * a message knows it is working before the server's broadcast arrives, and the
   * server knows about runs this tab never saw.
   */
  function isWorking(id: string, localWorking = false): boolean {
    return localWorking || sessions.value.get(id)?.working === true
  }

  function statusOf(id: string, localWorking = false, localUnread = false): AgentDisplayStatus {
    const state = sessions.value.get(id)
    return resolveDisplayStatus({
      working: isWorking(id, localWorking),
      blocked: state?.blocked,
      unread: state ? !state.working && state.unread : localUnread,
      herdr: state?.herdr?.status,
    })
  }

  return { sessions, connected, start, stop, markRead, onListChanged, isWorking, statusOf,
    herdrLink: (id: string) => sessions.value.get(id)?.herdr,
    isUnread: (id: string, initialUnread = false) => {
      const state = sessions.value.get(id)
      return state ? !state.working && state.unread : initialUnread
    },
    backgroundCount: (id: string) => sessions.value.get(id)?.backgroundPending ?? 0 }
})
