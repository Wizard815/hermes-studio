# Watcher

The watcher ties together the guards Studio already has. It is one list of
what they did, a bell to read it, and "Trust this" rules. It is not a second
approval system, and it never stops a run by itself.

## What the user sees

- **The bell** (super admins): at the end of Studio's top bar, with the
  unread count. On the herdr page with Studio's top bar hidden, it is on
  herdr's own bar. On a phone it is in the menu drawer's rail and in herdr's
  ⋯ menu, with its count; there it opens the list as a dialog.
- **The list**: newest first. Each alert has a severity word (Info, Warning,
  Blocked), what kind it is, when, a short text, and buttons: Open chat (or
  Open task), Trust this (for approvals), Langfuse (when on), Mark read,
  Remove. At the top: Mark all read, Clear.
- **Settings → Watcher**: which events alert in the bell and which also go to
  Mattermost, how many alerts are kept and for how long, the trust rules
  (list, Remove, Add a rule), scheduled jobs' rule, and the extras.
- **Settings → Clean rooms**: the clean-room settings that were API-only
  (network and allowed hosts, walls and checks, user, capabilities, image,
  CPUs, memory, processes). See [cleanroom.md](cleanroom.md).
- **Connections → Agent work**: "How each task's agent asks" lets each open
  task pick inherit, ask, guarded or auto.

## What makes an alert

| Event | Comes from | Severity | Bell | Mattermost |
| --- | --- | --- | --- | --- |
| Approval asked / denied | every chat type's `approval.requested` / `approval.resolved` (Hermes, Ekko, coding agents) | warn / block | on | off |
| Approval given | same | info | off | off |
| Allowed by a trust rule | the approval paths below | info | off | off |
| Run limit hit, loop stopped | run limits ([agent-limits.md](agent-limits.md)) | block | on | **on** (the `#agentlimit` post as before) |
| Clean room: possible secrets | the leak check when a room starts | warn | on | off |
| Clean room: connection blocked | the room's allowlist proxy | block | on | off |
| Agent work waiting / blocked / decided | Agent work | warn / warn / info | on / on / off | off |
| Plugin install failed | recommended Hermes plugins | warn | on | off |
| Connection problem | herdr not starting, pipelock not answering, InnerWarden hook missing | warn | on | off |
| pipelock blocked | pipelock refusing a clean-room connection | block | on | off |

The same alert (kind, chat, text) again within a minute is dropped, so a
retrying agent does not fill the bell. Mattermost posts go to the channel set
in Connections → Agent work, with its mentions; with no channel set, nothing
is posted. There are no new channel or mention settings.

History: `watcher_events` in Studio's database, 500 alerts and 30 days by
default (Settings), pruned on every insert and every 6 hours.

## Trust rules

A rule is `kind + scope + pattern + expires`:

