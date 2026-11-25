import { onBeforeUnmount, onMounted, ref } from 'vue'
import type { Socket } from 'socket.io-client'
import { isStoredSuperAdmin } from '@/api/client'
import { getChatRunSocket } from '@/api/studio/chat'
import { clearWatcherEvents, fetchWatcherEvents, markAllWatcherRead, markWatcherRead } from '@/api/studio/watcher'
import type { WatcherEvent } from '../../../shared/watcher'

/**
 * The Watcher's bell (docs/watcher.md): one shared list for every bell on the
 * page (top bar, herdr's tab bar, the phone menu). Live over the chat-run
 * socket (`watcher.event`, `watcher.changed`), with a slow refresh behind it.
 */
const events = ref<WatcherEvent[]>([])
const unread = ref(0)
const available = ref(false)
const loaded = ref(false)
const failed = ref(false)
/** The list as a dialog (phone menus); WatcherModal in App.vue shows it. */
const dialogOpen = ref(false)
let users = 0
let timer = 0
let socketTimer = 0
let boundSocket: Socket | null = null

async function refresh() {
  if (!isStoredSuperAdmin()) { available.value = false; return }
  try {
    const list = await fetchWatcherEvents(50)
    events.value = list.events
    unread.value = list.unread
    available.value = true
    failed.value = false
  } catch (error: any) {
    // 403: not a super admin here; the bell stays hidden.
    if (error?.status === 403 || /403|privileges/.test(String(error?.message || ''))) available.value = false
    else failed.value = true
  } finally {
    loaded.value = true
  }
}

function onEvent(payload: { event?: WatcherEvent; unread?: number }) {
  if (payload?.event) events.value = [payload.event, ...events.value.filter(item => item.id !== payload.event!.id)].slice(0, 50)
  if (typeof payload?.unread === 'number') unread.value = payload.unread
}

function onChanged(payload: { unread?: number; rules?: boolean }) {
  if (typeof payload?.unread === 'number') unread.value = payload.unread
  if (!payload?.rules) void refresh()
}

/** The chat-run socket is replaced when the profile changes: follow it. */
function bindSocket() {
  const socket = getChatRunSocket()
  if (socket === boundSocket) return
  boundSocket?.off('watcher.event', onEvent)
  boundSocket?.off('watcher.changed', onChanged)
  boundSocket = socket
  socket?.on('watcher.event', onEvent)
  socket?.on('watcher.changed', onChanged)
}

export function useWatcher() {
  onMounted(() => {
    users++
    if (users === 1) {
      void refresh()
      timer = window.setInterval(() => { void refresh() }, 60_000)
      bindSocket()
      socketTimer = window.setInterval(bindSocket, 2_000)
    }
  })
  onBeforeUnmount(() => {
    users--
    if (users === 0) {
      window.clearInterval(timer)
      window.clearInterval(socketTimer)
      boundSocket?.off('watcher.event', onEvent)
      boundSocket?.off('watcher.changed', onChanged)
      boundSocket = null
    }
  })

  async function markRead(ids: number[]) {
    const unreadIds = ids.filter(id => events.value.some(item => item.id === id && !item.read))
    if (!unreadIds.length) return
    events.value = events.value.map(item => unreadIds.includes(item.id) ? { ...item, read: true } : item)
    unread.value = (await markWatcherRead(unreadIds)).unread
  }

  async function markAll() {
    events.value = events.value.map(item => ({ ...item, read: true }))
    unread.value = (await markAllWatcherRead()).unread
  }

  async function clear(ids?: number[]) {
    events.value = ids ? events.value.filter(item => !ids.includes(item.id)) : []
    unread.value = (await clearWatcherEvents(ids)).unread
    if (!ids) await refresh()
  }

  return { events, unread, available, loaded, failed, dialogOpen, refresh, markRead, markAll, clear }
}
