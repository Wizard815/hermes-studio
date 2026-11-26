/**
 * The herdr page is Studio's chat page in herdr mode (herdr's own UI with
 * Mission's tools docked). No Vue here: Mission's old address loads only this.
 */

/**
 * Where an old herdr link lands: Mission's `/mission/?pane=…` and Studio's
 * `?center=herdr&pane=…` both open the combined page (Studio's chat page in
 * herdr mode) on that pane.
 */
export function herdrPageHash(query: { pane?: string | null; session?: string | null } = {}): string {
  const params = new URLSearchParams({ center: 'herdr' })
  if (query.pane) params.set('pane', query.pane)
  const path = query.session ? `/hermes/session/${encodeURIComponent(query.session)}` : '/hermes/chat'
  return `#${path}?${params.toString()}`
}

/** The combined page's address from an old Mission address (its search string). */
export function missionRedirect(search: string, base = '/'): string {
  const pane = new URLSearchParams(search).get('pane')
  const root = base.replace(/\/?$/, '/')
  // index.html, not the bare root: on Mission's own port the root page is Mission.
  return `${root}index.html${herdrPageHash({ pane })}`
}
