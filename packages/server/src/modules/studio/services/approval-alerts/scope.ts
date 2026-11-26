import { PHONE_KEY_PREFIX } from '../../../../../../shared/approval-alerts'

/**
 * What a paired phone's key may do (docs/approval-alerts.md): read its owner's
 * pending approvals (once, or as a live stream) and answer them. Everything
 * else answers 403: the key cannot read chats, change settings or reach
 * Hermes, models or files.
 */
const ALLOWED: Array<{ method: 'GET' | 'POST'; path: RegExp }> = [
  { method: 'GET', path: /^\/api\/studio\/approval-alerts\/device\/?$/i },
  { method: 'GET', path: /^\/api\/studio\/approval-alerts\/device\/approvals\/?$/i },
  { method: 'GET', path: /^\/api\/studio\/approval-alerts\/device\/stream\/?$/i },
  { method: 'POST', path: /^\/api\/studio\/approval-alerts\/device\/approvals\/[A-Za-z0-9_-]{1,120}\/(?:approve|reject)\/?$/i },
]

export function phoneKeyAllows(method: string, path: string): boolean {
  const verb = method.toUpperCase()
  return ALLOWED.some(rule => rule.method === verb && rule.path.test(path))
}

export function looksLikePhoneKey(token: string): boolean {
  return token.startsWith(PHONE_KEY_PREFIX)
}

export interface PhoneKeyIdentity { id: string; name: string; userId: number }

type Lookup = (token: string) => PhoneKeyIdentity | null
let lookup: Lookup | null = null

/** Bootstrap points this at the approval alerts service, so the auth middleware does not load it. */
export function setPhoneKeyLookup(next: Lookup | null): void { lookup = next }

export type PhoneKeyCheck =
  | { ok: true; key: PhoneKeyIdentity }
  | { ok: false; status: 401 | 403; error: string }

export function checkPhoneKey(input: { method: string; path: string; headerToken: string; token: string }): PhoneKeyCheck {
  if (!phoneKeyAllows(input.method, input.path)) {
    return { ok: false, status: 403, error: "This key is for approval alerts on a phone: it can only read and answer its owner's approvals." }
  }
  if (input.headerToken !== input.token) return { ok: false, status: 401, error: 'Send the phone key in the Authorization header.' }
  const key = lookup ? lookup(input.token) : null
  if (!key) return { ok: false, status: 401, error: 'This phone is not paired any more. Pair it again in Studio: Settings → Android app.' }
  return { ok: true, key }
}
