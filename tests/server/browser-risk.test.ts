import { describe, expect, it } from 'vitest'
// @ts-expect-error plain ESM helper shipped with the MCP server
import { BrowserApprovals, approvalQuestion, classifyBrowserAction, classifyBrowserActions, mayNeedApproval } from '../../bin/browser/risk.mjs'

const login = [
  { ref: '@e1', role: 'textbox', name: 'Email' },
  { ref: '@e2', role: 'textbox', name: 'Password' },
  { ref: '@e3', role: 'button', name: 'Sign in' },
  { ref: '@e4', role: 'link', name: 'Forgot your password?' },
]
const checkout = [
  { ref: '@e1', role: 'textbox', name: 'Card number' },
  { ref: '@e2', role: 'textbox', name: 'CVC' },
  { ref: '@e3', role: 'button', name: 'Place order' },
  { ref: '@e4', role: 'button', name: 'Apply coupon' },
  { ref: '@e5', role: 'link', name: 'Continue shopping' },
]
const article = [
  { ref: '@e1', role: 'link', name: 'Read more' },
  { ref: '@e2', role: 'textbox', name: 'Search' },
  { ref: '@e3', role: 'button', name: 'Subscribe to newsletter' },
]

describe('browser purchases and sign-ins need the person', () => {
  it('stops sign-ins: typing a password, pressing sign in, Enter in the password field', () => {
    expect(classifyBrowserAction({ action: 'type', ref: '@e2', text: 'x' }, login, 'https://site.test/login')).toMatchObject({ kind: 'login' })
    expect(classifyBrowserAction({ action: 'click', ref: '@e3' }, login, 'https://site.test/login')).toMatchObject({ kind: 'login' })
    expect(classifyBrowserAction({ action: 'press', key: 'Enter' }, login.map(node => node.ref === '@e2' ? { ...node, focused: true } : node), 'https://site.test/login')).toMatchObject({ kind: 'login' })
  })

  it('lets ordinary steps on a login page through', () => {
    expect(classifyBrowserAction({ action: 'type', ref: '@e1', text: 'me@site.test' }, login, 'https://site.test/login')).toBeNull()
    expect(classifyBrowserAction({ action: 'click', ref: '@e4' }, login, 'https://site.test/login')).toBeNull()
  })

  it('stops purchases: card details and order buttons', () => {
    expect(classifyBrowserAction({ action: 'type', ref: '@e1', text: '4242' }, checkout, 'https://shop.test/checkout')).toMatchObject({ kind: 'purchase' })
    expect(classifyBrowserAction({ action: 'click', ref: '@e3' }, checkout, 'https://shop.test/checkout')).toMatchObject({ kind: 'purchase' })
    expect(classifyBrowserAction({ action: 'click_at', x: 10, y: 10 }, [], 'https://shop.test/checkout/pay')).toMatchObject({ kind: 'purchase' })
    expect(classifyBrowserAction({ action: 'press', key: 'Enter' }, checkout, 'https://shop.test/checkout')).toMatchObject({ kind: 'purchase' })
  })

  it('lets browsing, searching and coupons through', () => {
    expect(classifyBrowserAction({ action: 'click', ref: '@e4' }, checkout, 'https://shop.test/checkout')).toBeNull()
    expect(classifyBrowserAction({ action: 'click', ref: '@e5' }, checkout, 'https://shop.test/checkout')).toBeNull()
    expect(classifyBrowserAction({ action: 'click', ref: '@e1' }, article, 'https://news.test/a')).toBeNull()
    expect(classifyBrowserAction({ action: 'type', ref: '@e2', text: 'cats' }, article, 'https://news.test/a')).toBeNull()
    expect(classifyBrowserAction({ action: 'click', ref: '@e3' }, article, 'https://news.test/a')).toBeNull()
    expect(classifyBrowserAction({ action: 'click', ref: '@e1' }, [{ ref: '@e1', role: 'button', name: 'Subscribe for $9/month' }], 'https://news.test/plans')).toMatchObject({ kind: 'purchase' })
    expect(classifyBrowserAction({ action: 'scroll', direction: 'down' }, checkout, 'https://shop.test/checkout')).toBeNull()
  })

  it('checks every action of a batch and skips reads', () => {
    expect(classifyBrowserActions([{ action: 'type', ref: '@e1', text: 'me' }, { action: 'click', ref: '@e3' }], login, 'https://site.test/login')).toMatchObject({ kind: 'login' })
    expect(mayNeedApproval([{ action: 'scroll', direction: 'down' }, { action: 'hover', ref: '@e1' }])).toBe(false)
    expect(mayNeedApproval([{ action: 'press', key: 'Enter' }])).toBe(true)
  })

  it('asks once per site and kind for a while', () => {
    let now = 0
    const approvals = new BrowserApprovals(1000, () => now)
    const risk = { kind: 'login', what: 'press "Sign in"' }
    expect(approvals.has('c1', risk, 'https://site.test/login')).toBe(false)
    approvals.grant('c1', risk, 'https://site.test/login')
    expect(approvals.has('c1', risk, 'https://site.test/account')).toBe(true)
    expect(approvals.has('c1', { kind: 'purchase', what: '' }, 'https://site.test/x')).toBe(false)
    expect(approvals.has('c2', risk, 'https://site.test/login')).toBe(false)
    now = 2000
    expect(approvals.has('c1', risk, 'https://site.test/login')).toBe(false)
    expect(approvalQuestion(risk, 'https://site.test/login')).toContain('site.test')
  })
})
