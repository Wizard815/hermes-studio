import { join } from 'node:path'
import { getWebUiHome } from '../modules/studio/public/config'
import { configureOrbClient } from '../modules/studio/services/orb/client'
import { configureOrbWork } from '../modules/studio/services/orb/work'

/** Pondering Orb: its connection settings and the Studio chats working on Orb tasks. */
export function startOrbIntegration(): { close: () => void } {
  const home = getWebUiHome()
  configureOrbClient(join(home, 'orb', 'settings.json'))
  const work = configureOrbWork(join(home, 'orb', 'work.json'))
  return { close: () => work.close() }
}
