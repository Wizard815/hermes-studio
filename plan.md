# herdr + Studio plan

Branch: `studio-herder` (Studio with herdr: chats start in Studio and can be
elevated to herdr). It is the one test branch and has all of `main`'s own
fixes. `main` stays unchanged until the user confirms `studio-herder` works on
their NUC. `herdr-integration` is the older all-in-herdr version and will be
retired.

## Now: Studio and herdr, separate but together

Goal (changed 2026-11-24): Studio and herdr are separate apps that work
together. You start in Studio and elevate a chat to herdr when you need its
agent in a terminal. Before this, every chat was a herdr space at once, which
was buggy and not how the two are meant to be used.

Done:

- New chats are Studio-only: no herdr space, no waiting pane, no process.
- Elevate to herdr (chat header button, right-click menu, `/herdr`) makes the
  chat's herdr space and starts its agent there. Elevated chats keep the
  two-way sync: messages, status, approvals, run limits and folders.
- Return to Studio (header menu, right-click menu, `/studio`) closes the space
  and keeps the chat. A chat closed in herdr returns to Studio too, and
  "Reopen closed chat" elevates it again.
- The herdr page shows only elevated chats and spaces made in herdr. With
  nothing there it explains how chats get there. Studio's top bar is hidden on
  the herdr page (the Herdr App window look); a button or Esc shows it.
- Old installs move over once, with herdr connected: chats with a running
  agent stay elevated, waiting spaces close, history is not touched.
- Sleep mode and the "days awake" setting are gone (nothing sleeps: only
  elevated chats are in herdr).
- A chat blocked by a run limit stays blocked after a restart until Continue
  or Stop.
- Studio's herdr mode can still show herdr's own UI. herdr restarts bring
  elevated chats back. docker-compose keeps herdr's config and sessions in
  the data volume.

Open:

- Approvals (done): agents in herdr panes ask before acting; Ekko's
  approvals tested in herdr (deny, once, asks again).
- Approval modes (done): ask (default: reading anywhere and writing in the
  chat's folder go ahead, commands ask), guarded (yolo, but dangerous
  actions ask), auto (yolo). Tested with Claude Code, Codex, Qwen, Pi,
  OpenCode, Grok, DSH.
- Old chats without an agent session (done): the fresh agent session gets
  the chat so far.
- Later: test approvals with Kimi, Copilot, Qoder and CodeBuddy on a setup
  where they are logged in; Cursor, Antigravity and Zcode can only refuse
  (not ask) until they offer a way to ask from a headless run.
- Check approvals on a real setup with a real model.
- Sleep mode: replaced by elevated chats (only chats you elevate are in
  herdr, so there is nothing to put to sleep).

- VS Code (done): the chat header's Chat / herdr / Code switch. Code shows VS
  Code (code-server, installed by Studio into its data folder) on the chat's
  folder with the chat beside it; it follows the agent's edits. See
  `docs/vscode.md`.
- Clean rooms (done): `/cleanroom` runs a chat's agent in its own container.
- Next: LLM wiki memory provider (Wizard815/LLM-will-remember-this on Unraid),
  once its container is ready.

## Later (parked until the UI goal is finished)

- **Folder suggestions.** Studio or herdr suggests a folder (or subfolder) for
  uncategorized chats and asks before moving them.
- **Condensing chats.** Start a new chat from an old chat's summary and goal.
- **herdr agents use old chats.** Let agents in herdr call on any chat, even
  old ones, for context.

## Ideas to look at (outside projects, researched 2026-11-20)

