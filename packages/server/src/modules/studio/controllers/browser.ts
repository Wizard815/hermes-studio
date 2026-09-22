import type { Context, Next } from 'koa'
import { getHeadlessBrowserService } from './services/headless-browser-service'

// ---------------------------------------------------------------------------
// Browser Controller — REST endpoints for the headless browser service
// ---------------------------------------------------------------------------

function handleError(ctx: Context, err: Error | any) {
  const code = (err as any)?.code || 'unknown'
  ctx.status = 
    code === 'not_found' ? 404 :
    code === 'concurrent_operation' ? 409 :
    code === 'tab_full' ? 413 : 500
  
  ctx.body = { error: err.message || 'Browser operation failed', code }
}

// ─── Tab Management ────────────────────────────────────────────────

export async function getState(ctx: Context, next: Next) {
  try {
    const service = getHeadlessBrowserService()
    if (!service) {
      ctx.status = 503
      ctx.body = { available: false }
      return await next()
    }
    
    ctx.body = await service.getState()
  } catch (err: any) {
    handleError(ctx, err)
  }
}

export async function createTab(ctx: Context, next: Next) {
  try {
    const service = getHeadlessBrowserService()
    if (!service) {
      ctx.status = 503
      ctx.body = { available: false }
      return await next()
    }
    
    const url = typeof ctx.request.body?.url === 'string' && ctx.request.body.url ? ctx.request.body.url : null
    const activate = ctx.request.body?.activate !== false
    
    const tab = await service._createTab(url, activate)
    ctx.body = service.toPublicTab(tab)
  } catch (err: any) {
    handleError(ctx, err)
  }
}

export async function activateTab(ctx: Context, next: Next) {
  const tabId = ctx.request.body?.tab_id
  
  if (!tabId || typeof tabId !== 'string') {
    ctx.status = 400
    ctx.body = { error: 'tab_id is required' }
    return await next()
  }
  
  try {
    const service = getHeadlessBrowserService()
    if (!service) {
      ctx.status = 503
      ctx.body = { available: false }
      return await next()
    }
    
    const target = service.getAllTabs().find(t => t.id === tabId)
    if (!target) {
      ctx.status = 404
      ctx.body = { error: 'Tab not found' }
      return await next()
    }
    
    service.activeTabId = tabId
    ctx.body = await service.getState()
  } catch (err: any) {
    handleError(ctx, err)
  }
}

export async function closeTab(ctx: Context, next: Next) {
  const tabId = ctx.request.body?.tab_id
  
  if (!tabId || typeof tabId !== 'string') {
    ctx.status = 400
    ctx.body = { error: 'tab_id is required' }
    return await next()
  }
  
  try {
    const service = getHeadlessBrowserService()
    if (!service) {
      ctx.status = 503
      ctx.body = { available: false }
      return await next()
    }
    
    const index = Array.from(service.tabs.entries()).find(([id]) => id === tabId)
    if (!index) {
      ctx.status = 404
      ctx.body = { error: 'Tab not found' }
      return await next()
    }
    
    const [closedTabId, tab] = index
    await tab.page.close().catch(() => {})
    service.tabs.delete(closedTabId)
    service.clearLeaseTimer(closedTabId)
    
    // Reactivate if closed was active
    if (service.activeTabId === closedTabId) {
      const remaining = service.getAllTabs()
      service.activeTabId = remaining.length > 0 ? remaining[remaining.length - 1].id : null
    }
    
    ctx.body = await service.getState()
  } catch (err: any) {
    handleError(ctx, err)
  }
}

// ─── Navigation ────────────────────────────────────────────────────

export async function navigate(ctx: Context, next: Next) {
  const tabId = ctx.request.body?.tab_id
  const url = ctx.request.body?.url
  
  if (!url || typeof url !== 'string') {
    ctx.status = 400
    ctx.body = { error: 'url is required' }
    return await next()
  }
  
  try {
    const service = getHeadlessBrowserService()
    if (!service) {
      ctx.status = 503
      ctx.body = { available: false }
      return await next()
    }
    
    // Ensure we have an active tab to navigate
    if (!service.activeTabId) {
      await service._createTab(null, true)
    }
    
    const targetId = tabId || service.activeTabId!
    const tab = service.getAllTabs().find(t => t.id === targetId)
    if (!tab) {
      ctx.status = 404
      ctx.body = { error: 'Tab not found' }
      return await next()
    }
    
    await tab.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {})
    tab.url = tab.page.url()
    tab.title = tab.page.title()
    tab.loading = false
    tab.tabGeneration++
    
    if (service.activeTabId === targetId) service.activeTabId = targetId
    ctx.body = service.toPublicTab(tab)
  } catch (err: any) {
    handleError(ctx, err)
  }
}

