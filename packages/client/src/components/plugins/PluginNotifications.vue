<script setup lang="ts">
import { watch, onBeforeUnmount } from 'vue'
import { useRoute } from 'vue-router'
import { useMessage } from 'naive-ui'
import { hasApiKey } from '@/api/client'
import { useProfilesStore } from '@/stores/hermes/profiles'
import { pluginRequest, type PluginEvent } from '@/api/studio/plugins'

const route = useRoute(), profiles = useProfilesStore(), messages = useMessage()
let stop: (() => void) | undefined
const FAST_MS = 2000, SLOW_MS = 15_000
watch(() => [profiles.activeProfileName, route.meta.public] as const, () => {
  stop?.()
  if (!hasApiKey() || route.meta.public) return
  const profile = profiles.activeProfileName || 'default', controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined, delay = FAST_MS, cursor = 0, generation = '', initialized = false, busy = false
  async function poll() {
    if (busy) return
    busy = true
    try {
      const result = await pluginRequest<{ cursor: number; generation: string; events: Array<PluginEvent & { pluginId: string }> }>(profile, `/events?cursor=${cursor}`, undefined, 'GET', controller.signal)
      if (initialized && (generation !== result.generation || result.events.some(event => event.type === 'plugin.changed'))) window.dispatchEvent(new Event('studio.plugins.changed'))
      if (initialized && generation === result.generation) for (const event of result.events) {
        if (event.type !== 'ui.notification' || !event.data || typeof event.data !== 'object' || Array.isArray(event.data)) continue
        const level = event.data.level === 'success' || event.data.level === 'error' ? event.data.level : 'info'
        messages[level](`${event.pluginId}: ${String(event.data.message || '').slice(0, 2000)}`)
      }
      cursor = result.cursor; generation = result.generation; initialized = true
      // Something happened: check again soon. Quiet: back off to 15 s.
      delay = result.events.length ? FAST_MS : Math.min(Math.round(delay * 1.5), SLOW_MS)
    } catch { /* Authentication and reconnect errors are handled by the shared API client. */ }
    busy = false
    schedule()
  }
  // A hidden tab does not poll; showing it again checks at once.
  function schedule() {
    if (timer) clearTimeout(timer)
    timer = undefined
    if (!controller.signal.aborted && document.visibilityState === 'visible') timer = setTimeout(poll, delay)
  }
  function visibility() {
    if (document.visibilityState !== 'visible' || controller.signal.aborted) return
    delay = FAST_MS
    if (timer) clearTimeout(timer)
    timer = undefined
    void poll()
  }
  document.addEventListener('visibilitychange', visibility)
  stop = () => { controller.abort(); if (timer) clearTimeout(timer); document.removeEventListener('visibilitychange', visibility) }
  void poll()
}, { immediate: true })
onBeforeUnmount(() => stop?.())
</script>
<template><span hidden aria-hidden="true" /></template>
