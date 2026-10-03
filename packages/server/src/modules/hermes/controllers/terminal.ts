import type { Context } from 'koa'
import {
  capturePane,
  killTmuxSession,
  listChatSessions,
  paneCwd,
  sendKey,
  sendText,
} from '../services/terminal/tmux-sessions'

// ---------------------------------------------------------------------------
// Terminal controller — REST access to the persistent tmux sessions.
//
// The Studio UI attaches to these over WebSocket; these endpoints let the
// agent (and other API clients) list, read, and drive the same sessions.
// ---------------------------------------------------------------------------

function sessionIdFrom(ctx: Context): string {
  const fromBody = (ctx.request.body as any)?.session_id
  const fromQuery = ctx.query?.session_id
  return String((typeof fromBody === 'string' && fromBody) || (typeof fromQuery === 'string' && fromQuery) || '').trim()
}

export async function listSessions(ctx: Context) {
  const chatSessionId = sessionIdFrom(ctx)
  if (!chatSessionId) {
    ctx.status = 400
    ctx.body = { error: 'session_id is required' }
    return
  }
  const sessions = listChatSessions(chatSessionId).map(session => ({
    id: session.name,
    name: session.name,
    createdAt: session.createdAt,
    attached: session.attached,
    cwd: paneCwd(session.name),
  }))
  ctx.body = { sessions }
}

export async function readSession(ctx: Context) {
  const chatSessionId = sessionIdFrom(ctx)
  const name = String((ctx.request.body as any)?.terminal || ctx.query?.terminal || '').trim()
  const lines = Number((ctx.request.body as any)?.lines ?? ctx.query?.lines ?? 200)
  if (!chatSessionId || !name) {
    ctx.status = 400
    ctx.body = { error: 'session_id and terminal are required' }
    return
  }
  const owned = listChatSessions(chatSessionId).some(session => session.name === name)
  if (!owned) {
    ctx.status = 404
    ctx.body = { error: 'Terminal not found for this chat session' }
    return
  }
  ctx.body = {
    terminal: name,
    cwd: paneCwd(name),
    output: capturePane(name, Number.isFinite(lines) ? Math.max(1, Math.min(5000, lines)) : 200),
  }
}

export async function writeSession(ctx: Context) {
  const chatSessionId = sessionIdFrom(ctx)
  const body = ctx.request.body as any
  const name = String(body?.terminal || '').trim()
  if (!chatSessionId || !name) {
    ctx.status = 400
    ctx.body = { error: 'session_id and terminal are required' }
    return
  }
  const owned = listChatSessions(chatSessionId).some(session => session.name === name)
  if (!owned) {
    ctx.status = 404
    ctx.body = { error: 'Terminal not found for this chat session' }
    return
  }
  try {
    if (typeof body?.text === 'string' && body.text) {
      sendText(name, body.text)
    }
    if (typeof body?.key === 'string' && body.key) {
      sendKey(name, body.key)
    } else if (body?.enter === true) {
      sendKey(name, 'Enter')
    }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err?.message || 'Failed to write to terminal' }
    return
  }
  ctx.body = { ok: true, terminal: name }
}

export async function closeSession(ctx: Context) {
  const chatSessionId = sessionIdFrom(ctx)
  const name = String((ctx.request.body as any)?.terminal || ctx.query?.terminal || '').trim()
  if (!chatSessionId || !name) {
    ctx.status = 400
    ctx.body = { error: 'session_id and terminal are required' }
    return
  }
  const owned = listChatSessions(chatSessionId).some(session => session.name === name)
  if (!owned) {
    ctx.status = 404
    ctx.body = { error: 'Terminal not found for this chat session' }
    return
  }
  killTmuxSession(name)
  ctx.body = { ok: true }
}