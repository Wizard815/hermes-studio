import type { Context, Next } from 'koa'
import { buildSnapshot, getHeadlessBrowserService } from '../services/headless-browser-service'

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

function unavailable(ctx: Context): boolean {
  const service = getHeadlessBrowserService()
  if (!service) {
    ctx.status = 503
    ctx.body = { available: false }
    return true
  }
  return false
}

// ─── Tab Management ────────────────────────────────────────────────

export async function getState(ctx: Context) {
  try {
    const service = getHeadlessBrowserService()
    if (!service) {
      ctx.status = 503
      ctx.body = { available: false }
      return
    }
    ctx.body = await service.getState()
  } catch (err: any) {
    handleError(ctx, err)
  }
}

export async function createTab(ctx: Context) {
  if (unavailable(ctx)) return
  try {
    const service = getHeadlessBrowserService()!
    const url = typeof ctx.request.body?.url === 'string' && ctx.request.body.url ? ctx.request.body.url : null
    const activate = ctx.request.body?.activate !== false
    const tab = await service._createTab(url, activate)
    ctx.body = service.toPublicTab(tab)
  } catch (err: any) {
    handleError(ctx, err)
  }
}

export async function activateTab(ctx: Context) {
  const tabId = ctx.request.body?.tab_id
  if (!tabId || typeof tabId !== 'string') {
    ctx.status = 400
    ctx.body = { error: 'tab_id is required' }
    return
  }
  if (unavailable(ctx)) return
  try {
    const service = getHeadlessBrowserService()!
    const target = service.getAllTabs().find(t => t.id === tabId)
    if (!target) {
      ctx.status = 404
      ctx.body = { error: 'Tab not found' }
      return
    }
    service.activeTabId = tabId
    ctx.body = await service.getState()
  } catch (err: any) {
    handleError(ctx, err)
  }
}

export async function closeTab(ctx: Context) {
  const tabId = ctx.request.body?.tab_id
  if (!tabId || typeof tabId !== 'string') {
    ctx.status = 400
    ctx.body = { error: 'tab_id is required' }
    return
  }
  if (unavailable(ctx)) return
  try {
    const service = getHeadlessBrowserService()!
    const tab = service.getTab(tabId)
    if (!tab) {
      ctx.status = 404
      ctx.body = { error: 'Tab not found' }
      return
    }
    await service._closeTab(tabId)
    ctx.body = await service.getState()
  } catch (err: any) {
    handleError(ctx, err)
  }
}

// ─── Navigation ────────────────────────────────────────────────────

export async function navigate(ctx: Context) {
  const tabId = ctx.request.body?.tab_id
  const url = ctx.request.body?.url

  if (!url || typeof url !== 'string') {
    ctx.status = 400
    ctx.body = { error: 'url is required' }
    return
  }
  if (unavailable(ctx)) return
  try {
    const service = getHeadlessBrowserService()!
    if (!service.activeTabId) {
      await service._createTab(null, true)
    }
    const targetId = typeof tabId === 'string' ? tabId : service.activeTabId!
    const tab = service.getTab(targetId)
    if (!tab) {
      ctx.status = 404
      ctx.body = { error: 'Tab not found' }
      return
    }
    await tab.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {})
    tab.url = tab.page.url()
    tab.title = await tab.page.title().catch(() => '')
    tab.loading = false
    tab.tabGeneration++
    ctx.body = service.toPublicTab(tab)
  } catch (err: any) {
    handleError(ctx, err)
  }
}

export async function navigationAction(ctx: Context) {
  const action = ctx.request.body?.action
  const tabId = ctx.request.body?.tab_id

  if (!tabId || typeof tabId !== 'string') {
    ctx.status = 400
    ctx.body = { error: 'tab_id is required' }
    return
  }
  if (!action || !['back', 'forward', 'reload', 'stop'].includes(action as string)) {
    ctx.status = 400
    ctx.body = { error: 'Valid action is required: back|forward|reload|stop' }
    return
  }
  if (unavailable(ctx)) return
  try {
    const service = getHeadlessBrowserService()!
    const tab = service.getTab(tabId)
    if (!tab) {
      ctx.status = 404
      ctx.body = { error: 'Tab not found' }
      return
    }

    switch (action as string) {
      case 'back':
        await tab.page.goBack({ waitUntil: 'domcontentloaded', timeout: 15_000 }).catch(() => {})
        break
      case 'forward':
        await tab.page.goForward({ waitUntil: 'domcontentloaded', timeout: 15_000 }).catch(() => {})
        break
      case 'reload':
        await tab.page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {})
        break
      case 'stop':
        await tab.page.evaluate(() => window.stop()).catch(() => {})
        break
    }

    tab.url = tab.page.url()
    tab.title = await tab.page.title().catch(() => '')
    tab.loading = false
    tab.tabGeneration++
    ctx.body = service.toPublicTab(tab)
  } catch (err: any) {
    handleError(ctx, err)
  }
}

