import { computed, ref } from 'vue'
import { isStoredSuperAdmin } from '@/api/client'
import { listHermesPlatforms, type HermesPlatform } from '@/api/hermes/channels'
import { restartProfileGateway } from '@/api/hermes/profiles'
import { useProfilesStore } from '@/stores/hermes/profiles'
import { cleanError } from './channel-helpers'

// Shared by every Hermes piece of the Channels page (one list, one restart banner).
const platforms = ref<HermesPlatform[]>([])
const loaded = ref(false)
const loading = ref(false)
const error = ref('')
const restartNeeded = ref(false)
const restarting = ref(false)

export function useHermesChannels() {
  const profilesStore = useProfilesStore()
  const available = computed(() => isStoredSuperAdmin())
  const gatewayRunning = computed(() => platforms.value.some(p => p.gateway_running))
  const pendingRestart = computed(() => restartNeeded.value || platforms.value.some(p => p.state === 'pending_restart'))

  async function load() {
    if (!available.value) return
    loading.value = true
    try {
      platforms.value = (await listHermesPlatforms()).platforms || []
      error.value = ''
      loaded.value = true
    } catch (err) {
      error.value = cleanError(err)
    } finally {
      loading.value = false
    }
  }

  function byId(id: string) {
    return platforms.value.find(p => p.id === id)
  }

  /** Restarts the active profile's gateway the way Studio does elsewhere. */
  async function restartGateway() {
    restarting.value = true
    try {
      await restartProfileGateway(profilesStore.activeProfileName || 'default')
      restartNeeded.value = false
      // Give the adapters a moment to report in before re-reading their state.
      await new Promise(resolve => setTimeout(resolve, 2500))
      await load()
    } finally {
      restarting.value = false
    }
  }

  function markRestartNeeded(needed = true) {
    restartNeeded.value = needed
  }

  return { platforms, loaded, loading, error, available, gatewayRunning, pendingRestart, restarting, load, byId, restartGateway, markRestartNeeded }
}
