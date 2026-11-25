import { omiKeyAllows } from './scope'

/**
 * Signs a request in with a Studio key made for Omi (docs/omi.md). The auth
 * middleware calls this; bootstrap points it at the Omi service, so the
 * middleware does not load the Omi service and what it depends on.
 */
export interface OmiKeyIdentity { id: string; name: string; userId: number }

type Lookup = (token: string) => Promise<OmiKeyIdentity | null>
let lookup: Lookup | null = null

export function setOmiKeyLookup(next: Lookup | null): void {
  lookup = next
}

export type OmiKeyCheck =
  | { ok: true; key: OmiKeyIdentity }
  | { ok: false; status: 401 | 403; error: string }

export async function checkOmiKey(input: { method: string; path: string; headerToken: string; token: string }): Promise<OmiKeyCheck> {
  if (!omiKeyAllows(input.method, input.path)) {
    return { ok: false, status: 403, error: "This key is for Omi: it can only start and follow Omi's work chats and answer their approvals." }
  }
  if (input.headerToken !== input.token) return { ok: false, status: 401, error: 'Send the Omi key in the Authorization header.' }
  const key = lookup ? await lookup(input.token) : null
  if (!key) return { ok: false, status: 401, error: 'This Omi key is not valid any more. Make a new one in Studio: Connections → Omi.' }
  return { ok: true, key }
}