export async function navigationAction(ctx: Context, next: Next) {
  const action = ctx.request.body?.action
  const tabId = ctx.request.body?.tab_id
  
  if (!tabId || typeof tabId !== 'string') {
    ctx.status = 400
    ctx.body = { error: 'tab_id is required' }
    return await next()
  }
  
  if (!action || !['back', 'forward', 'reload', 'stop'].includes(action as string)) {
    ctx.status = 400
    ctx.body = { error: `Valid action is required: back|forward|reload|stop` }
    return await next()
  }
  
  try {
    const service = getHeadlessBrowserService()
    if (!service) {
      ctx.status = 503
      ctx.body = { available: false }
      return await next()
    }
    
    const tab = service.getAllTabs().find(t => t.id === tabId)
    if (!tab) {
      ctx.status = 404
      ctx.body = { error: 'Tab not found' }
      return await next()
    }
    
    switch (action as string) {
      case 'back': await tab.page.goBack({ waitUntil: 'domcontentloaded', timeout: 15_000 }).catch(() => {})
        break
      case 'forward': await tab.page.goForward({ waitUntil: 'domcontentloaded', timeout: 15_000 }).catch(() => {})
        break
      case 'reload': await tab.page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {})
        break
      case 'stop': await tab.page.evaluate(() => document.execCommand('stop')).catch(() => {})
        break
    }
    
    tab.url = tab.page.url()
    tab.title = tab.page.title()
    tab.loading = false
    tab.tabGeneration++
    ctx.body = service.toPublicTab(tab)
  } catch (err: any) {
    handleError(ctx, err)
  }
}

// ─── Content Reading ───────────────────────────────────────────────

export async function snapshot(ctx: Context, next: Next) {
  const tabId = ctx.request.body?.tab_id
  
  if (!tabId || typeof tabId !== 'string') {
    ctx.status = 400
    ctx.body = { error: 'tab_id is required' }
    return await next()
  }
  
  try {
    const service = getHeadlessBrowserService()
    if (!service) {
      ctx.status = 503
      ctx.body = { available: false }
      return await next()
    }
    
    const tab = service.getAllTabs().find(t => t.id === tabId)
    if (!tab) {
      ctx.status = 404
      ctx.body = { error: 'Tab not found' }
      return await next()
    }
    
    const snap = await buildSnapshot(tab.page, tabId)
    ctx.body = snap
  } catch (err: any) {
    handleError(ctx, err)
  }
}

export async function textRead(ctx: Context, next: Next) {
  const tabId = ctx.request.body?.tab_id
  const ref = ctx.request.body?.ref
  
  if (!tabId || !ref) {
    ctx.status = 400
    ctx.body = { error: 'tab_id and ref are required' }
    return await next()
  }
  
  try {
    const service = getHeadlessBrowserService()
    if (!service) {
      ctx.status = 503
      ctx.body = { available: false }
      return await next()
    }
    
    const tab = service.getAllTabs().find(t => t.id === tabId)
    if (!tab) {
      ctx.status = 404
      ctx.body = { error: 'Tab not found' }
      return await next()
    }
    
    const snap = await buildSnapshot(tab.page, tabId)
    const node = snap.nodes.find(n => n.ref === ref)
    if (!node) {
      ctx.status = 404
      ctx.body = { error: `Node ${ref} not found in snapshot` }
      return await next()
    }
    
    const mode = ctx.request.body?.mode || 'innerText'
    const offset = typeof ctx.request.body?.offset === 'number' ? ctx.request.body.offset : 0
    const limit = typeof ctx.request.body?.limit === 'number' ? ctx.request.body.limit : 4000
    const fullText = node.value || node.name || ''
    const sliced = fullText.slice(offset, offset + limit)
    
    ctx.body = {
      tabId,
      snapshotId: snap.snapshotId,
      ref,
      mode,
      offset,
      limit,
      text: sliced,
      totalLength: fullText.length,
      returnedLength: sliced.length,
      hasMore: offset + limit < fullText.length,
      nextOffset: Math.min(offset + limit, fullText.length),
    }
  } catch (err: any) {
    handleError(ctx, err)
  }
}

// ─── Interaction ───────────────────────────────────────────────────

