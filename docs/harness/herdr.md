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
- **Hermes chats too.** A Studio Hermes chat opens in herdr as
  `hermes chat --resume <session> --create-if-missing`
  (`modules/hermes/services/herdr-launch.ts`, branched in `bootstrap/herdr.ts`):
  Studio drives the Hermes agent with the Studio session id as the agent
  session id, so the pane resumes the same conversation, and herdr's own
  `hermes` integration reports it back for linking. Replies typed in the pane
  reach Studio's chat view only for agents with transcript mirroring
  (claude-code, codex today). Ekko chats cannot open in herdr: the ekko agent
  is an embedded runtime with no terminal CLI, and herdr's supported agent
  kinds are fixed in its binary (no `ekko`).
- **Every chat is a herdr space.** With `chatSpaces` on (default), each
  Studio chat (not archived, not a sub-chat, group chat or workflow) has its
  own herdr space, labeled with its folder path (`Clients / site / Title`) and
  kept in Studio's folder order (`services/herdr/chat-spaces.ts` plans,
  `bridge.syncChatSpaces` applies). A chat whose agent is not running sits in
  a waiting pane (`bin/herdr-plugin/studio-chat.sh`, plain `sh`, ~0.2 MB
  each): it shows the chat's last messages, reports itself to herdr as the
  chat's idle agent (Ekko chats as `ekko`) and resumes the agent in place on
  Enter (`studio-herdr.mjs resume` → `POST /plugin/resume`). The waiting pane
  reports its own command as its resume command, so a herdr restart brings it
  back; one that still goes silent for 20 s is rebuilt. Renames, folder
  moves and deletes in Studio follow within seconds.
- **One writer per conversation.** While a chat is live in a pane, Studio's chat
  box sends to the pane (`agent.prompt`); replies return through the transcript
  mirror. A blocked agent (approval/question on screen) is never typed into.
- **Status.** Chat rows use herdr's glyphs (`◐ × ✓ ○ ·`, see
  `components/common/AgentStatusIcon.vue`); `packages/shared/session-state.ts`
  merges Studio run state, pending approvals and herdr pane status.
- **Swap.** Studio → herdr: the Chat | herdr switch at the top of Chats (there
  is no separate herdr nav item; `/herdr` redirects to Chats in herdr mode,
  `/herdr?pane=<id>` to that pane's chat, `/herdr?tab=settings` to Agents → herdr)
  and the chat header button. herdr's settings, remote machines and Pondering
  Orb's address are on the agents page (`/studio/agents/herdr/settings`). herdr → Studio: the generated plugin `studio.hermes`
  ("Open in Studio", "Studio chats", "Start agent with Studio").
- **Studio tools in herdr agents.** Studio's MCP servers read a short-lived
  per-profile login (`profiles/<profile>/.model-run-token`, 1 hour), which
  Studio runs write before starting an agent. The bridge writes it on every
  herdr launch and refreshes it at most every 15 minutes while any herdr agent
  works (`HerdrBridgeDeps.grantAgentAccess`), for the admin using herdr or,
  after a restart, the first active super admin.
- **Models and MCP.** Launches from Studio or the plugin use
  `prepareCodingAgentInteractiveLaunch`, i.e. the same provider routing
  (including custom OpenAI-compatible providers such as llama-swap), MCP
  servers and rules prompt as Studio runs.

## Install, start and setup

- **Install.** Agents → herdr → Settings → "Install herdr" downloads the release named in
  `https://herdr.dev/latest.json` for this OS/CPU, checks its SHA-256 and puts
  it in `HERMES_WEB_UI_HOME/herdr/bin` (`services/herdr/install.ts`). Tests and
  mirrors can point `HERDR_MANIFEST_URL` at another manifest.
- **Auto-start.** The first time Studio starts with herdr available it turns the
  integration on. With `autoStart` (default on) Studio starts a detached
  `herdr server` whenever it starts; startup errors from herdr are shown in
  status instead of "not running".
- **Setup** (`HerdrManager.setup`, once per herdr version, or "Set up herdr"):
  session integrations for the agents Studio has installed, the `studio.hermes`
  plugin, and a key for the Studio chat picker.
- **Key.** `prefix+s` is herdr's Settings, so Studio takes the first free key of
  `prefix+shift+s`, `prefix+alt+s`, `prefix+a`, `prefix+y`, `prefix+shift+a`,
  `prefix+f9`, checked against `herdr --default-config` and the user's
  `config.toml` (`services/herdr/keybind.ts`). The edited config is validated
  with `herdr config check` and restored if herdr rejects it.
- **Profile.** Chats created from herdr go to the `default` profile. Change it in
  Studio's herdr settings or inside herdr: Studio chats → `s`, or the
  "Studio settings" plugin action.

## Mission view

`/mission/` is a second web page (`packages/client/mission.html`,
`packages/client/src/mission/`) for running herdr from a browser: a space tree
with folders on the left (the herdr-space-folders layout), agents and live
terminals in the middle, and work sources on top (Studio chats, Pondering Orb
tasks and plans, projects, ideas, upkeep, and Control).

- **One port for the tunnel.** Mission is served by Studio's own server at
  `<studio>/mission/`, so a Cloudflare tunnel to Studio's port serves it with
  no extra route; the terminal stream uses Studio's Socket.IO. Studio also
  listens on `HERDR_MISSION_PORT` (default 5180, `0` turns it off) and serves
  Mission at `/` there, with its own sign-in.
- **Folders are Studio's chat folders, 1:1** (`mission/useFolders.ts`). The
  tree is Studio's session categories (same names and nesting; changes in
  either show in the other). Mission keeps only extras per folder (color, start
  directory, collect rules, folded) in `HERMES_WEB_UI_HOME/herdr/space-folders.json`,
  keyed `c<category id>` (`services/herdr/folders.ts`,
  `GET/PUT /api/coding-agents/herdr/folders`). A space sits in the folder of a
  chat running in it, else where it was dropped, else the folder whose start
  directory or rules match its directory most deeply (paths match as prefixes,
  names like `client-*` at any depth). Dropping a space on a folder also files
  its chats there in Studio; dropping a folder on a folder nests it. Folders
  from before this were turned into Studio folders of the same name.
