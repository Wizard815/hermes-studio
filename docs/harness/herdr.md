# herdr integration

[herdr](https://herdr.dev) is a terminal runtime for coding agents: persistent
panes, working/blocked/idle detection, and a local socket API. Studio and herdr
stay separate apps; this integration links them.

## What it does

- **Chats follow agents both ways.** A chat is linked to a herdr pane through
  the agent's own session id (`sessions.agent_native_session_id` in Studio,
  `agent_session` in herdr). An agent started in herdr becomes a Studio chat
  once it does something (`herdr-<native id>`); a Studio chat opened in herdr
  resumes the same native session (`claude --resume`, `codex resume`).
- **One writer per conversation.** While a chat is live in a pane, Studio's chat
  box sends to the pane (`agent.prompt`); replies return through the transcript
  mirror. A blocked agent (approval/question on screen) is never typed into.
- **Status.** Chat rows use herdr's glyphs (`◐ × ✓ ○ ·`, see
  `components/common/AgentStatusIcon.vue`); `packages/shared/session-state.ts`
  merges Studio run state, pending approvals and herdr pane status.
- **Swap.** Studio → herdr: nav rail "herdr" (full herdr UI over a PTY) and the
  chat header button. herdr → Studio: the generated plugin `studio.hermes`
  ("Open in Studio", "Studio chats", "Start agent with Studio").
- **Models and MCP.** Launches from Studio or the plugin use
  `prepareCodingAgentInteractiveLaunch`, i.e. the same provider routing
  (including custom OpenAI-compatible providers such as llama-swap), MCP
  servers and rules prompt as Studio runs.

## Code map

| Area | Path |
| --- | --- |
| Socket client, NDJSON | `modules/coding-agents/services/herdr/socket-client.ts` |
| Pane ↔ chat reconciliation, transcript mirror | `services/herdr/bridge.ts` |
| Settings, binary/server discovery | `services/herdr/runtime.ts`, `manager.ts` |
| Plugin manifest/token | `services/herdr/plugin.ts`, `bin/herdr-plugin/studio-herdr.mjs` |
| Routes / socket | `routes/herdr.ts`, `controllers/herdr.ts`, `sockets/herdr.ts` |
| Studio wiring | `bootstrap/herdr.ts`, `studio/public/session-status.ts` |
| UI | `views/hermes/HerdrView.vue`, `components/coding-agents/herdr/*` |

Rules that keep it safe:

- Off by default (`HERMES_WEB_UI_HOME/herdr/settings.json`). All Studio routes
  and the `/herdr` namespace are super-admin only.
- Plugin routes (`/api/coding-agents/herdr/plugin/*`) are registered before user
  auth and accept only loopback requests with the plugin's own token
  (`herdr/plugin-token`, 0600, copied to herdr's plugin config dir).
- herdr is driven with argv arrays (`execFile`, `layout.apply` commands); pane
  targets are validated before reaching the CLI.
- The bridge treats herdr events as invalidation and re-reads
  `session.snapshot`; on `events_lost` it resubscribes and reconciles.
- Deleting a chat whose agent is still live unlinks it and records the native
  id so it is not re-imported.

## Testing

- Unit: `tests/server/herdr-*.test.ts` (fake herdr socket server),
  `tests/server/session-state-sync.test.ts`, `tests/client/agent-status.test.ts`.
- Browser: `tests/e2e/herdr-view.spec.ts` (mocked API).
- Live: build herdr (`cargo build --release`, needs Zig 0.16), run Studio with an
  isolated `HERMES_WEB_UI_HOME` and `CLAUDE_CONFIG_DIR`, enable herdr with a named
  session, and drive agents with herdr's CLI (`pane run`, `send-text`). A real or
  stand-in agent must run in the pane for `agent.prompt` and detection to work.
