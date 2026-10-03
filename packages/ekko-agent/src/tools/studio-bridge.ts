import type { AgentTool, AgentToolContext, AgentToolResult } from './types'

/**
 * Studio UI bridge.
 *
 * Lets the agent observe and drive the Studio UI's own resources — the open
 * terminal (tmux) sessions and the browser panel — instead of only its own
 * private processes. Calls go back to the local Studio HTTP API using the
 * loopback URL + server token supplied on the tool context.
 */

function bridgeConfig(context: AgentToolContext): { base: string; token: string } | null {
  const base = String(context.studioBaseUrl || '').trim().replace(/\/$/, '')
  const token = String(context.studioToken || '').trim()
  if (!base || !token) return null
  return { base, token }
}

function missingConfig(): AgentToolResult {
  return {
    ok: false,
    content: 'Studio bridge is unavailable (no studioBaseUrl/studioToken in context). This tool only works inside the Studio server.',
    error: 'studio bridge unavailable',
  }
}

async function studioRequest(
  context: AgentToolContext,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<{ ok: boolean; status: number; json: any }> {
  const config = bridgeConfig(context)
  if (!config) throw new Error('studio bridge unavailable')
  const response = await fetch(`${config.base}${path}`, {
    method: init.method || 'GET',
    headers: {
      Authorization: `Bearer ${config.token}`,
      'Content-Type': 'application/json',
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  })
  const json = await response.json().catch(() => null)
  return { ok: response.ok, status: response.status, json }
}

function sessionId(context: AgentToolContext): string {
  return String(context.sessionId || '').trim()
}

const terminalListDefinition: AgentTool['definition'] = {
  name: 'studio_terminal_list',
  description: 'List the persistent terminals the user has open in the Studio UI for this chat, including each terminal id and working directory.',
  parameters: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
}

const terminalReadDefinition: AgentTool['definition'] = {
  name: 'studio_terminal_read',
  description: 'Read recent output from a Studio UI terminal the user has open (identified by terminal id from studio_terminal_list). Use this to inspect what the user is running or to look at an error they asked about.',
  parameters: {
    type: 'object',
    properties: {
      terminal: { type: 'string', description: 'Terminal id/name from studio_terminal_list.' },
      lines: { type: 'number', description: 'How many trailing lines to read (default 200, max 5000).' },
    },
    required: ['terminal'],
    additionalProperties: false,
  },
}

const terminalWriteDefinition: AgentTool['definition'] = {
  name: 'studio_terminal_write',
  description: 'Type text into a Studio UI terminal the user has open. Provide text to type and optionally enter=true to submit it, or key for a named key such as Enter, C-c, Tab, Escape. Only use when the user asked you to run something in their terminal.',
  parameters: {
    type: 'object',
    properties: {
      terminal: { type: 'string', description: 'Terminal id/name from studio_terminal_list.' },
      text: { type: 'string', description: 'Literal text to type (no Enter unless enter=true).' },
      key: { type: 'string', description: 'Named key to send, e.g. Enter, C-c, Tab, Escape.' },
      enter: { type: 'boolean', description: 'Send Enter after the text.' },
    },
    required: ['terminal'],
    additionalProperties: false,
  },
}

export class StudioTerminalListTool implements AgentTool {
  readonly definition = terminalListDefinition
  async execute(_input: Record<string, unknown>, context: AgentToolContext): Promise<AgentToolResult> {
    if (!bridgeConfig(context)) return missingConfig()
    const id = sessionId(context)
    if (!id) return { ok: false, content: 'No active chat session for this run.', error: 'missing session' }
    try {
      const res = await studioRequest(context, `/api/hermes/terminal/sessions?session_id=${encodeURIComponent(id)}`)
      if (!res.ok) return { ok: false, content: `Failed to list terminals (HTTP ${res.status}).`, error: 'http error' }
      const sessions = res.json?.sessions || []
      if (sessions.length === 0) {
        return { ok: true, content: 'No UI terminals are open for this chat.', data: { sessions: [] } }
      }
      return {
        ok: true,
        content: sessions.map((s: any) => `- ${s.id} (cwd: ${s.cwd || '?'})`).join('\n'),
        data: { sessions },
      }
    } catch (err: any) {
      return { ok: false, content: `Studio bridge error: ${err?.message || err}`, error: 'bridge error' }
    }
  }
}

export class StudioTerminalReadTool implements AgentTool {
  readonly definition = terminalReadDefinition
  async execute(input: Record<string, unknown>, context: AgentToolContext): Promise<AgentToolResult> {
    if (!bridgeConfig(context)) return missingConfig()
    const id = sessionId(context)
    if (!id) return { ok: false, content: 'No active chat session for this run.', error: 'missing session' }
    try {
      const res = await studioRequest(context, '/api/hermes/terminal/read', {
        method: 'POST',
        body: { session_id: id, terminal: input.terminal, lines: input.lines },
      })
      if (!res.ok) return { ok: false, content: res.json?.error || `Failed to read terminal (HTTP ${res.status}).`, error: 'http error' }
      return {
        ok: true,
        content: String(res.json?.output || '(no output)'),
        data: { terminal: res.json?.terminal, cwd: res.json?.cwd },
      }
    } catch (err: any) {
      return { ok: false, content: `Studio bridge error: ${err?.message || err}`, error: 'bridge error' }
    }
  }
}

export class StudioTerminalWriteTool implements AgentTool {
  readonly definition = terminalWriteDefinition
  async execute(input: Record<string, unknown>, context: AgentToolContext): Promise<AgentToolResult> {
    if (!bridgeConfig(context)) return missingConfig()
    const id = sessionId(context)
    if (!id) return { ok: false, content: 'No active chat session for this run.', error: 'missing session' }
    try {
      const res = await studioRequest(context, '/api/hermes/terminal/write', {
        method: 'POST',
        body: {
          session_id: id,
          terminal: input.terminal,
          text: input.text,
          key: input.key,
          enter: input.enter,
        },
      })
      if (!res.ok) return { ok: false, content: res.json?.error || `Failed to write to terminal (HTTP ${res.status}).`, error: 'http error' }
      return { ok: true, content: `Sent input to ${input.terminal}.`, data: { terminal: input.terminal } }
    } catch (err: any) {
      return { ok: false, content: `Studio bridge error: ${err?.message || err}`, error: 'bridge error' }
    }
  }
}

export function createStudioBridgeTools(): AgentTool[] {
  return [
    new StudioTerminalListTool(),
    new StudioTerminalReadTool(),
    new StudioTerminalWriteTool(),
    new StudioBrowserStateTool(),
    new StudioBrowserNavigateTool(),
    new StudioBrowserSnapshotTool(),
    new StudioBrowserScreenshotTool(),
  ]
}

// ─── Browser panel bridge ───────────────────────────────────────
//
// Drives the same headless browser the user sees in the Studio browser panel
// (the service is a single shared instance), so the agent and the user look at
// the same tabs.

const browserStateDefinition: AgentTool['definition'] = {
  name: 'studio_browser_state',
  description: 'List the tabs currently open in the Studio UI browser panel, with their ids, urls, and titles. Use the active tab id with the other studio_browser_* tools.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
}

const browserNavigateDefinition: AgentTool['definition'] = {
  name: 'studio_browser_navigate',
  description: 'Navigate a Studio UI browser tab to a URL. Omit tab_id to use the active tab.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'URL to open.' },
      tab_id: { type: 'string', description: 'Tab id from studio_browser_state; defaults to the active tab.' },
    },
    required: ['url'],
    additionalProperties: false,
  },
}

