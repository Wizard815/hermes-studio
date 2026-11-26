# Run limits (agent limits)

Run limits stop a runaway agent in any Studio chat: Hermes (bridge), Ekko and
coding agents, including coding agents in herdr panes that use Studio's model
gateway. The idea comes from [Hermeskill](planning/ideas/hermeskill.md)
(kill switches for loops, cost and time); nothing of its code is used.

## What the user sees

- **Settings → Agent → Run limits** (super admins change it; everyone sees it):
  cost per run (USD), tokens per run, time per run (minutes) and the loop
  detector (same tool call with the same arguments N times in a row, or the
  same call failing N times). Defaults: cost, tokens and time **off**; loop
  detector **on at 5**.
- **Per chat:** chat header menu → **Run limits** (each limit: Settings / Off /
  Custom), or `/limits` in the chat (any chat type):
  - `/limits` shows this chat's limits, where each comes from, and this run so far
  - `/limits cost 2 tokens 500k time 30 loop 8` sets this chat's own
  - `/limits cost off` turns one off for this chat, `/limits cost default` follows Settings again
  - `/limits off` turns every limit off for this chat (yolo), `/limits reset` follows Settings
- **When a limit is hit:** the run stops the way Stop stops it for that chat
  type; the chat gets a line saying which limit and the numbers (a command
  result, so it never reaches the model); the chat shows **blocked** (×) in
  the chat list and in every view that reads the chat's state
  (`SessionListState.blocked`, which an Inbox of blocked chats uses too), and
  in herdr (its linked pane reports `blocked`); a card above the composer offers **Continue
  with a higher limit** (double the limit, saved as the chat's own) and **Stop**.
  Continue sends "Continue where you left off." to the agent the usual way for
  that chat (Studio run, or its herdr pane). Sending any new message also
  clears the block.
- **Mattermost (optional):** when Connections → Agent work has a Mattermost
  channel, a `#agentlimit #blocked` post goes there with Agent work's
  @mentions. Nothing is posted otherwise.

## How each chat type is covered

| Chat | Counted from | Stopped by |
| --- | --- | --- |
| Hermes (bridge) | tool events and per-call usage the bridge reports | Studio's Stop (`handleAbort`) |
| Ekko | the Ekko runtime's tool events and per-call usage | Studio's Stop |
| Coding agents run by Studio | their tool events and the gateway's measured usage (scoped mode) | Studio's Stop, and the gateway refuses the next request |
| Coding agents in herdr panes | the model gateway: each request's history (loop), its responses' usage (tokens, catalog price), time from the turn's first request | the gateway answers the next request with HTTP 400 and the limit message; the agent shows it and ends its turn |

Gateway-only runs are keyed by the chat and the turn (the user's last
message); a new prompt typed in the pane is a new run and also clears the
block. They end after 15 minutes without a request.

## Where things live

- Shared types: `packages/shared/run-limits.ts` (`RunLimits`, `RunLimitHit`).
- Server: `modules/studio/services/run-limits/` — `settings.ts`
  (`HERMES_WEB_UI_HOME/run-limits.json`: Settings' limits, chats' own, and
  chats still blocked by a limit),
  `tracker.ts` (one active run per chat), `loop-detector.ts`,
  `gateway-history.ts` (reads the current turn from chat-completions,
  Responses, Anthropic and Gemini bodies), `service.ts` (what a hit does,
  `/limits`), `index.ts` (process singleton).
- Wiring: `bootstrap/run-limits.ts` (Stop, chat notice, recorded usage via
  `onSessionUsageRecorded` in `usage-recorder.ts`, herdr
  `HerdrBridge.reportChatLimit`, Agent work `alertBlocked`).
- Events: `sockets/chat-run.ts` wraps `observeChatRunWebhookEvent`, the one
  sink every chat type's run events pass through; `handleAbort` reports Stop.
- Gateway: `middleware/model-gateway.ts` (`checkGatewayRunLimits` before each
  request), `coding-agents/protocol/run-limit-usage.ts` (usage of responses).
- Blocked state: `public/session-status.ts` (`setSessionLimitHit`) →
  `SessionListState.limit` / `blocked` (`services/session-state.ts`).
- API: `GET/PUT /api/studio/run-limits` (PUT super admin),
  `GET/PUT /api/studio/run-limits/chats/:id`, `POST …/continue`, `POST …/stop`.
- Client: `components/hermes/settings/RunLimitsSettings.vue`,
  `components/hermes/run-limits/` (banner, chat modal), strings in
  `i18n/run-limits-messages.ts`.

## Limits of the limits

- Cost counts only calls with a known price (manual price, provider report or
  models.dev catalog); unpriced calls still count for tokens. Tokens include
  cache reads, so long agentic runs reach a token limit sooner than the bill.
- Time counts wall-clock time, including time waiting on an approval.
- Coding agents in **global** mode (their own provider config, not Studio's
  gateway) report usage only at the end of a turn and are not seen by the
  gateway: their tool events still feed the loop detector and time limit.
- Hermes chats opened in herdr run Hermes's own CLI (not through Studio), and
  agents started in herdr without a Studio chat have no chat to limit.
- A blocked chat stays blocked after Studio restarts, until Continue or Stop:
  the hit (and the agent turn it caught) is saved in `run-limits.json`
  (`blocked`) and restored on start (`RunLimitService.restoreBlocked`). A run
  that was running when Studio stopped is not counted on; only the block is.
- The limit is checked after each model call or tool event, so a run can go
  one call past it (the token limit in a run of 42k-token calls stops at 126k
  for a 100k limit). The time limit is checked every 5 seconds.
- A gateway-only run counts cost with the Usage page's manual price for the
  exact provider and model, then the models.dev catalog, like recorded usage.

## Live test with a stub model

No paid calls: point a test Studio's Hermes config at a local
OpenAI-compatible stub that answers with a tool call. The same call with `{}`
each time trips the loop detector; big `usage` numbers trip tokens and cost
(set a manual price on the Usage page); a 4 s delay per answer trips a time
limit of `0.2` minutes. A coding agent outside Studio's runs (as in a herdr
pane) can be tried with `claude -p … --settings <run settings.json>` from
`HERMES_WEB_UI_HOME/providers/…/claude-code/runs/`: the agent prints
`API Error: 400 Run stopped by Studio: …` and ends its turn.

What goes wrong when setting it up:

- Hermes Agent's dependencies are pinned for Python 3.14 only; a 3.13 venv
  installs none and the bridge fails with `No module named 'dotenv'`.
- The bridge socket defaults to `/tmp/hermes-agent-bridge.sock`, shared by
  every Studio on the machine; set `HERMES_AGENT_BRIDGE_ENDPOINT` per test
  Studio. If the bridge starts without `--agent-root`, link the Hermes Agent
  source to `<HERMES_HOME>/hermes-agent`.

## Tests

`tests/server/run-limits.test.ts` (detector, gateway history, settings, each
limit firing, Continue, gateway refusal and new turn, `/limits`).
`tests/e2e/run-limits.spec.ts` (Settings section and the limit card).
