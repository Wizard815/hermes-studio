import { onBeforeUnmount, ref } from 'vue'
import { cleanLogLine, getActionStatus, type MaintenanceAction } from '@/api/hermes/agent-tools'

/**
 * Starts one of Hermes's background commands (health check, audit, backup…)
 * and follows its output until it ends.
 */
export function useHermesAction(name: MaintenanceAction, intervalMs = 1500) {
  const running = ref(false)
  const lines = ref<string[]>([])
  const exitCode = ref<number | null>(null)
  const error = ref('')
  const finished = ref(false)
  let timer: ReturnType<typeof setTimeout> | null = null
  let stopped = false

  async function poll() {
    try {
      const status = await getActionStatus(name)
      lines.value = (status.lines || []).map(cleanLogLine)
      exitCode.value = status.exit_code
      if (status.running) {
        if (!stopped) timer = setTimeout(poll, intervalMs)
        return
      }
      running.value = false
      finished.value = true
    } catch (err: any) {
      error.value = err?.message || String(err)
      running.value = false
    }
  }

  async function run(start: () => Promise<unknown>): Promise<boolean> {
    if (timer) clearTimeout(timer)
    running.value = true
    finished.value = false
    error.value = ''
    lines.value = []
    exitCode.value = null
    try {
      await start()
    } catch (err: any) {
      error.value = err?.message || String(err)
      running.value = false
      return false
    }
    // The command is spawned in the background; its log fills in shortly after.
    timer = setTimeout(poll, 600)
    return true
  }

  onBeforeUnmount(() => {
    stopped = true
    if (timer) clearTimeout(timer)
  })

  return { running, lines, exitCode, error, finished, run }
}
