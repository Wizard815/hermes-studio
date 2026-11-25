import Router from '@koa/router'
import type { Context, Next } from 'koa'
import { requireSuperAdmin } from '../middleware/auth'
import * as ctrl from '../controllers/approval-alerts'

/**
 * Where approvals reach you (docs/approval-alerts.md). Settings and pairing
 * are super-admin only, each for their own choice and phones. The device
 * routes take only a paired phone's key (the auth middleware enforces it,
 * services/approval-alerts/scope.ts); the pairing exchange is public, its
 * one-use code is the secret.
 */
export const approvalAlertRoutes = new Router()

/** Only a phone key reaches the device routes; a browser login gets 403 there. */
async function requirePhoneKey(ctx: Context, next: Next) {
  if (!ctx.state.phoneKey) { ctx.status = 403; ctx.body = { error: 'Only a paired phone can use this. Pair one in Settings → Android app.' }; return }
  await next()
}

approvalAlertRoutes.get('/api/studio/approval-alerts', requireSuperAdmin, ctrl.status)
approvalAlertRoutes.put('/api/studio/approval-alerts/prefs', requireSuperAdmin, ctrl.savePrefs)
approvalAlertRoutes.post('/api/studio/approval-alerts/pairing', requireSuperAdmin, ctrl.startPairing)
approvalAlertRoutes.delete('/api/studio/approval-alerts/devices/:id', requireSuperAdmin, ctrl.removeDevice)
approvalAlertRoutes.post('/api/studio/approval-alerts/test', requireSuperAdmin, ctrl.sendTest)

approvalAlertRoutes.get('/api/studio/approval-alerts/device', requirePhoneKey, ctrl.deviceStatus)
approvalAlertRoutes.get('/api/studio/approval-alerts/device/approvals', requirePhoneKey, ctrl.deviceApprovals)
approvalAlertRoutes.get('/api/studio/approval-alerts/device/stream', requirePhoneKey, ctrl.deviceStream)
approvalAlertRoutes.post('/api/studio/approval-alerts/device/approvals/:id/approve', requirePhoneKey, ctrl.deviceApprove)
approvalAlertRoutes.post('/api/studio/approval-alerts/device/approvals/:id/reject', requirePhoneKey, ctrl.deviceReject)

export const approvalAlertPublicRoutes = new Router()
approvalAlertPublicRoutes.post('/api/studio/approval-alerts/pair', ctrl.pair)
