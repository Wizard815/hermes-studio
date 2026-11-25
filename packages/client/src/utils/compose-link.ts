/**
 * `#/hermes/chat?compose=<text>` opens a new chat with the text in the composer.
 * The Studio Own Android app uses it for text shared from Omi or any other app
 * (see docs/omi.md). Nothing is sent until the person presses Send.
 */
export const COMPOSE_QUERY_KEY = 'compose'
export const MAX_COMPOSE_LENGTH = 20000

/** The text a `compose` query value carries, or null when the query has none. */
export function composeQueryText(value: unknown): string | null {
  const raw = Array.isArray(value) ? value[0] : value
  if (typeof raw !== 'string') return null
  const text = raw.slice(0, MAX_COMPOSE_LENGTH)
  // Do not leave half of a surrogate pair at the cut.
  return /[\uD800-\uDBFF]$/.test(text) && raw.length > text.length ? text.slice(0, -1) : text
}

/** The same query without `compose`, so a reload or Back does not prefill again. */
export function withoutComposeQuery<T extends Record<string, unknown>>(query: T): Omit<T, typeof COMPOSE_QUERY_KEY> {
  const { [COMPOSE_QUERY_KEY]: _removed, ...rest } = query
  return rest
}