- **kind**: `command` (the command line), `write` (every written path must
  match) or `tool` (the tool's name).
- **scope**: `chat` (a chat id), `task` (an Agent work id: the chats it runs
  in), `agent` (`claude-code`, `codex`, `hermes`, `ekko`, ...) or `folder` (a
  full path; the chat's folder must be inside it).
- **pattern**: `*` matches anything, the rest must match exactly (`npm run *`,
  `rm /srv/cache/*`). A bare `*` is only allowed for one chat or one task.
- **expires**: never, or a time.

Rules live in `HERMES_WEB_UI_HOME/watcher.json` with the watcher's settings.
They feed the approval paths that already exist; nothing else reads them:

- coding agents: `run-manager.ts` `askApproval` (and Pi's confirm), after the
  agent's mode and "for this chat" answers;
- Ekko: `waitForEkkoToolApproval`;
- Hermes chats: when the bridge sends `approval.requested`, Studio answers
  "once" through the bridge, as the Approve button would. Home Assistant
  actions in Hermes chats ask the same way; their rule is a `tool` rule on the
  service (`light.*`, `light.turn_on`), see
  [hermes-integrations.md](hermes-integrations.md#home-assistant-actions-ask-first).

A match is answered once and noted as "Allowed by a trust rule".

## Auto mode and hard stops

Auto mode never reaches the watcher: an agent in auto never asks, and trust
rules only answer questions. What stops a run is what stopped it before: run
limits, a clean room's blocked hosts, and pipelock when you turn it on.

## A task's or a job's approval mode

- **Agent work task**: its mode is its chat's own mode, the one `/yolo` sets
  (`coding-agent/chat-approvals.json`). Inherit clears it (the agent's mode in
  Settings applies). Hermes chats follow it too: in auto, Studio answers
  Hermes's approvals once. A task without a chat yet has no mode to set.
  API: `GET/PUT /api/studio/watcher/tasks/:id/approval-mode`.
- **Scheduled jobs (Hermes cron)**: nobody is there to ask, so Hermes's own
  `approvals.cron_mode` decides for every job of a profile: `deny` (Hermes's
  default, the command is blocked) or `approve`. Hermes has no per-job
  setting; put jobs that need another rule in another profile. Settings →
  Watcher changes it for the current profile
  (`GET/PUT /api/hermes/jobs/approval-mode`).

## Extras (each off by default)

| Extra | What it does | What it needs | When it is missing |
| --- | --- | --- | --- |
| pipelock | Clean-room connections go out through pipelock's HTTP proxy (`openUpstream` in `cleanroom/index.ts`). A 403 from it is a block and an alert. | pipelock running as an HTTP proxy at the URL in Settings (default `http://127.0.0.1:8888`). To look inside HTTPS it needs its own TLS interception and CA, set up in pipelock. | Rooms go out without it and the bell says "pipelock is on but does not answer". |
| InnerWarden | Status only. Studio checks Hermes's `config.yaml` for the guard's `pre_tool_call` hook and alerts when it is on here but missing. | The `innerwarden` program on Studio's PATH and `innerwarden agents connect hermes` run once. Studio does not run it. | "Not available here: the innerwarden program is not installed". |
| Langfuse | Alerts for Hermes chats link to the chat's Langfuse session (the official plugin uses Hermes's session id). | `HERMES_LANGFUSE_PUBLIC_KEY`, `HERMES_LANGFUSE_SECRET_KEY` (and `HERMES_LANGFUSE_BASE_URL` for your own server) in the profile's `.env`. Studio asks Langfuse once for the project id. | No link. |

What was tested here: pipelock's wiring with a stand-in proxy that refuses
(not real pipelock, which is not installed here); InnerWarden and Langfuse
only with unit tests (neither is installed or has keys here).

## Where things live

- Shared types: `packages/shared/watcher.ts`.
- Server: `modules/studio/services/watcher/` (`store.ts`, `config.ts`,
  `trust.ts`, `extras.ts`, `service.ts`, `index.ts`), facade
  `modules/studio/public/watcher.ts`, API `routes/watcher.ts`
  (`/api/studio/watcher/*`, super admins), wiring `bootstrap/watcher.ts`.
- Sources: `sockets/chat-run.ts` (approvals), `bootstrap/run-limits.ts`,
  `coding-agents/services/cleanroom/index.ts`, `agent-work/index.ts`,
  `hermes/services/plugins/recommended.ts`, `bootstrap/herdr.ts`.
- Live updates: the chat-run socket's `watcher` room (`watcher.event`,
  `watcher.changed`).
- Client: `components/watcher/` (bell, list, dialog, trust dialog, task
  modes), `components/hermes/settings/WatcherSettings.vue`,
  `CleanRoomSettings.vue`, strings in `i18n/watcher-messages.ts`.

## What goes wrong

- The bell is for super admins. Other users see no bell.
- `watcher.json` is read once and kept: edit rules in Settings, not the file,
  or restart Studio after editing it.
- A trust rule for an agent uses Studio's agent ids (`claude-code`, not
  `claude`).
- Hermes cron jobs cannot use trust rules or a per-job mode (see above).

## Tests

`tests/server/watcher.test.ts` (history and pruning, settings, approvals from
the event stream, Agent work, trust rules in the run manager and Ekko, a
task's mode, auto mode never blocked, clean-room blocks and pipelock,
extras). `tests/e2e/watcher.spec.ts` (bell, Trust this, both Settings
screens, phone menu).
