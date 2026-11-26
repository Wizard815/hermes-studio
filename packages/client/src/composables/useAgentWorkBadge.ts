import { onBeforeUnmount, onMounted, ref } from 'vue'
import { fetchAgentWorkSummary } from '@/api/studio/agent-work'

/** Shared count of agent work waiting for approval (the Studio badge); cleared as soon as it is decided anywhere. */
const waiting = ref(0)
let users = 0
let timer = 0

async function refresh() {
  try { waiting.value = (await fetchAgentWorkSummary()).awaitingApproval } catch { /* signed out or not set up */ }
}

export function refreshAgentWorkBadge() { void refresh() }

export function useAgentWorkBadge() {
  onMounted(() => {
    users++
    if (users === 1) { void refresh(); timer = window.setInterval(() => { void refresh() }, 20000) }
  })
  onBeforeUnmount(() => {
    users--
    if (users === 0 && timer) { window.clearInterval(timer); timer = 0 }
  })
  return waiting
}
