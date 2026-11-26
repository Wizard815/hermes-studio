import { getTestLab } from '../services/test-lab'

/** Test Lab (docs/test-lab.md): at startup, end runs cut short by a restart and remove left-behind runs older than a day. */
export async function sweepTestLab(): Promise<void> {
  try {
    const { removed } = await getTestLab().sweep()
    if (removed.length) console.log(`[test-lab] removed ${removed.length} left-behind run(s): ${removed.join(', ')}`)
  } catch (error) {
    console.warn(`[test-lab] startup sweep failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export function closeTestLab(): void {
  try { getTestLab().close() } catch { /* never started */ }
}
