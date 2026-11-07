/** URL of the herdr Mission view, served by Studio at <base>/mission/. */
export function missionUrl(query: Record<string, string> = {}): string {
  const base = (import.meta.env.BASE_URL || '/').replace(/\/?$/, '/')
  const search = new URLSearchParams(query).toString()
  return `${base}mission/${search ? `?${search}` : ''}`
}