- **Start from a card.** Each task, project or idea card has a button per
  installed agent. Studio opens a herdr space for it and types the card as the
  agent's first prompt once herdr reports the agent idle
  (`HerdrBridge.launchAgent` → `promptWhenReady`). The card remembers its pane,
  so a second click goes to that agent instead of sending the task again.
- **Orb follows the agent.** A launch can name the Orb task or project it is
  for (`orb` in `POST /api/coding-agents/herdr/agents`). From the agent's first
  `working`, every herdr status change is sent to Orb (`orb_set_agent_status`:
  working, blocked, done, idle, then gone when the pane closes), shown in Orb
  and Mission with herdr's glyphs and colors. The first working marks the task
  in progress (CalDAV `STATUS:IN-PROCESS`) or moves the project to active; gone
  puts an unfinished task back to open (`HerdrBridgeDeps.workStatusChanged`,
  wired in `bootstrap/herdr.ts`). Entries live in the bridge state file, so a
  Studio restart does not lose them.
- **Project folders.** Work for an Orb project (or a task whose list is the
  project) starts in the start directory of the Studio folder with the
  project's name, and its chat is filed in that folder
  (`HerdrBridgeDeps.folderForWork`).
- **Studio ↔ Mission.** "Open in herdr" and the herdr center's Open Mission link open Mission
  (`utils/mission-url.ts`); Mission's "Back to Studio" returns.
