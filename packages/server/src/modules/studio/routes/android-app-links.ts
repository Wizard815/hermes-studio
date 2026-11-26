import Router from '@koa/router'
import * as ctrl from '../controllers/android-app-links'

/** Public: Android fetches it without signing in to verify the Studio Own app's links. */
export const androidAppLinkRoutes = new Router()

androidAppLinkRoutes.get('/.well-known/assetlinks.json', ctrl.assetLinksJson)
