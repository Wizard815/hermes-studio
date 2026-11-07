import Router from '@koa/router'
import * as ctrl from '../controllers/android-devices'
import { requireSuperAdmin } from '../public/auth'

/** adb controls whole devices (install, input, screenshots): every route is super-admin only. */
export const androidDeviceRoutes = new Router()

androidDeviceRoutes.get('/api/studio/android', requireSuperAdmin, ctrl.status)
androidDeviceRoutes.put('/api/studio/android/settings', requireSuperAdmin, ctrl.updateSettings)
androidDeviceRoutes.post('/api/studio/android/connect', requireSuperAdmin, ctrl.connect)
androidDeviceRoutes.post('/api/studio/android/pair', requireSuperAdmin, ctrl.pair)
androidDeviceRoutes.post('/api/studio/android/avds/:name/start', requireSuperAdmin, ctrl.startAvd)
androidDeviceRoutes.post('/api/studio/android/devices/:serial/disconnect', requireSuperAdmin, ctrl.disconnect)
androidDeviceRoutes.post('/api/studio/android/devices/:serial/stop', requireSuperAdmin, ctrl.stopEmulator)
androidDeviceRoutes.post('/api/studio/android/devices/:serial/install', requireSuperAdmin, ctrl.installApk)
androidDeviceRoutes.post('/api/studio/android/devices/:serial/launch', requireSuperAdmin, ctrl.launch)
androidDeviceRoutes.post('/api/studio/android/devices/:serial/input', requireSuperAdmin, ctrl.gesture)
androidDeviceRoutes.get('/api/studio/android/devices/:serial/screenshot', requireSuperAdmin, ctrl.screenshot)