Each project has a full note in `docs/planning/ideas/` (what it is, how to use it
in Studio and herdr, what we'd build, risks, licence). Nothing here is
installed yet. Notes were written from reading the code and pages only; no
outside code was run.

### Clean rooms for agents

| Project | Verdict | Note |
|---|---|---|
| [agent-clean-room](https://github.com/bigsnarfdude/agent-clean-room) | Skip as a tool, borrow ideas | `ideas/agent-clean-room.md` |
| [crab](https://github.com/lemonadesaltbagel/crab) | Skip as a tool, borrow ideas | `ideas/crab.md` |

Ideas worth adding to Studio's own clean rooms (`docs/cleanroom.md`):

- A "what can you see" self-check inside the container, shown in the chat.
- A leak check on the chat folder (no host secrets copied in).
- Real walls: read-only root with tmpfs, `cap-drop ALL`, read-only mounts or a
  different owner instead of chmod, one user per agent.
- A JSON log of every outside connection the agent makes.
- Web search and web fetch turned off inside the room unless allowed.
- Optional tamper-evident (hash-chained) audit log.

### Watching agents (next to Hermes's built-in approvals)

| Project | Verdict | Why |
|---|---|---|
| [hermeskill](https://github.com/theopitori/hermeskill) | Maybe | Loop, cost and time kill-switches Studio lacks. Brand new, so try on one profile. |
| [pipelock](https://github.com/pipelab-org/pipelock) | Maybe | Scans traffic for leaked secrets and prompt injection. Ships a Hermes plugin. Optional extra. |
| [InnerWarden](https://github.com/InnerWarden/innerwarden-releases) | Maybe | Free guard with a Hermes hook, overlaps guarded mode. Paid tier is closed. |
| [Apollo Watcher](https://watcher.apolloresearch.ai/) | Skip | Closed, sales-only, supports Claude Code / Codex / Copilot only. |

Home-grown gaps these show: a per-chat spending/loop limit, an audit log of
approvals and denials on the Agent work page, and a Mattermost alert when
something is blocked.

### Official Hermes plugins

[hermes-official-plugins](https://github.com/NousResearch/hermes-official-plugins):
22 plugins; Studio's Plugins page already installs and enables them. Suggested
to turn on: agent-importers (once), homeassistant, langfuse, mcp-serve,
bubblewrap (optional). Full per-plugin table: `ideas/hermes-official-plugins.md`.

### Other plugins and skills

| Project | Verdict | Why |
|---|---|---|
| [rea](https://github.com/morluto/rea) ([marketplace](https://hermes-agent.nousresearch.com/marketplace/rea)) | Maybe | Reverse-engineering MCP tools, official plugin; run it in a clean room. |
| [autorag](https://hermes-agent.nousresearch.com/marketplace/autorag) | Maybe | Local file and chat-archive search; overlaps the parked LLM-wiki idea; not proven on Linux. |
| [phone-harness](https://hermes-agent.nousresearch.com/marketplace/phone-harness) | Maybe | Agents drive Android over adb; try it before building on Studio's Android page. |
| [whiteboard](https://hermes-agent.nousresearch.com/marketplace/whiteboard) | Maybe | Chat tools work; the board page is Hermes Desktop only. |
| [data](https://hermes-agent.nousresearch.com/marketplace/data) | Maybe | 4 report tools install easily; the report page needs a port. |
| [omh](https://hermes-agent.nousresearch.com/marketplace/omh) | Maybe | Runs host checks without asking; clean room only. |
| [sem-weave](https://hermes-agent.nousresearch.com/marketplace/sem-weave) | Maybe | Two review skills; need the `sem` CLI. |
| [gadget](https://hermes-agent.nousresearch.com/marketplace/gadget) | Maybe | ESP32 voice devices; overlaps `packages/mcu`; only with matching boards. |
| [print3d](https://hermes-agent.nousresearch.com/marketplace/print3d) | Maybe | Bambu printer files via Blender; only with a Bambu printer; clean room. |
| [jakubkrehel/skills](https://github.com/jakubkrehel/skills) | Maybe | UI design skills for coding agents (about 5 worth adding). |
| [hermes-speech](https://hermes-agent.nousresearch.com/marketplace/hermes-speech) | Skip | Paid middleman; Studio already has TTS/STT. |

### Test Lab (proposed)

A Studio page that starts a throwaway multi-container demo (Vikunja, Mealie,
Mattermost, Home Assistant demo, Pondering Orb, ALLGlance, Studio) with test
data, runs one agent in a clean room on a model the user picks (OpenRouter,
pinned, with a spending cap per run), and reports results, screenshots, logs
and cost, then cleans up. Waiting on the user's answers.

### Decisions (2026-11-21)

Done, all in `studio-herder` now (their branches can be deleted):

- Clean-room hardening: `cleanroom-hardening`.
- Run limits (cost, tokens, time, loop catcher): `agent-limits`.
- Official plugins turned on once per profile: agent-importers, homeassistant,
  langfuse, mcp-serve (also added to the MCP page), bubblewrap (installed, not
  switched on), rea, print3d: `recommended-plugins`.
- Herdr App layout in the herdr page + install script for the desktop app:
  `herdr-app-ui`.

Next:

- **UI skills for every agent**: the UI/design skills from jakubkrehel/skills,
  installed for Hermes, Ekko and every coding agent.
- **Gadget plugin for D.A.S.H** (Wizard815/D.A.S.H, the 4-inch ESP32 hub;
  the firmware is worked on in another chat): Studio installs and turns on the
  Hermes Gadget plugin, exposes its WebSocket (`:8765/gadget`) in Docker, and
  shows its status. Part of the plugins job. D.A.S.H also talks to FAITH
  (Wizard815/F.A.I.T.H: family view, Yes/No for held actions, voice fallback),
  Pondering Orb and Studio itself (Socket.IO `/global-agent`,
  `mcu.events.subscribe`); FAITH in turn uses Hermes (`hermes_ask`) and Studio
  (`studio_start`). The plugins job checks the Studio side of those links works
  with the Gadget plugin on.
- **Whiteboard logic in Pondering Orb's Ideas tab (Milaclone)**: agents make and
  edit boards, turn cards into Orb tasks. Repos: pondering-orb, milaclone-mcp.
- **Phone tools for agents**: phone-harness ideas on top of Studio's Android
  page (screenshot, UI tree, tap by element, approvals per action).
- **Watcher** (branch `watcher`, see `docs/watcher.md`): one feed of
  approvals, limits, clean-room blocks and leaks, Agent work and plugin
  failures; a bell in the top bar (and herdr's bar, and the phone menus) with
  read/clear and "Trust this" rules that feed the existing approval paths;
  Settings → Watcher and Settings → Clean rooms; per-task approval mode.
  Extras off by default: pipelock (clean-room upstream), InnerWarden (hook
  status), Langfuse (trace links). Left: real pipelock and InnerWarden not
  tried here; Hermes cron has no per-job approval mode.
- **Import chats**: learn from agent-importers how to bring Hermes chats from
  other installs (and other agents' sessions) in as Studio/herdr chats.

Order: watcher done (branch `watcher`); the herdr-app-ui, plugins (with Gadget), limits and
clean-room branches are merged into `studio-herder`.

Not adding: sem-weave (the watcher covers it), hermes-speech, Apollo Watcher,
omh (its checks run on the host without approvals, which works against clean
rooms; its LSP tools could be revisited later).
