import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { Socket } from 'socket.io-client'
import {
  connectHerdrSocket,
  fetchHerdrStatus,
  saveHerdrSettings,
  startHerdrServer,
  type HerdrBridgeState,
  type HerdrSettings,
  type HerdrStatus,
} from '@/api/coding-agents/herdr'

/** Live herdr state for the Herdr view and the "open in herdr" actions. */
export const useHerdrStore = defineStore('herdr', () => {
  const status = ref<HerdrStatus | null>(null)
  const bridge = ref<HerdrBridgeState | null>(null)
  const loading = ref(false)
  const error = ref('')
  let socket: Socket | null = null
  let users = 0

  const enabled = computed(() => status.value?.settings.enabled === true)
  const connected = computed(() => bridge.value?.connected === true)

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

  function ensureSocket(): Socket {
    if (socket) return socket
    const owner = connectHerdrSocket()
    socket = owner
    owner.on('herdr.state', (state: HerdrBridgeState | null) => {
      if (socket === owner) bridge.value = state
    })
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

  return { status, bridge, loading, error, enabled, connected, refresh, acquire, release, updateSettings, startServer }
})
