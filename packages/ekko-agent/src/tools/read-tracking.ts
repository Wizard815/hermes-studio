/**
 * Tracks which absolute file paths read_file has actually read in a given
 * session, so edit_file can refuse a blind edit against a file the model
 * never looked at. Session-scoped (not global) so two concurrent
 * conversations touching the same file on disk don't cross-pollinate.
 *
 * Presence-only: this answers "was it read at all this session", not
 * "has it changed since" — good enough to catch the actual failure mode
 * (guessing at oldString from memory/assumption) without the complexity
 * of content-hash staleness tracking.
 */

const readByPathPerSession = new Map<string, Set<string>>()

// Bound total tracked sessions so a long-lived server doesn't leak memory
// across many short-lived conversations.
const MAX_TRACKED_SESSIONS = 512

function sessionKey(sessionId: string | undefined): string {
  return sessionId && sessionId.trim() ? sessionId.trim() : '__no_session__'
}

export function markFileRead(sessionId: string | undefined, absolutePath: string): void {
  const key = sessionKey(sessionId)
  let paths = readByPathPerSession.get(key)
  if (!paths) {
    paths = new Set<string>()
    readByPathPerSession.set(key, paths)
    if (readByPathPerSession.size > MAX_TRACKED_SESSIONS) {
      const oldest = readByPathPerSession.keys().next().value
      if (oldest !== undefined) readByPathPerSession.delete(oldest)
    }
  }
  paths.add(absolutePath)
}

export function wasFileRead(sessionId: string | undefined, absolutePath: string): boolean {
  return readByPathPerSession.get(sessionKey(sessionId))?.has(absolutePath) ?? false
}

/** Test-only escape hatch for isolating tests from each other's session state. */
export function _resetReadTrackingForTests(): void {
  readByPathPerSession.clear()
}
