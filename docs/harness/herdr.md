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
  `hermes chat --resume <session> --create-if-missing` (in the chat's
  profile, on its model: see "Profiles and models")
  (`modules/hermes/services/herdr-launch.ts`, branched in `bootstrap/herdr.ts`):
  Studio drives the Hermes agent with the Studio session id as the agent
  session id, so the pane resumes the same conversation, and herdr's own
  `hermes` integration reports it back for linking. Replies typed in the pane
  reach Studio's chat view only for agents with transcript mirroring
  (claude-code, codex today).
- **Ekko (and Hermes without its CLI) in herdr.** These agents have no
  terminal CLI, so their chat's pane talks to Studio instead:
  `studio-herdr.mjs chat <id>` gets a short-lived login and the chat's run
  fields (`POST /plugin/chat`, `bridge.prepareChat`, `chatAccess` and
  `chatRunFields` in `bootstrap/herdr.ts`) and sends each line as a turn of
  Studio's own chat run (`/chat-run` socket), so the reply streams in the pane
  and the same turn shows in Studio. Approvals and questions are answered on
  the next line (`once`, `session`, `always` or `deny`; anything else denies).
  The pane reports itself to herdr as `hermes`
  (working, blocked, idle). Ctrl-C stops a reply, Ctrl-D goes back to the card.
- **Every chat is a herdr space.** With `chatSpaces` on (default), each
  Studio chat (not archived, not a sub-chat, group chat or workflow) has its
  own herdr space, named after the chat and
  kept in Studio's folder order (`services/herdr/chat-spaces.ts` plans,
  `bridge.syncChatSpaces` applies). A chat whose agent is not running sits in
  a waiting pane (`bin/herdr-plugin/studio-chat.sh`, plain `sh`, ~0.2 MB
  each): it shows the chat's last messages, reports itself to herdr as the
  chat's idle agent (Ekko and Hermes chats as `hermes`: herdr keeps live
  reports only for agent names it knows) and, on Enter, resumes the agent
  in place (`studio-herdr.mjs resume` → `POST /plugin/resume`; Ekko opens the
  Studio chat client described below). The waiting pane
  reports its own command as its resume command, so a herdr restart brings it
  back; one that still goes silent for 20 s is rebuilt. Renames, folder
  moves and deletes in Studio follow within seconds.
- **Old chats without an agent session.** A coding-agent chat with no saved
  agent session (it never ran, or predates session ids) starts a fresh
  session in herdr; once that agent reports its session, the bridge sends it
  the chat so far (`chatRecap` in `bootstrap/herdr.ts`, newest 16k
  characters; `promptWhenAgentStarted`), so it continues the conversation.
- **One writer per conversation.** While a chat is live in a pane, Studio's chat
  box sends to the pane (`agent.prompt`); replies return through the transcript
  mirror. A blocked agent (approval/question on screen) is never typed into.
  A chat whose space only has its waiting pane (link `waiting: true`) has no
  agent there, so its messages run through Studio as usual.
