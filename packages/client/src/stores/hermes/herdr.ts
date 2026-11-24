import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import type { Socket } from 'socket.io-client'
import {
  connectHerdrSocket,
  fetchHerdrStatus,
  gunzipState,
  saveHerdrSettings,
  startHerdrServer,
  type HerdrBridgeState,
  type HerdrSettings,
  type HerdrStatus,
} from '@/api/coding-agents/herdr'
import { useProfilesStore } from './profiles'

/** Live herdr state for the Herdr view and the "open in herdr" actions. */
export const useHerdrStore = defineStore('herdr', () => {
  const status = ref<HerdrStatus | null>(null)
  const bridge = ref<HerdrBridgeState | null>(null)
  const loading = ref(false)
  const error = ref('')
  /** Bumped when space folders change (on Studio's herdr page or in Herdr App's file). */
  const foldersVersion = ref(0)
  let socket: Socket | null = null
  let users = 0

  const enabled = computed(() => status.value?.settings.enabled === true)
  const connected = computed(() => bridge.value?.connected === true)
  /** Chats elevated to herdr; null until herdr's state is known (or from an older server). */
  const elevatedChats = computed<Set<string> | null>(() => (Array.isArray(bridge.value?.elevatedChats) ? new Set(bridge.value!.elevatedChats) : null))
  function isElevated(sessionId: string | null | undefined): boolean {
    return !!sessionId && !!elevatedChats.value?.has(sessionId)
  }
  /** Mark a chat elevated or not at once (the server's state follows). */
  function noteElevated(sessionId: string, elevated: boolean) {
    if (!bridge.value) return
    const list = new Set(bridge.value.elevatedChats || [])
    if (elevated) list.add(sessionId)
    else list.delete(sessionId)
    bridge.value = { ...bridge.value, elevatedChats: [...list] }
  }

  async function refresh() {
    loading.value = true
    try {
      status.value = await fetchHerdrStatus()
      bridge.value = status.value.bridge
      error.value = ''
    } catch (err: any) {
      error.value = err?.message || String(err)
    } finally {
      loading.value = false
    }
  }

  // herdr follows the profile picked in Studio: the status request carries it
  // (X-Hermes-Profile), so tell the server as soon as it changes.
  watch(() => useProfilesStore().activeProfileName, (name, previous) => {
    if (status.value && name && name !== previous) void refresh()
  })

  function ensureSocket(): Socket {
    if (socket) return socket
    const owner = connectHerdrSocket()
    socket = owner
    // States apply in the order they came, gzipped ones included (unzipping is async).
    let queue: Promise<unknown> = Promise.resolve()
    const apply = (next: () => Promise<HerdrBridgeState | null> | HerdrBridgeState | null) => {
      queue = queue.then(next).then(state => { if (socket === owner) bridge.value = state }, () => undefined)
    }
    owner.on('herdr.state', (state: HerdrBridgeState | null) => apply(() => state))
    owner.on('herdr.state.gz', (payload: ArrayBuffer) => apply(() => gunzipState(payload)))
    owner.on('herdr.folders', () => { foldersVersion.value += 1 })
    return owner
  }

  /** Reference-counted: the socket stays open while any view uses it. */
  function acquire(): Socket {
    users += 1
    return ensureSocket()
  }

  function release() {
    users = Math.max(0, users - 1)
    if (users > 0 || !socket) return
    socket.removeAllListeners()
    socket.disconnect()
    socket = null
  }

  async function updateSettings(patch: Partial<HerdrSettings>) {
    const { settings } = await saveHerdrSettings(patch)
    if (status.value) status.value = { ...status.value, settings }
    await refresh()
  }

  async function startServer() {
    status.value = await startHerdrServer()
    bridge.value = status.value.bridge
  }

  return { status, bridge, loading, error, foldersVersion, enabled, connected, elevatedChats, isElevated, noteElevated, refresh, acquire, release, updateSettings, startServer }
})
