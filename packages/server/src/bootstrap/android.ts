import { join } from 'node:path'
import type { Server } from 'socket.io'
import { getWebUiHome } from '../modules/studio/public/config'
import { logger } from '../modules/studio/public/logging'
import { androidDeviceManager } from '../modules/studio/services/android/manager'
import { setupAndroidDeviceSocket } from '../modules/studio/sockets/android-devices'

/** Loads Android device settings and serves the `/android` socket. Never blocks startup on adb. */
export function startAndroidDevices(io: Server): { close: () => void } {
  void androidDeviceManager
    .configure(join(getWebUiHome(), 'android', 'settings.json'), message => logger.info(message))
    .catch(error => logger.warn(error, '[android] settings failed to load'))
  return setupAndroidDeviceSocket(io)
}
