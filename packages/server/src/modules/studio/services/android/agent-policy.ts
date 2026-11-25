// Which phone actions an agent may take on its own (docs/android-devices.md,
// "Agents on the phone"). It follows the chat's approval mode, like every
// other agent action in Studio:
//   read   (devices, screenshot, screen text, apps, notifications, pull) -> always
//   act    (tap, swipe, type, keys, open an app or URL)                  -> asks in ask mode
//   danger (shell, install/uninstall, push, and acting in settings,
//           payments or messages)                                         -> asks in ask and guarded mode
// Auto mode never asks. A watcher trust rule answers a question for you.

export type PhoneActionLevel = 'read' | 'act' | 'danger'
export type ApprovalMode = 'ask' | 'guarded' | 'auto'

export const PHONE_ACTIONS = [
  'devices', 'screenshot', 'screen', 'apps', 'notifications', 'pull',
  'tap', 'long_press', 'swipe', 'type', 'key', 'open_app', 'open_url',
  'shell', 'install', 'uninstall', 'push',
] as const
export type PhoneAction = typeof PHONE_ACTIONS[number]

const READ = new Set<PhoneAction>(['devices', 'screenshot', 'screen', 'apps', 'notifications', 'pull'])
const DANGER = new Set<PhoneAction>(['shell', 'install', 'uninstall', 'push'])

/** Apps where a tap can change settings, spend money or send something in the person's name. */
const SENSITIVE_PACKAGES: Array<[RegExp, string]> = [
  [/^com\.android\.settings$|^com\.(samsung|miui|oneplus)\.\w*settings/i, 'settings'],
  [/wallet|\.pay(ment)?s?\b|paypal|revolut|\.bank|banking|venmo|cashapp|com\.android\.vending/i, 'payments'],
  [/messaging|\.mms|\.sms|whatsapp|telegram|signal|org\.thoughtcrime|facebook\.orca|discord|slack|\.gm$|\.email|outlook|\.dialer|\.contacts/i, 'messages'],
]

/** Words on the element being used that mean money, sending, or deleting. */
const SENSITIVE_WORDS = /\b(pay|buy|purchase|order|checkout|subscribe|transfer|send|post|delete|remove|erase|reset|factory|uninstall|confirm payment)\b/i

export interface PhoneActionContext {
  action: PhoneAction
  /** The app in front when the action happens. */
  pkg?: string
  /** Text of the element the action targets (tap by id), or the URL / package opened. */
  target?: string
}

/** How risky an action is, and why (for the question and the watcher). */
export function classifyPhoneAction(context: PhoneActionContext): { level: PhoneActionLevel; reason: string } {
  const { action } = context
  if (READ.has(action)) return { level: 'read', reason: '' }
  if (DANGER.has(action)) return { level: 'danger', reason: action === 'shell' ? 'runs a shell command on the phone' : `${action}s files or apps` }
  const pkg = action === 'open_app' ? context.target || '' : context.pkg || ''
  for (const [pattern, area] of SENSITIVE_PACKAGES) {
    if (pattern.test(pkg)) return { level: 'danger', reason: `acts in ${area} (${pkg})` }
  }
  if (action === 'open_url' && /^(intent|tel|sms|smsto|mailto|market):/i.test(context.target || '')) {
    return { level: 'danger', reason: 'opens a link that can call, message or buy' }
  }
  if (context.target && SENSITIVE_WORDS.test(context.target)) {
    return { level: 'danger', reason: `presses "${context.target.slice(0, 60)}"` }
  }
  return { level: 'act', reason: '' }
}

/** Whether the person is asked first. */
export function phoneActionNeedsApproval(level: PhoneActionLevel, mode: ApprovalMode): boolean {
  if (level === 'read' || mode === 'auto') return false
  if (level === 'danger') return true
  return mode === 'ask'
}

/** What a watcher trust rule matches: `android:<serial>:<app>:<action>` (rules can use * for any part). */
export function phoneTrustValue(serial: string, pkg: string, action: PhoneAction): string {
  return `android:${serial}:${pkg || 'unknown'}:${action}`
}