// ─── Content Reading ───────────────────────────────────────────────

export async function snapshot(ctx: Context) {
  const tabId = ctx.request.body?.tab_id
  if (!tabId || typeof tabId !== 'string') {
    ctx.status = 400
    ctx.body = { error: 'tab_id is required' }
    return
  }
  if (unavailable(ctx)) return
  try {
    const service = getHeadlessBrowserService()!
    const tab = service.getTab(tabId)
    if (!tab) {
      ctx.status = 404
      ctx.body = { error: 'Tab not found' }
      return
    }
    ctx.body = await buildSnapshot(tab.page, tabId)
  } catch (err: any) {
    handleError(ctx, err)
  }
}

export async function textRead(ctx: Context) {
  const tabId = ctx.request.body?.tab_id
  const ref = ctx.request.body?.ref

  if (!tabId || !ref) {
    ctx.status = 400
    ctx.body = { error: 'tab_id and ref are required' }
    return
  }
  if (unavailable(ctx)) return
  try {
    const service = getHeadlessBrowserService()!
    const tab = service.getTab(tabId)
    if (!tab) {
      ctx.status = 404
      ctx.body = { error: 'Tab not found' }
      return
    }

    const snap = await buildSnapshot(tab.page, tabId)
    const node = snap.nodes.find(n => n.ref === ref)
    if (!node) {
      ctx.status = 404
      ctx.body = { error: `Node ${ref} not found in snapshot` }
      return
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

export async function interact(ctx: Context) {
  const tabId = ctx.request.body?.tab_id
  const body = ctx.request.body as any

  if (!tabId || !body?.action) {
    ctx.status = 400
    ctx.body = { error: 'tab_id and action are required' }
    return
  }
  if (unavailable(ctx)) return
  try {
    const service = getHeadlessBrowserService()!
    const tab = service.getTab(tabId)
    if (!tab) {
      ctx.status = 404
      ctx.body = { error: 'Tab not found' }
      return
    }

    const act = body.action.type || body.action.action

    switch (act) {
      case 'click': {
        const clicked = await service._performClick(tab, body.action.ref)
        if (!clicked) {
          ctx.body = { success: false, error: 'Could not click element' }
        } else {
          tab.url = tab.page.url()
          tab.title = await tab.page.title().catch(() => tab.title)
          ctx.body = service.toPublicTab(tab)
        }
        break
      }

      case 'type': {
        if (!body.action.text || typeof body.action.text !== 'string') {
          ctx.status = 400
          ctx.body = { error: 'text is required for type action' }
          return
        }
        if (body.action.ref) {
          const focused = await service._focusRef(tab, body.action.ref)
          if (!focused) {
            ctx.body = { success: false, error: 'Could not focus element' }
            break
          }
        }
        await tab.page.keyboard.type(body.action.text, { delay: Math.random() * 30 })
        ctx.body = service.toPublicTab(tab)
        break
      }

      case 'press': {
        if (!body.action.key || typeof body.action.key !== 'string') {
          ctx.status = 400
          ctx.body = { error: 'key is required for press action' }
          return
        }
        await tab.page.keyboard.press(body.action.key as any)
        ctx.body = service.toPublicTab(tab)
        break
      }

      case 'scroll': {
        const direction = body.action.direction || 'down'
        const pixels = typeof body.action.pixels === 'number' ? body.action.pixels : 300
        let dy = 0
        let dx = 0
        if (direction === 'up') dy = -pixels
        else if (direction === 'down') dy = pixels
        else if (direction === 'left') dx = -pixels
        else if (direction === 'right') dx = pixels

        await tab.page.mouse.move(640, 360).catch(() => {})
        await tab.page
          .evaluate(({ x, y }: { x: number; y: number }) => window.scrollBy(x, y), { x: dx, y: dy })
          .catch(() => {})

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

// ─── Manual Input (coordinate-based, for the live view) ────────────

export async function manualInput(ctx: Context) {
  const tabId = ctx.request.body?.tab_id
  const body = ctx.request.body as any

  if (!tabId || !body?.action) {
    ctx.status = 400
    ctx.body = { error: 'tab_id and action are required' }
    return
  }
  if (unavailable(ctx)) return
  try {
    const service = getHeadlessBrowserService()!
    if (!service.getTab(tabId)) {
      ctx.status = 404
      ctx.body = { error: 'Tab not found' }
      return
    }

    const act = body.action.type || body.action.action
    let tab

    switch (act) {
      case 'click': {
        const x = Number(body.action.x)
        const y = Number(body.action.y)
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
          ctx.status = 400
          ctx.body = { error: 'x and y are required for click' }
          return
        }
        tab = await service.clickAt(tabId, x, y, {
          button: body.action.button,
          double: body.action.double === true,
        })
        break
      }

      case 'scroll': {
        const x = Number.isFinite(Number(body.action.x)) ? Number(body.action.x) : 0.5
        const y = Number.isFinite(Number(body.action.y)) ? Number(body.action.y) : 0.5
        const deltaY = Number.isFinite(Number(body.action.delta_y)) ? Number(body.action.delta_y) : 0
        const deltaX = Number.isFinite(Number(body.action.delta_x)) ? Number(body.action.delta_x) : 0
        tab = await service.scrollAt(tabId, x, y, deltaX, deltaY)
        break
      }

      case 'type': {
        if (typeof body.action.text !== 'string' || !body.action.text) {
          ctx.status = 400
          ctx.body = { error: 'text is required for type' }
          return
        }
        tab = await service.typeText(tabId, body.action.text)
        break
      }

      case 'press': {
        if (typeof body.action.key !== 'string' || !body.action.key) {
          ctx.status = 400
          ctx.body = { error: 'key is required for press' }
          return
        }
        tab = await service.pressKey(tabId, body.action.key)
        break
      }

      default:
        ctx.status = 400
        ctx.body = { error: `Unknown manual input action: ${act}` }
        return
    }

    const viewport = await service.getViewportInfo(tabId)
    ctx.body = { tab: service.toPublicTab(tab), viewport }
  } catch (err: any) {
    handleError(ctx, err)
  }
}

export async function viewportInfo(ctx: Context) {
  const tabId = ctx.request.body?.tab_id || ctx.query.tab_id
  if (!tabId || typeof tabId !== 'string') {
    ctx.status = 400
    ctx.body = { error: 'tab_id is required' }
    return
  }
  if (unavailable(ctx)) return
  try {
    const service = getHeadlessBrowserService()!
    ctx.body = await service.getViewportInfo(tabId)
  } catch (err: any) {
    handleError(ctx, err)
  }
}

// ─── Screenshot ────────────────────────────────────────────────────

export async function screenshot(ctx: Context) {
  const tabId = ctx.request.body?.tab_id
  if (!tabId || typeof tabId !== 'string') {
    ctx.status = 400
    ctx.body = { error: 'tab_id is required' }
    return
  }
  if (unavailable(ctx)) return
  try {
    const service = getHeadlessBrowserService()!
    // The UI receives this response directly; only agent-initiated captures
    // (via executeMethod) are broadcast to other clients.
    const base64 = await service.captureScreenshot(tabId, !!ctx.request.body?.full_page, { broadcast: false })
    ctx.body = { data: base64, mimeType: 'image/jpeg', tabId }
  } catch (err: any) {
    handleError(ctx, err)
  }
}

// ─── Console ───────────────────────────────────────────────────────

export async function consoleRead(ctx: Context) {
  const tabId = ctx.request.body?.tab_id
  if (!tabId || typeof tabId !== 'string') {
    ctx.status = 400
    ctx.body = { error: 'tab_id is required' }
    return
  }
  if (unavailable(ctx)) return
  try {
    const service = getHeadlessBrowserService()!
    const messages = service.consoleEntries.get(tabId) || []
    ctx.body = messages.map((m: { text: string; source: string; timestamp: number }) => ({
      message: (m.text || '').slice(0, 2000),
      source: m.source || 'browser',
      timestamp: m.timestamp,
    }))
  } catch (err: any) {
    handleError(ctx, err)
  }
}

export async function consoleClear(ctx: Context) {
  const tabId = ctx.request.body?.tab_id
  if (!tabId || typeof tabId !== 'string') {
    ctx.status = 400
    ctx.body = { error: 'tab_id is required' }
    return
  }
  const service = getHeadlessBrowserService()
  if (service) {
    service.consoleEntries.delete(tabId)
  }
  ctx.body = { ok: true }
}

// ─── Lease ─────────────────────────────────────────────────────────

export async function releaseLease(ctx: Context) {
  const tabId = ctx.request.body?.tab_id
  if (!tabId || typeof tabId !== 'string') {
    ctx.status = 400
    ctx.body = { error: 'tab_id is required' }
    return
  }
  const service = getHeadlessBrowserService()
  if (service) {
    service.releaseLease(tabId)
  }
  ctx.body = { ok: true }
}

// ─── Status ────────────────────────────────────────────────────────

export async function getStatus(ctx: Context) {
  const service = getHeadlessBrowserService()
  if (!service) {
    ctx.body = { available: false, reason: 'Service not initialized' }
    return
  }
  ctx.body = {
    available: true,
    stats: service.getStats(),
    descriptor: service.descriptor,
  }
}