const browserSnapshotDefinition: AgentTool['definition'] = {
  name: 'studio_browser_snapshot',
  description: 'Return an accessibility snapshot (with element refs) plus visible text for a Studio UI browser tab, so you can inspect what the user is viewing.',
  parameters: {
    type: 'object',
    properties: {
      tab_id: { type: 'string', description: 'Tab id from studio_browser_state; defaults to the active tab.' },
    },
    additionalProperties: false,
  },
}

const browserScreenshotDefinition: AgentTool['definition'] = {
  name: 'studio_browser_screenshot',
  description: 'Capture a screenshot of a Studio UI browser tab and return it as an image for visual inspection.',
  parameters: {
    type: 'object',
    properties: {
      tab_id: { type: 'string', description: 'Tab id from studio_browser_state; defaults to the active tab.' },
      full_page: { type: 'boolean', description: 'Capture the full scrollable page instead of the viewport.' },
    },
    additionalProperties: false,
  },
}

async function resolveTabId(context: AgentToolContext, explicit?: unknown): Promise<string | null> {
  if (typeof explicit === 'string' && explicit.trim()) return explicit.trim()
  const res = await studioRequest(context, '/api/studio/browser/state')
  if (!res.ok) return null
  return res.json?.activeTabId || res.json?.tabs?.[0]?.id || null
}

