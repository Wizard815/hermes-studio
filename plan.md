# herdr + Studio plan

Branch: `herdr-integration` (kept apart from `main` until the herdr work is finished).

## Now: finish the shared Studio/herdr UI

Goal: every chat is both a Studio chat and a herdr chat. It looks like Studio
in Studio and like herdr in herdr.

Done:

- Every chat is a herdr space named after the chat, in Studio's folder order.
- Chats whose agent is not running wait in a small pane. Press Enter there to
  resume the agent in place (Claude, Codex, Hermes with its CLI) or to talk to
  it through Studio (Ekko, Hermes without its CLI).
- Studio's herdr mode is herdr's own UI. herdr's sidebar is the chat list.
- Old chats join without any steps. After `npm run build` and a (re)started
  Studio or container, every existing chat gets its space within about a
  minute. This was tested with 304 old chats.
- herdr restarts bring every chat back. If herdr's config was lost, Studio
  sets herdr up again on its own.
- docker-compose keeps herdr's config and sessions in the data volume.

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
- Sleep mode (done): chats used in the last 7 days (setting) are awake in
  herdr; older ones sleep with no process and wake when opened or messaged.
  With 304 chats herdr uses about 4% CPU (all awake: 41%).

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
