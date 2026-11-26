/**
 * What a Studio key for Omi may do (docs/omi.md). Everything else answers 403:
 * the key cannot read chats, change settings, reach Hermes, models or files.
 *
 * - start a work chat and see the work chats Omi started (`/api/studio/omi/work`,
 *   and the Orb path Omi already uses, `/api/studio/orb/work`);
 * - list the Agent work approvals in those chats (`/api/studio/omi/approvals`);
 * - approve or reject one of them (`/api/studio/agent-work/:id/approve|reject`);
 *   the controller also checks the work belongs to a chat Omi started.
 */
export const OMI_KEY_PREFIX = 'sk-studio-omi-'

const ALLOWED: Array<{ method: 'GET' | 'POST'; path: RegExp }> = [
  { method: 'GET', path: /^\/api\/studio\/(?:omi|orb)\/work\/?$/i },
  { method: 'POST', path: /^\/api\/studio\/(?:omi|orb)\/work\/?$/i },
  { method: 'GET', path: /^\/api\/studio\/omi\/approvals\/?$/i },
  { method: 'POST', path: /^\/api\/studio\/agent-work\/[A-Za-z0-9_-]{1,80}\/(?:approve|reject)\/?$/i },
]

export function omiKeyAllows(method: string, path: string): boolean {
  const verb = method.toUpperCase()
  return ALLOWED.some(rule => rule.method === verb && rule.path.test(path))
}

/** The Omi key in a request: only from the Authorization header (never a URL, which ends up in logs). */
export function looksLikeOmiKey(token: string): boolean {
  return token.startsWith(OMI_KEY_PREFIX)
}