- **herdr in the chat center.** The chat header's Chat | herdr switch swaps
  only the center column (`components/coding-agents/herdr/HerdrCenter.vue` in
  `ChatPanel.vue`) to herdr's own full UI (a `client` terminal stream), opened
  on the chat's agent: Studio focuses the chat's pane first and again when you
  switch chats. herdr's sidebar, key bar, pickers and settings all work. The
  bar above it has one-tap Search (goto), Workspaces (navigate mode, with
  herdr's key bar), herdr settings and Keys buttons that press the user's herdr
  keys (`readHerdrKeys` reads `[keys]` from herdr's config, herdr defaults
  otherwise; `utils/herdr-keys.ts` turns them into terminal bytes), and "Open
  this chat in herdr" for a chat not running there. Sidebar, header and tool
  panel stay; both centers stay mounted once opened and herdr stays connected,
  so swapping is instant; the choice is remembered (`studio_chat_center`).
- **Every Studio chat in herdr mode.** The Spaces tree also lists Studio chats
  that are not running in herdr, in their folders (`TreeChat`, `useStudioFolders().chats`;
  chats not in a folder under "Other chats"). Picking a coding-agent chat opens
  it and herdr mode starts it in herdr, resuming its native session, so chats
  made before herdr (or after herdr restarted empty) need no remaking; their
  history is already in Studio. Hermes/Ekko chats open in the Chat view.
- **Switch availability.** Chat | herdr shows for super admins whenever herdr
  is on, whichever chat is open (`herdrCenterAvailable` in `ChatPanel.vue`).
  With no herdr chat open (a Hermes chat, nothing selected, or the New Chat
  page, which herdr mode closes), the herdr center shows herdr's own focus, the
  Spaces tree and a hint (`sessionId` ''); picking an agent or switching
  agents inside herdr opens that agent's Studio chat. While the next chat
  loads, the center keeps its chat, so herdr does not reconnect; a saved herdr
  mode stays while herdr's status loads.
- **herdr mode layout.** In herdr mode the chat list closes (the page sidebar
  is not shown) and the herdr center is: a rail with Mission's Spaces tree
  (Studio's folders 1:1) and Agents list (`HerdrSpacesPanel.vue`), then herdr's
  own UI. The rail starts with New chat (the chat list's, which herdr mode
  hides). On phones (768px and under) there is no room for the rail, so the
  chat list stays in the menu drawer. Picking a space or agent focuses it in
  herdr and opens its Studio chat; the center stays mounted while the chat switches, so herdr does not
  reconnect. herdr's own sidebar starts hidden in Studio only: the embedded
  client connects through Studio's own links to herdr's sockets
  (`services/herdr/client-view.ts`, `HERDR_SOCKET_PATH`), and herdr keeps client
  preferences per socket path, so Studio gets its own preferences file (seeded
  with `sidebar_collapsed`) while a terminal herdr keeps its sidebar. herdr's
  4-column collapsed rail is cropped off the left edge (`HerdrTerminal`
  `cropLeft`), unless herdr's config uses `sidebar_collapsed_mode = "hidden"`
  or the view is at or under herdr's phone layout width (`readHerdrView`).
  Windows (named pipes) keeps the shared preferences.
- **Chats made in herdr are Studio chats.** herdr's Studio chats picker and
  "New Studio chat" are bound to free herdr keys at setup (`STUDIO_CHATS_BINDING`,
  `STUDIO_NEW_CHAT_BINDING` in `keybind.ts`; herdr's own `prefix+c` stays a plain
  shell tab, which becomes a chat once an agent in it gets its first message).
  `HERDR_SETUP_REVISION` reruns setup once on existing installs when it gains a
  step. Every chat herdr makes is filed in its space's Studio folder: the folder
  of another chat in the same space, else Mission's placement or the folder whose
  start directory or rules match (`categoryForSpace`, server `folderFor`). In
  herdr mode, New chat opens herdr's New Studio chat picker in the view (Studio's
  new chat page when that key is missing or the view is not connected).
- **Studio follows herdr.** In herdr mode the open chat follows herdr's focused
  pane (the bridge subscribes to herdr's focus events), so switching agents in
  herdr (search, picker, a new chat) switches the Studio chat. Focus reports that
  disagree with a focus Studio asked for in the last 2.5 seconds are stale and
  ignored (`studioFocusRequest`), and the first report after loading is not a
  switch. The plugin focuses through Studio (`POST /plugin/focus`, again after
  its popup closes, since herdr gives focus back to the pane under a popup);
  `herdr pane focus` only moves by direction.
- **Opening chats in herdr mode.** A chat whose agent is not running in herdr
  opens there by itself when shown in herdr mode (once per chat;
  `HerdrCenter` keeps "Open this chat in herdr" for a retry).
- **herdr's welcome screen.** Studio's setup sets herdr's top-level
  `onboarding = false` when the config does not say either way (Studio has
  already installed the agent integrations the welcome walks through). The
  herdr settings tab has "Show herdr's welcome screen" (`PUT
  /api/coding-agents/herdr/welcome`, `setHerdrWelcome` in `keybind.ts`, same
  backup and `herdr config check` as the keybinding). It is herdr's own option,
  so it applies to every herdr client.
- **herdr remote.** herdr settings → Remote machines lists herdr's saved SSH
  machines and adds, enables/disables or removes them (`services/herdr/machines.ts`,
  herdr's own `machine` commands; SSH key login must already work). In herdr
  mode a Local | machine switch opens a machine's full herdr in the center
  (`terminal.open` client on `machine:<id>` runs `herdr --remote <target>`), and
  the Agents panel lists each machine's agents (`herdr --machine <id> agent list`,
  every 15 seconds); picking one focuses it there (`agent focus`). Remote agents
  are used in that machine's herdr; they are not Studio chats.
- **One Orb form.** `HerdrOrbSettings.vue` is shown in herdr settings and in
  Mission's Control tab.
- **Testing remote without SSH.** A stand-in `ssh` on PATH that runs the remote
  command locally with another `HOME` (a second herdr server) lets `machine add`,
  `--machine` and `--remote` run for real; herdr only probes a remote PowerShell
  first, which fails harmlessly.
- **Chat mode of herdr chats.** A chat herdr starts is Studio-routed
  (`agent_mode` `scoped`) only when launched with a real provider; native
  launches report the provider as `global` and are stored `global`
  (`herdrChatMode`), so Studio can resume or reopen them after their pane
  closes. Startup repairs older herdr chats stored `scoped` without a model
  (`repairHerdrChatModes`).

## Pondering Orb

Studio connects to a Pondering Orb (`services/orb/client.ts`) with its URL and
an API token from Orb's `ORB_API_TOKENS`, set in Mission → Control or with
`ORB_URL` and `ORB_TOKEN`. The token is stored 0600 in
`HERMES_WEB_UI_HOME/orb/settings.json` and never returned to browsers.

- `GET /api/studio/orb` (status), `PUT /api/studio/orb/settings`: super admin.
- `GET /api/studio/orb/data/:kind`, `POST /api/studio/orb/tools/:name`: admin;
  only the kinds in `ORB_DATA_PATHS` and the tools in `ORB_TOOLS` pass.
- Agents read and update Orb through Studio's MCP `use` toolset:
  `ekko_studio_use_orb_read` (tasks, projects, logs, chores, ideas, upkeep,
  uptime, system) and `ekko_studio_use_orb_update` (add/complete tasks, add
  logs, move projects, task priority, chores).
- The other way, Orb's Agents tab lists herdr agents through Studio and sends a
  task or project to a new agent (`POST /api/coding-agents/herdr/agents` with a
  prompt and `orb`).
- Links from Orb into Studio use `publicUrl` from `GET /api/coding-agents/herdr`:
  `HERMES_WEB_UI_PUBLIC_URL`, else the last public https address a browser
  used to reach Studio (its tunnel), else the last browser address. Only
  browser requests (with `Sec-Fetch-Mode`) are counted.

## Code map

| Area | Path |
| --- | --- |
| Socket client, NDJSON | `modules/coding-agents/services/herdr/socket-client.ts` |
| Pane ↔ chat reconciliation, transcript mirror | `services/herdr/bridge.ts` |
| Settings, binary/server discovery | `services/herdr/runtime.ts`, `manager.ts` |
| Plugin manifest/token | `services/herdr/plugin.ts`, `bin/herdr-plugin/studio-herdr.mjs` |
| Install, keybinding | `services/herdr/install.ts`, `services/herdr/keybind.ts` |
| Routes / socket | `routes/herdr.ts`, `controllers/herdr.ts`, `sockets/herdr.ts` |
| Studio wiring | `bootstrap/herdr.ts`, `studio/public/session-status.ts` |
| UI | `views/hermes/HerdrView.vue`, `components/coding-agents/herdr/*` |
| Mission page | `packages/client/mission.html`, `packages/client/src/mission/*`, `bootstrap/http.ts` |
| Space folders | `services/herdr/folders.ts` |
| Chat spaces, waiting pane | `services/herdr/chat-spaces.ts`, `bin/herdr-plugin/studio-chat.sh` |
| Pondering Orb | `modules/studio/services/orb/client.ts`, `studio/routes/orb.ts`, `studio/controllers/orb.ts` |

Rules that keep it safe:

- Settings live in `HERMES_WEB_UI_HOME/herdr/settings.json`. All Studio routes
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

- Unit: `tests/server/herdr-*.test.ts` (fake herdr socket server, installer
  with a fake manifest, key choice against `fixtures/herdr-default-config.toml`),
  `tests/server/session-state-sync.test.ts`, `tests/client/agent-status.test.ts`.
- Unit: `tests/server/herdr-folders.test.ts`, `tests/server/orb-client.test.ts`,
  `tests/server/herdr-public-url.test.ts`
  (fake Orb).
- Unit: `tests/server/herdr-client-view.test.ts` (Studio's own herdr client preferences),
  `tests/client/mission-folders.test.ts` (tree and space placement),
  `tests/client/herdr-keys.test.ts` (key buttons).
- Browser: `tests/e2e/herdr-view.spec.ts`, `tests/e2e/mission.spec.ts`,
  `tests/e2e/herdr-center.spec.ts`, `tests/e2e/herdr-spaces.spec.ts` (mocked API).
- Live: build herdr (`cargo build --release`, needs Zig 0.16), run Studio with an
  isolated `HERMES_WEB_UI_HOME` and `CLAUDE_CONFIG_DIR`, enable herdr with a named
  session, and drive agents with herdr's CLI (`pane run`, `send-text`). Keep the
  test `HOME` short: herdr's Unix socket path must fit in 108 bytes. A real or
  stand-in agent must run in the pane for `agent.prompt` and detection to work.
