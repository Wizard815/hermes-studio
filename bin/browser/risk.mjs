// Browser actions that need the person's OK before an agent does them:
// purchases (paying, placing an order, entering card details) and logins
// (entering a password or one-time code, pressing sign in). Everything else
// goes ahead. Judged from the page's snapshot (element role and name) and
// the page address, so it is a safety net, not a guarantee.

const LOGIN_FIELD = /\b(pass(word|code|phrase)?|pwd|pin|one[- ]?time|otp|2fa|two[- ]factor|verification code|security code|auth(entication)? code|mfa)\b/i
const LOGIN_BUTTON = /\b(log ?in|sign ?in|log ?on|sign ?on|continue with|authenticate|verify)\b/i
const PAYMENT_FIELD = /\b(card ?number|credit card|debit card|cc ?num|cvv|cvc|csc|security code|expir(y|ation)|exp(iry)? date|name on card|iban|routing number|account number|sort code)\b/i
const PURCHASE_BUTTON = /\b(buy|pay|purchase|place (my )?order|complete (my )?(order|purchase|payment)|confirm (and pay|order|payment|purchase)|submit (order|payment)|checkout|check out|subscribe|start (my )?(subscription|trial)|upgrade|donate|book now|reserve now|rent now|add (a )?payment|send (money|payment))\b/i
// Free sign-ups that share purchase words.
const NOT_PURCHASE = /\b(newsletter|mailing list|updates|notifications|channel|feed|podcast|rss|email|free (trial )?account)\b/i
const PURCHASE_PAGE = /\b(checkout|payment|billing|pay|order|cart|basket|subscribe|purchase)\b/i
const LOGIN_PAGE = /\b(login|log-in|signin|sign-in|auth|account\/?(login|signin)|sso|oauth|password)\b/i

const CLICKS = new Set(['click', 'double_click', 'right_click'])
const ENTER = /^(enter|return|numpadenter)$/i

function text(node) {
  return `${node?.name || ''} ${node?.description || ''}`.replace(/\s+/g, ' ').trim()
}

function pathOf(url) {
  try { const parsed = new URL(url); return `${parsed.hostname}${parsed.pathname}` } catch { return String(url || '') }
}

export function hostOf(url) {
  try { return new URL(url).hostname || 'this page' } catch { return 'this page' }
}

/** The page has a password field (a login form is on screen). */
function hasLoginForm(nodes) {
  return nodes.some(node => node.role === 'textbox' && LOGIN_FIELD.test(text(node)))
}

function hasPaymentForm(nodes) {
  return nodes.some(node => (node.role === 'textbox' || node.role === 'combobox' || node.role === 'spinbutton') && PAYMENT_FIELD.test(text(node)))
}

/**
 * Whether one action (an interact action, or a batch entry) is a purchase or
 * a login. Returns { kind: 'purchase' | 'login', what } or null.
 */
export function classifyBrowserAction(action, nodes = [], url = '') {
  if (!action || typeof action !== 'object') return null
  const kind = String(action.action || action.type || '')
  const target = action.ref ? nodes.find(node => node.ref === action.ref) : undefined
  const label = target ? text(target) : ''
  const path = pathOf(url)

  if (kind === 'type' || kind === 'select') {
    if (target && PAYMENT_FIELD.test(label)) return { kind: 'purchase', what: `enter card or bank details ("${label.slice(0, 60)}")` }
    if (target && LOGIN_FIELD.test(label)) return { kind: 'login', what: `enter a password or sign-in code ("${label.slice(0, 60)}")` }
    return null
  }
  if (CLICKS.has(kind) || kind === 'click_at') {
    // A click at coordinates has no element: judge by the page.
    if (!target) {
      if (kind !== 'click_at') return null
      if (hasPaymentForm(nodes) || PURCHASE_PAGE.test(path)) return { kind: 'purchase', what: 'click on a payment or checkout page' }
      if (hasLoginForm(nodes)) return { kind: 'login', what: 'click on a sign-in page' }
      return null
    }
    if (PURCHASE_BUTTON.test(label) && !NOT_PURCHASE.test(label) && (target.role === 'button' || target.role === 'link' || target.role === 'menuitem')) {
      return { kind: 'purchase', what: `press "${label.slice(0, 60)}"` }
    }
    if (LOGIN_BUTTON.test(label) && (target.role === 'button' || target.role === 'link') && (hasLoginForm(nodes) || LOGIN_PAGE.test(path))) {
      return { kind: 'login', what: `press "${label.slice(0, 60)}"` }
    }
    return null
  }
  if (kind === 'press' && ENTER.test(String(action.key || ''))) {
    // Enter submits whatever form has focus.
    const focused = nodes.find(node => node.focused)
    if (focused && PAYMENT_FIELD.test(text(focused))) return { kind: 'purchase', what: 'submit card or bank details' }
    if (focused && LOGIN_FIELD.test(text(focused))) return { kind: 'login', what: 'submit a sign-in form' }
    if (hasPaymentForm(nodes)) return { kind: 'purchase', what: 'submit a payment form' }
    return null
  }
  return null
}

/** The first risky action in a list (interact or batch). */
export function classifyBrowserActions(actions, nodes, url) {
  for (const action of actions || []) {
    const risk = classifyBrowserAction(action, nodes, url)
    if (risk) return risk
  }
  return null
}

/** Actions worth checking at all (saves a snapshot read for scrolls and waits). */
export function mayNeedApproval(actions) {
  return (actions || []).some(action => {
    const kind = String(action?.action || action?.type || '')
    return CLICKS.has(kind) || kind === 'click_at' || kind === 'type' || kind === 'select' || (kind === 'press' && ENTER.test(String(action?.key || '')))
  })
}

export const ALLOW_CHOICE = 'Allow'
export const DENY_CHOICE = "Don't allow"

export function approvalQuestion(risk, url) {
  const where = hostOf(url)
  const label = risk.kind === 'purchase' ? 'a purchase' : 'a sign-in'
  return `The agent wants to ${risk.what} on ${where}. This looks like ${label}. Allow it? (You can also take over the Screen and do it yourself.)`
}

/** Approvals last a few minutes per site and kind, so a sign-in asks once, not per field. */
export class BrowserApprovals {
  constructor(ttlMs = 10 * 60 * 1000, now = () => Date.now()) {
    this.ttlMs = ttlMs
    this.now = now
    this.granted = new Map()
  }
  key(contextId, risk, url) { return `${contextId}\u0000${risk.kind}\u0000${hostOf(url)}` }
  has(contextId, risk, url) {
    const at = this.granted.get(this.key(contextId, risk, url))
    return at !== undefined && this.now() - at < this.ttlMs
  }
  grant(contextId, risk, url) { this.granted.set(this.key(contextId, risk, url), this.now()) }
}