export class StudioBrowserStateTool implements AgentTool {
  readonly definition = browserStateDefinition
  async execute(_input: Record<string, unknown>, context: AgentToolContext): Promise<AgentToolResult> {
    if (!bridgeConfig(context)) return missingConfig()
    try {
      const res = await studioRequest(context, '/api/studio/browser/state')
      if (!res.ok) return { ok: false, content: `Failed to read browser state (HTTP ${res.status}).`, error: 'http error' }
      const tabs = res.json?.tabs || []
      if (tabs.length === 0) return { ok: true, content: 'No browser tabs are open in the Studio panel.', data: { tabs: [] } }
      const active = res.json?.activeTabId
      return {
        ok: true,
        content: tabs.map((t: any) => `${t.id === active ? '* ' : '  '}${t.id} — ${t.title || '(untitled)'} — ${t.url}`).join('\n'),
        data: { activeTabId: active, tabs },
      }
    } catch (err: any) {
      return { ok: false, content: `Studio bridge error: ${err?.message || err}`, error: 'bridge error' }
    }
  }
}

export class StudioBrowserNavigateTool implements AgentTool {
  readonly definition = browserNavigateDefinition
  async execute(input: Record<string, unknown>, context: AgentToolContext): Promise<AgentToolResult> {
    if (!bridgeConfig(context)) return missingConfig()
    try {
      const tabId = await resolveTabId(context, input.tab_id)
      if (!tabId) return { ok: false, content: 'No browser tab is available.', error: 'no tab' }
      const res = await studioRequest(context, '/api/studio/browser/navigate', {
        method: 'POST',
        body: { tab_id: tabId, url: input.url },
      })
      if (!res.ok) return { ok: false, content: res.json?.error || `Navigate failed (HTTP ${res.status}).`, error: 'http error' }
      return { ok: true, content: `Navigated tab ${tabId} to ${res.json?.url || input.url}.`, data: res.json }
    } catch (err: any) {
      return { ok: false, content: `Studio bridge error: ${err?.message || err}`, error: 'bridge error' }
    }
  }
}

export class StudioBrowserSnapshotTool implements AgentTool {
  readonly definition = browserSnapshotDefinition
  async execute(input: Record<string, unknown>, context: AgentToolContext): Promise<AgentToolResult> {
    if (!bridgeConfig(context)) return missingConfig()
    try {
      const tabId = await resolveTabId(context, input.tab_id)
      if (!tabId) return { ok: false, content: 'No browser tab is available.', error: 'no tab' }
      const res = await studioRequest(context, '/api/studio/browser/snapshot', {
        method: 'POST',
        body: { tab_id: tabId },
      })
      if (!res.ok) return { ok: false, content: res.json?.error || `Snapshot failed (HTTP ${res.status}).`, error: 'http error' }
      const nodes = Array.isArray(res.json?.nodes) ? res.json.nodes : []
      const text = String(res.json?.text || '')
      const rendered = nodes.slice(0, 200).map((n: any) => `[${n.ref}] ${n.role}${n.name ? ` "${n.name}"` : ''}`).join('\n')
      return {
        ok: true,
        content: `${res.json?.title || ''} ${res.json?.url || ''}\n\n${rendered}\n\n${text.slice(0, 8000)}`.trim(),
        data: res.json,
      }
    } catch (err: any) {
      return { ok: false, content: `Studio bridge error: ${err?.message || err}`, error: 'bridge error' }
    }
  }
}

export class StudioBrowserScreenshotTool implements AgentTool {
  readonly definition = browserScreenshotDefinition
  async execute(input: Record<string, unknown>, context: AgentToolContext): Promise<AgentToolResult> {
    if (!bridgeConfig(context)) return missingConfig()
    try {
      const tabId = await resolveTabId(context, input.tab_id)
      if (!tabId) return { ok: false, content: 'No browser tab is available.', error: 'no tab' }
      const res = await studioRequest(context, '/api/studio/browser/screenshot', {
        method: 'POST',
        body: { tab_id: tabId, full_page: input.full_page === true },
      })
      if (!res.ok || !res.json?.data) {
        return { ok: false, content: res.json?.error || `Screenshot failed (HTTP ${res.status}).`, error: 'http error' }
      }
      return {
        ok: true,
        content: `Captured screenshot of tab ${tabId}.`,
        contentParts: [
          { type: 'text', text: `Screenshot of ${res.json?.title || res.json?.url || tabId}` },
          { type: 'image', data: res.json.data, mimeType: res.json.mimeType || 'image/jpeg' },
        ],
        data: { tabId, mimeType: res.json.mimeType || 'image/jpeg' },
      }
    } catch (err: any) {
      return { ok: false, content: `Studio bridge error: ${err?.message || err}`, error: 'bridge error' }
    }
  }
}