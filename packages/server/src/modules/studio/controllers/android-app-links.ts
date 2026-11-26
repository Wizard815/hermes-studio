import type { Context } from 'koa'
import { assetLinks } from '../services/android/app-links'

/** /.well-known/assetlinks.json for the Studio Own app; 404 until a signing key is set. */
export function assetLinksJson(ctx: Context) {
  const links = assetLinks()
  if (!links) {
    ctx.status = 404
    ctx.body = { error: 'Set STUDIO_OWN_ANDROID_CERT_SHA256 to let the Studio Own app open links to this server.' }
    return
  }
  ctx.set('Cache-Control', 'public, max-age=3600')
  ctx.body = links
}