- **Open in herdr resumes.** Opening a chat whose space only has its waiting
  pane presses Enter there (`openSession`), so its agent resumes in place (or
  Studio's chat client starts, for Ekko/Hermes without the CLI); not while the
  pane already runs `studio-herdr.mjs` (resuming or chatting).
- **Clean rooms in herdr.** See `docs/cleanroom.md`: the pane's docker client
  runs under the agent's name so herdr detects the agent and its status.
- **Limits.** The chat-space list reads every chat in pages (`chatSpaceRows`)
  before the awake filter; a subscription herdr never confirms fails after 5 s
  (`subscribe_timeout`) and the bridge reconnects.
- **One space per chat.** Each chat sync reads a fresh `session.snapshot`
  and remembers the spaces it just made for 30 s, so syncs that follow each
  other (a wake-up right after a sync) never make a chat's space twice.
- Hermes chats resume the whole conversation by Studio's session id, so they
  get no "chat so far" recap.
- The recap Studio types into a fresh session, and the agent's answer to it,
  stay out of the mirrored chat (`withoutRecap`, marker `recaps` in the bridge
  state, 30 minutes).
- Transcripts of agents on Studio's providers live in Studio's config folders
  (`coding-agent/model/<profile>/<provider>/<agent>[/runs/<id>]`, where
  `CODEX_HOME` / `CLAUDE_CONFIG_DIR` point); `findChatTranscript` and clean-room
  session detection look there too.
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
- **Approvals.** Agents in herdr panes ask before acting: launches for herdr
  drop the flags Studio's own background runs use to skip approvals
  (`withApprovals` in `coding-agents/services/index.ts`, e.g. Claude Code's
  `--dangerously-skip-permissions`, Grok's `--always-approve`; OpenCode gets
  `OPENCODE_PERMISSION={"*":"ask"}`, `withApprovalsEnv`). Ekko keeps its own rules (deleting,
  sudo, killing processes, shell source, ...) and asks in the pane.
- **Approvals in Studio chats.** Agents page → each agent's "Approvals":
  ask (default: reading anywhere and writing in the chat's folder go ahead,
  commands and anything else ask), guarded (acts on its own, but dangerous
  actions ask: deleting or moving outside the folder or the folder itself,
  `$VAR` targets, sudo, disk and system tools, killing processes, force
  pushes, resets, downloads piped into a shell, writing outside the folder),
  auto (yolo, also in herdr). `approval-policy.ts` decides; adapters pass
  what the agent wants to do (`AgentAction`). Each agent's own rules decide
  when it asks; Studio answers what the mode doesn't ask you about and shows
  the rest as its approval card (`askApproval` in `runtime/run-manager.ts`: once / for this
  chat / deny, denied after 5 minutes or when the run ends). How each agent
  asks: Claude Code `--permission-prompt-tool stdio` (control requests);
  Codex its app-server (`codex/app-server-turn.ts`); Qwen, Kimi, Copilot,
  Qoder, CodeBuddy, DSH, OpenCode (`opencode acp`) and Grok (`grok agent
  stdio`) ACP `session/request_permission` (`protocol/acp/permission.ts`);
  Pi Studio's Pi extension (`HERMES_PI_ASK`). DSH asks only to leave its
  sandbox, so asking DSH works in its folder. Cursor, Antigravity and Zcode
  cannot ask in print mode: asking means their safe mode, which refuses
  instead (no --force / skip-permissions; Zcode plan mode). Settings:
  `HERMES_WEB_UI_HOME/coding-agent/approvals.json`, `/api/coding-agents/approvals`.
- **Models and MCP.** Launches from Studio or the plugin use
  `prepareCodingAgentInteractiveLaunch`, i.e. the same provider routing
  (including custom OpenAI-compatible providers such as llama-swap), MCP
  servers and rules prompt as Studio runs.

## Profiles and models

- **Starting point: the profile and its default model.** A chat keeps the
  Studio profile it was made in. Opening it in herdr runs its agent in that
  profile: Hermes chats as `hermes chat --resume <session> --create-if-missing`
  with `HERMES_HOME=<profile folder>` (`hermesInteractiveLaunch`), so the CLI
  reads that profile's config and sessions; coding agents through
  `prepareCodingAgentSessionLaunch` with the chat's profile, provider and
  model. A chat with no model of its own runs on the profile's default model
  (`model.default` / `model.provider` in the profile's `config.yaml`, what
  Studio's Models page sets).
- **New chats and agents from herdr** use herdr's profile setting
  (`settings.profile`, `herdrChatProfile`). Empty (the default, and what old
  settings files with `"default"` move to) means *follow Studio*: the profile
  last picked in Studio's switcher, which the client sends with every herdr
  status request (`X-Hermes-Profile` → `noteStudioProfile` →
  `settings.studioProfile`; the herdr store refreshes when the profile
  changes). Pin a profile on Agents → herdr, or in herdr with the plugin's
  settings popup ("Follow Studio" or a profile name). The plugin's "Start
  agent with Studio" offers the profile's default model first (Enter), then
  the agent's own configuration, then any Studio model. A new `hermes chat`
  from herdr runs in that profile on its default model unless a model is picked.
- **Switching the model.** In Studio, the chat's model picker sets the chat's
  model (stored on the chat); every later run and every herdr launch uses it
  (`-m <model> --provider <provider>` for Hermes; Claude Code / Codex get it
  through Studio's launch). In a herdr pane, the agent's own `/model` works
  too. Hermes: `/model` is per session in Hermes, and when the pane ends (or
  before the chat opens in herdr again) Studio takes the Hermes session's model
  as the chat's model, unless the chat's model was changed in Studio since the
  pane started (`herdr-model-sync.ts`: launch records in
  `HERMES_WEB_UI_HOME/herdr/hermes-models.json`, Hermes's model from the
  profile's `state.db`). `/model … --global` in Hermes also changes the
  profile's default. Claude Code / Codex: `/model` in the pane lasts for that
  pane only; the next launch uses the chat's model from Studio, so pick it in
  Studio to keep it. Nothing else overwrites a chat's model: changing the
  profile default only affects chats without a model of their own.
- **Switching the profile.** A chat's profile does not change. To use another
  profile, switch profiles in Studio's profile switcher and start a new chat there, or
  pin the profile in herdr's settings and start the agent from herdr.
- **Local models.** Models page → Local models → "Make default model of
  <profile>" runs Hermes's local-models activate for the picked profile, which
  writes `model.default` and `model.provider: llamacpp` to that profile's
  `config.yaml`: the same profile default as above. Studio lists it under
  "Local models (Hermes Agent)" (`localModelsGroup` in
  `hermes/controllers/models.ts`); Hermes chats run it through Hermes. Coding
  agents cannot reach Hermes's local server through Studio's routing yet.

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
- **Upgrading and containers.** Old chats need no migration: once the new
  build starts and herdr is connected, the chat-space sync gives every chat
  its space (304 chats took about 35 s). Studio re-runs setup when herdr's
  config was lost (the `studio.hermes` plugin is missing), even if its own
  settings say setup is done. When herdr starts over and reuses space ids, a
  waiting space only counts while its own pane is there (`planChatSpaces`
  `panes`). docker-compose keeps `~/.config/herdr` and `~/.local/state/herdr`
  in the data volume, so spaces and agent sessions survive a recreated
  container. The hermes CLI is found through `HERMES_BIN` (set in the image),
  `~/.local/bin` or PATH.
- **Sleep.** Chats used in the last `chatSpacesAwakeDays` days (default 7,
  0 = all) keep a space; older ones sleep with no pane or process
  (`awakeChats`). A sleeping chat wakes into its space when it is opened in
  herdr (Studio's herdr view, Open in herdr, herdr's Studio chats picker,
  which lists every chat with search and pages and marks sleeping ones `z`),
  or when it is used (a message moves its last activity). Any chat herdr has
  a space for can be opened, whatever its agent: chats with no stored agent
  are Hermes chats (older Studio chats), and Ekko chats talk to Studio from
  their waiting pane. Studio offers it in the chat header, the chat list's
  right-click menu (Open in herdr) and the `/herdr` command in the chat box
  (handled by the chat box, never sent to the agent). A chat opened by hand
  (`openSession`) keeps its space after the awake window (`openedChats`;
  older `wokenChats` are read into it) until its space is closed in herdr
  (`closedChatSpaces`: gone while other chat spaces are still there) or the
  chat is archived or deleted. The herdr state lists the chats with a space
  (`chatSpaces`); Studio's chat list marks the others with a small `z`
  (asleep in herdr). A chat whose folder is gone gets its space in the home
  folder (`chatSpaceCwd`). Studio stores chat times in seconds; the chat
  list converts them (`toMs`).
- **Cost.** herdr's own cost is about 0.12% CPU per open pane (304 panes: 41%;
  10: 4%), plus about 0.13 MB per waiting pane. Status updates are followed
  only for panes where an agent really runs: herdr's per-pane status
  subscription costs CPU per pane (10 waiting panes cost 16% before).

## The herdr page (Mission docked)

herdr has one page: Studio's chat page in herdr mode
(`components/coding-agents/herdr/HerdrCenter.vue` in `ChatPanel.vue`). On the
left is Studio's Spaces sidebar (space folders, below; herdr's own sidebar on
request) and in the center herdr's own full UI (a `client` terminal stream):
the focused pane with herdr's keys, search and settings. On
the right, the Tools dock (`HerdrMissionDock.vue`): Command Center's Inbox,
Agents, Files, Board and Skills with a usage strip (see below), then Mission's tools: Chats (every
chat, with the "z" asleep marker; Open in herdr wakes it into its space), and
Pondering Orb's Tasks, Projects, Ideas, Upkeep, plus Control. herdr's bar shares the
chat page's header row (one row with the chat title and the Chat | herdr | Code
| Screen switch, which is the way back to the chat view): the chat's agent and
pane, Open in Studio (the focused pane's chat in the chat view), + New chat,
Reopen closed chat and Tools (the dock) stay in the row; herdr sidebar, Search,
Workspaces, herdr settings and Keys fold into a "More" menu when the header is
narrower than 1560 px. On a phone the row keeps Tools, and the rest is a
"herdr" group in the chat header's own ⋯ menu (one menu in the row). The dock's open/closed state and last tab are
kept per viewer in browser storage (`herdr-layout.ts`, `studio_herdr_dock`).
At 640 px and below the dock is a drawer over the terminal (it starts closed)
and herdr uses its own phone layout, where its spaces slide over the pane.

- **Old links.** `/mission/?pane=…` (and the root of `HERDR_MISSION_PORT`,
  default 5180, `0` turns it off) only redirects to
  `index.html#/hermes/chat?center=herdr&pane=…` (`mission/main.ts`,
  `utils/herdr-page-url.ts`); Studio's `?center=herdr&pane=…` and `/herdr`
  links land on the same page and pane. "Open in herdr" (header button, chat
  menu, `/herdr`) opens the chat there (`utils/mission-url.ts`).
- **Speed with hundreds of chats.** herdr's state lists every chat's space and
  pane (about 250 kB with 360 chats). Pages get only the fields they read
  (`services/herdr/client-state.ts`), changes are coalesced (150 ms), unchanged
  states are not sent, and pages that can unzip get `herdr.state.gz` (gzipped,
  about 11 kB) instead of `herdr.state`; `GET /api/coding-agents/herdr` is
  gzipped too. The terminal stream shares that socket, so before this the
  first herdr screen waited behind the full state.
- **Folders are Studio's chat folders, 1:1** (`mission/useFolders.ts`,
  `services/herdr/folders.ts`): herdr's spaces follow Studio's folder order
  (the order of the Spaces sidebar, `ChatSpaceChat.folderRank`).
