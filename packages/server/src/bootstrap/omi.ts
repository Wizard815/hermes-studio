import { join } from 'node:path'
import { getWebUiHome } from '../modules/studio/public/config'
import { logger } from '../modules/studio/public/logging'
import { issueModelRunJwt } from '../modules/studio/public/auth'
import { configureOmi } from '../modules/studio/services/omi'
import { setOmiKeyLookup } from '../modules/studio/services/omi/key-auth'

/** Omi (Connections → Omi, docs/omi.md): its settings, its Studio keys and its results webhook. Needs Orb work first. */
export function startOmiIntegration(): { close: () => void } {
  const omi = configureOmi(join(getWebUiHome(), 'omi', 'settings.json'), issueModelRunJwt)
  setOmiKeyLookup(async token => {
    const key = await omi.authenticate(token)
    return key ? { id: key.id, name: key.name, userId: key.userId } : null
  })
  void omi.start().catch(error => logger.warn({ err: error }, '[omi] not started'))
  return { close: () => setOmiKeyLookup(null) }
}