export async function interact(ctx: Context, next: Next) {
  const tabId = ctx.request.body?.tab_id
  const body = ctx.request.body as any
  
  if (!tabId || !body?.action) {
    ctx.status = 400
    ctx.body = { error: 'tab_id and action are required' }
    return await next()
  }
  
  try {
    const service = getHeadlessBrowserService()
    if (!service) {
      ctx.status = 503
      ctx.body = { available: false }
      return await next()
    }
    
    const tab = service.getAllTabs().find(t => t.id === tabId)
    if (!tab) {
      ctx.status = 404
      ctx.body = { error: 'Tab not found' }
      return await next()
    }
    
    const act = body.action.type || body.action.action
    
    switch (act) {
      case 'click': {
        const clicked = await service._performClick(tab, body.action.ref)
        if (!clicked) {
          ctx.body = { success: false, error: 'Could not click element' }
        } else {
          tab.url = tab.page.url()
          tab.title = tab.page.title()
          ctx.body = service.toPublicTab(tab)
        }
        break
      }
      
      case 'type': {
        if (!body.action.text || typeof body.action.text !== 'string') {
          ctx.status = 400
          ctx.body = { error: 'text is required for type action' }
          return await next()
        }
        await tab.page.keyboard.type(body.action.text, { delay: Math.random() * 30 })
        ctx.body = service.toPublicTab(tab)
        break
      }
      
      case 'press': {
        if (!body.action.key || typeof body.action.key !== 'string') {
          ctx.status = 400
          ctx.body = { error: 'key is required for press action' }
          return await next()
        }
        await tab.page.keyboard.press(body.action.key)
        ctx.body = service.toPublicTab(tab)
        break
      }
      
      case 'scroll': {
        const direction = body.action.direction || 'down'
        const pixels = typeof body.action.pixels === 'number' ? body.action.pixels : 300
        
        let dy = 0, dx = 0
        if (direction === 'up') dy = -pixels
        else if (direction === 'down') dy = pixels
        else if (direction === 'left') dx = -pixels
        else if (direction === 'right') dx = pixels
        
        await tab.page.mouse.move(dx, dy)
        await tab.page.evaluate(({ y }: {y: number}) => window.scrollBy(0, y), { y: dy })
        
        ctx.body = service.toPublicTab(tab)
        break
      }
      
      default:
        ctx.status = 400
        ctx.body = { error: `Unknown interact action: ${act}` }
    }
  } catch (err: any) {
    handleError(ctx, err)
  }
}

// ─── Screenshot ────────────────────────────────────────────────────

export async function screenshot(ctx: Context, next: Next) {
  const tabId = ctx.request.body?.tab_id
  
  if (!tabId || typeof tabId !== 'string') {
    ctx.status = 400
    ctx.body = { error: 'tab_id is required' }
    return await next()
  }
  
  try {
    const service = getHeadlessBrowserService()
    if (!service) {
      ctx.status = 503
      ctx.body = { available: false }
      return await next()
    }
    
    const tab = service.getAllTabs().find(t => t.id === tabId)
    if (!tab) {
      ctx.status = 404
      ctx.body = { error: 'Tab not found' }
      return await next()
    }
    
    const screenshotBuffer = await tab.page.screenshot({
      fullPage: !!ctx.request.body?.full_page,
      type: 'jpeg',
      quality: 70,
    })
    
    const base64 = screenshotBuffer.toString('base64')
    
    // Notify WebSocket subscribers about new screenshot
    broadcastScreenshot(base64, tabId)
    
    ctx.body = {
      data: base64,
      mimeType: 'image/jpeg',
      tabId,
    }
  } catch (err: any) {
    handleError(ctx, err)
  }
}

// ─── Console ───────────────────────────────────────────────────────

export async function consoleRead(ctx: Context, next: Next) {
  const tabId = ctx.request.body?.tab_id
  
  if (!tabId || typeof tabId !== 'string') {
    ctx.status = 400
    ctx.body = { error: 'tab_id is required' }
    return await next()
  }
  
  try {
    const service = getHeadlessBrowserService()
    if (!service) {
      ctx.status = 503
      ctx.body = { available: false }
      return await next()
    }
    
    const messages = service.consoleEntries.get(tabId) || []
    ctx.body = messages.map(m => ({
      message: (m.text || '').slice(0, 2000),
      source: m.source || 'browser',
      timestamp: m.timestamp,
    }))
  } catch (err: any) {
    handleError(ctx, err)
  }
}

export async function consoleClear(ctx: Context, next: Next) {
  const tabId = ctx.request.body?.tab_id
  
  if (!tabId || typeof tabId !== 'string') {
    ctx.status = 400
    ctx.body = { error: 'tab_id is required' }
    return await next()
  }
  
  const service = getHeadlessBrowserService()
  if (service) {
    service.consoleEntries.delete(tabId)
  }
  
  ctx.body = { ok: true }
}