- **Spaces sidebar (space folders).** The left column is Studio's own Spaces
  sidebar (`HerdrSpaceSidebar.vue`, logic in `space-folders.ts`), rebuilt
  natively after Herdr App's **Herdr Space Folders** mod
  (github.com/jankeesvw/herdr-space-folders, MIT) and **Herdr Roundup**'s
  spaces list (github.com/carstenlucke/herdr-roundup); ideas, not code. Those
  mods are GPUI JavaScript for herdr's desktop app and cannot run in a browser.
  Folders are Studio's chat folders: a colored tile, a count, fold/unfold (a
  folded folder still shows when an agent in it is blocked, done or working),
  a `+` that opens a herdr space in the folder's start folder, already in the
  folder (`POST …/space-folders/folders/:id/space`), and a right-click menu
  (color, New space here, New folder inside, Edit folder…, Delete folder).
  Edit folder sets the name, the parent, the start folder (Choose… is Studio's
  server-side folder picker; home is written `~`) and the rules: `wbso-ai`
  (a folder name anywhere in the path), `~/code/client-*` (a path, `*` one
  name); the most specific rule wins and what you dragged wins over rules; a
  folder with no rules collects by its start folder. Drag a chat onto a folder
  (files it), onto a chat (into that chat's folder), below the list (out of
  every folder; kept out when a rule would collect it), and drag folders to
  reorder them (dropped on a folder under another parent, it moves there). Rows
  show a stable colored avatar, the name, repo / branch and ahead/behind only
  when unusual (`POST …/space-repos`, `services/herdr/space-git.ts`, cached
  30 s), and the agent's status; asleep chats are listed with "z" and a click
  wakes them (`openSessionInHerdr`). Search filters chats and spaces (a match
  opens its folder). alt+up / alt+down go to the row above/below as the list
  shows (past folded folders, round the ends) and are taken before the
  terminal sees them. With saved remote machines a "This computer" header and a
  group per machine (its agents, click opens that machine's herdr) show. On a
  phone the sidebar is a drawer (the header's Spaces button).
- **herdr's own sidebar instead.** The sidebar's ▯ button, the header's ⋯ menu
  on a phone ("Use herdr's own sidebar") and the Spaces button (back) switch
  per viewer (`space-sidebar-layout.ts`, `studio_herdr_spaces`). Under Studio's
  Spaces the embedded herdr client starts with its sidebar collapsed and reads
  a copy of the user's herdr config with `sidebar_collapsed_mode = "hidden"`
  (`HERDR_CONFIG_PATH` in `client-view.ts`, so it is gone, not a rail); with
  herdr's own sidebar it starts shown and reads the user's config. A terminal
  herdr is never affected. Relative paths in that config resolve next to the
  copy (Studio's link folder); Studio's client picks up config edits when it
  reconnects.
- **One set of folders with Herdr App.** `~/.config/herdr-space-folders.json`
  in the home of the machine herdr runs on (the Studio server's;
  `HERMES_HERDR_SPACE_FOLDERS_FILE` overrides it, `off` turns it off) is kept
  in two-way sync with Studio's folders and each awake chat's folder
  (`services/herdr/space-folder-sync.ts`, pure merge in
  `space-folder-file.ts`). The mod's format is `{ list: [{ id, name, color,
  path, match, folded }], of: { spaceId: folderId | "" }, at }`. Studio writes
  folder `c<category id>`, colors as the mod's `ansi1…6`, `path` = start
  folder, `match` = rules (or the start folder while a folder has none, as the
  mod's dialog mirrors it). Nested Studio folders are written flat, right after
  their parent, named with their path ("Clients / Acme"); renaming one in the
  mod renames its last part; a folder made in the mod becomes a top-level
  Studio folder (its `f…` id is remembered as an alias of the new `c<id>`). A
  space's `of` is its chat's folder, `""` when taken out by hand, absent when
  rules decide; placements of spaces that are no chat are kept too. Fields and
  folders Studio does not use (extra keys, unknown top-level keys) are kept.
  Merging is three-way against what Studio last wrote (`synced` in Studio's
  `space-folders.json`): only fields the file changed are applied; when both
  sides changed the same field the newer side wins (`file.at` against Studio's
  last change); a copy older than Studio's last write is replaced. The first
  sync adds the mod's folders and placements and keeps Studio's own. Studio
  watches the file (and looks every 5 s) and writes it at once after a change
  in Studio. Limits: Herdr App re-reads the file every 15 s, so changes made
  in both apps within that window can lose one side; asleep chats have no herdr
  space, so the file only places awake chats (their folder is kept in Studio);
  remote machines keep their own files, which Studio does not sync.
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
  is not shown) and the center is herdr's own full UI. herdr's sidebar is the
  chat list: every Studio chat is a space named after it, in folder order (see
  "Every chat is a herdr space"), and its Agents list shows each chat's agent.
  The bar above has New chat (herdr's New Studio chat picker when bound, else
  Studio's new chat page) and one-tap keys, including the herdr sidebar
  toggle. On phones the chat list stays in the menu drawer. The embedded
  client connects through Studio's own links to herdr's sockets
  (`services/herdr/client-view.ts`, `HERDR_SOCKET_PATH`), and herdr keeps
  client preferences per socket path, so hiding herdr's sidebar in Studio does
  not hide it in a terminal herdr. Studio sets that file's `sidebar_collapsed`
  at each launch from the sidebar picked (see "Spaces sidebar").
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

## Command Center (the Tools dock's first row)

The dock's first row is Command Center (`mission/command-center/`), the
behaviour of Herdr App add-ons rebuilt natively for the browser. They are GPUI
JavaScript mods for herdr's desktop app and cannot run in a page; Studio took
the ideas, not the code. Credit: [Command Center](https://github.com/digitaltracer/herdr-plugins)
by digitaltracer (inbox, board, status, usage bars), [Herdr Roundup](https://github.com/carstenlucke/herdr-roundup)
by Carsten Lucke (agent cards with context meter, file list, floating preview)
and the [skillshare](https://github.com/runkids/skillshare) herdr panel by runkids.

- **Inbox.** What needs you now (`model.ts` `buildInbox`): Agent work awaiting
  approval (Approve / Reject inline), blocked agents (herdr panes and Studio
  chats), failed Hermes jobs, failed CI on your open pull requests and review
  requests (from the server's `gh`, only when it is signed in; settings: on/off
  and watched repositories, whose failing workflow runs are added), and agents
  done since you last looked. A click shows the pane or opens the chat. Seen
  marks and when each agent entered its state are per viewer in browser
  storage (`studio_herdr_inbox_seen_v1`, `studio_herdr_agent_since_v1`); a
  later event is new again. The unseen count badges the Inbox tab and Tools.
- **Agents.** A card per herdr agent and per working/blocked/done Studio chat:
  state and time in it, agent, model, folder and git branch, context meter
  (latest usage row against the model's context window, the same estimate as
  `/context`), token totals, Codex plan bars on Codex cards; Show pane, Open in
  Studio, Approve pending Agent work, Stop (closes the pane, after a confirm).
- **Files.** The focused pane's chat folder through the chat workspace file
  API, starting at the pane's own folder when it is inside. Double-click or
  Enter opens a floating, draggable, resizable preview with Studio's
  `FilePreview` (Markdown, images, PDF, CSV/xlsx, code, JSON); TSV is shown as
  a table. The preview carries `floating: true` in the files store so the
  chat page's Files panel does not open for it.
- **Board.** Agent work, Pondering Orb's open tasks and live agents as lanes
  (queued, working, blocked, awaiting approval, done); a work item an agent is
  doing shows that agent's state instead of a second card.
- **Skills.** With `skillshare` on the server's PATH: Overview (targets waiting,
  per-kind counts, needs sync and updates) and Library, with Sync, Update and
  Install from a repo behind a confirmation (the routes refuse writes without
  `confirm: true`; skillshare audits installs and updates itself). Global scope
  only. Without it: how to install it. Studio's Hermes skills are counted.
- **Usage strip.** Today's tokens per agent and cost from Studio's usage stats,
  and Codex's 5-hour and weekly plan windows from the newest Codex rollout's
  `rate_limits` (`codex-limits.ts`). Claude Code keeps no plan limits locally.
- **Not built.** Command Center's Linear and Slack panels need connectors
  Studio does not have; its standup/handoff ideas are left for later.
- **Server.** `/api/studio/command-center/*` (super admin): `github`,
  `settings`, `agents` (contexts and branches), `plan-limits`, `skillshare`
  (+ `check`, `sync`, `update`, `install`). Programs run with argument arrays
  (`services/command-center/cli.ts`). Settings live in
  `HERMES_WEB_UI_HOME/command-center/settings.json`.
- Tests: `tests/server/command-center.test.ts`,
  `tests/client/command-center-model.test.ts`, `tests/client/command-center-tabs.test.ts`.

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
| herdr page (Mission docked) | `components/coding-agents/herdr/HerdrCenter.vue`, `HerdrMissionDock.vue`, `herdr-layout.ts`, `packages/client/src/mission/sources/*`; old `/mission/` redirect: `packages/client/mission.html`, `src/mission/main.ts`, `bootstrap/http.ts` |
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
- Browser: `tests/e2e/herdr-center.spec.ts`, `tests/e2e/herdr-settings.spec.ts`,
  `tests/e2e/mission.spec.ts` (mocked API).
- Live: build herdr (`cargo build --release`, needs Zig 0.16), run Studio with an
  isolated `HERMES_WEB_UI_HOME` and `CLAUDE_CONFIG_DIR`, enable herdr with a named
  session, and drive agents with herdr's CLI (`pane run`, `send-text`). Keep the
  test `HOME` short: herdr's Unix socket path must fit in 108 bytes. A real or
  stand-in agent must run in the pane for `agent.prompt` and detection to work.
  Start the isolated Studio with `NODE_ENV=production` (`node dist/server/index.js`):
  without it Studio ignores `HERMES_WEB_UI_HOME` and opens the developer
  database `packages/server/data/hermes-web-ui.db`, which tests must never touch.
