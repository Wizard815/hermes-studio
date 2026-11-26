import { missionRedirect } from '@/utils/herdr-page-url'

/**
 * Mission's old address (/mission/?pane=…, and the root of Mission's own
 * port): Mission is now docked in Studio's herdr page, so this lands there,
 * on the same pane.
 */
window.location.replace(missionRedirect(window.location.search, import.meta.env.BASE_URL || '/'))