// ─── Lease ─────────────────────────────────────────────────────────

export async function releaseLease(ctx: Context, next: Next) {
  const tabId = ctx.request.body?.tab_id
  
  if (!tabId || typeof tabId !== 'string') {
    ctx.status = 400
    ctx.body = { error: 'tab_id is required' }
    return await next()
  }
  
  const service = getHeadlessBrowserService()
  if (service) {
    service.leases.delete(tabId)
    service.clearLeaseTimer(tabId)
  }
  
  ctx.body = { ok: true }
}

// ─── Status ────────────────────────────────────────────────────────

export async function getStatus(ctx: Context, next: Next) {
  const service = getHeadlessBrowserService()
  
  if (!service) {
    ctx.body = { available: false, reason: 'Service not initialized' }
    return await next()
  }
  
  ctx.body = {
    available: true,
    stats: service.getStats(),
    descriptor: service.descriptor,
  }
}

// ─── Screenshot Event System ──────────────────────────────────────

// Simple singleton pattern for screenshot event broadcast
interface ScreenshotHandler {
  (base64: string, tabId: string): void
}
const screenshotSubscribers: Set<ScreenshotHandler> = new Set()

/** Called by controller to notify subscribers of new screenshots */
export function broadcastScreenshot(base64: string, tabId: string): void {
  for (const handler of screenshotSubscribers) {
    try { handler(base64, tabId) } catch {}
  }
}

/** Subscribe a callback for screenshot events */
export function subscribeToScreenshots(handler: ScreenshotHandler): () => void {
  screenshotSubscribers.add(handler)
  return () => { screenshotSubscribers.delete(handler) }
}

// ─── Snapshot Helpers ──────────────────────────────────────────────

async function buildSnapshot(page: any, tabId: string): Promise<any> {
  // We'll use page.accessibility.snapshot and transform it
  const axSnapshot = await page.accessibility.snapshot({ interesting_only: false })
  
  if (!axSnapshot) {
    return { tabId, snapshotId: '', url: '', title: '', nodes: [], text: '' }
  }
  
  // Build flat list of accessibility nodes with refs
  const nodes: Array<{ref: string; role: string; name: string; value?: string; description?: string; disabled?: boolean; focused?: boolean}> = []
  const MAX_SNAPSHOT_NODES = 300
  const MAX_SNAPSHOT_TEXT = 24_000
  
  let idx = 0
  function flatten(node: any, prefix: number): number {
    if (!node || prefix >= MAX_SNAPSHOT_NODES) return prefix
    
    const sanitizedRole = (node.role || 'generic').replace(/\s+/g, ' ').trim().slice(0, 80)
    if (sanitizedRole === 'none' && !node.name && !node.value) return prefix
    
    const n: any = {
      ref: `@e${prefix}`,
      role: sanitizedRole,
      name: (node.name || '').replace(/\s+/g, ' ').trim().slice(0, 500),
    }
    
    if (node.value != null) {
      const protectedProp = (node.properties || []).find((p: any) => p.name === 'protected')
      n.value = protectedProp ? '[protected]' : String(node.value).replace(/\s+/g, ' ').trim().slice(0, 500)
    }
    if (node.description) n.description = node.description.replace(/\s+/g, ' ').trim().slice(0, 200)
    if (node.disabled) n.disabled = true
    if (node.focused) n.focused = true
    
    nodes.push(n)
    
    if (node.children) {
      for (const child of node.children) {
        prefix = flatten(child, prefix + 1)
      }
    }
    
    return prefix
  }
  
  idx = flatten(axSnapshot, 1)
  
  // Deduplicate refs
  const seen = new Set<string>()
  const uniqueNodes = nodes.filter(n => {
    if (seen.has(n.ref)) return false
    seen.add(n.ref)
    return true
  })
  
  // Build text representation
  const textLines = uniqueNodes.slice(0, MAX_SNAPSHOT_NODES).map(n => {
    let line = `${n.ref} ${n.role}`
    if (n.name) line += ` name="${n.name}"`
    if (n.value) line += ` value="${n.value}"`
    return line
  }).join('\n')
  
  return {
    tabId,
    snapshotId: require('crypto').randomUUID(),
    url: page.url().replace(/\/\/localhost(?::\d+)?/, 'http://127.0.0.1').replace(/^https?:\/\/[^?]+/, m => m.slice(0, 500)),
    title: (page.title() || '').replace(/\s+/g, ' ').trim().slice(0, 500),
    nodes: uniqueNodes,
    text: textLines.slice(0, MAX_SNAPSHOT_TEXT),
  }
}
