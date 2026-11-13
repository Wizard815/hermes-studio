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

## Later (parked until the UI goal is finished)

- **Folder suggestions.** Studio or herdr suggests a folder (or subfolder) for
  uncategorized chats and asks before moving them.
- **Condensing chats.** Start a new chat from an old chat's summary and goal.
- **herdr agents use old chats.** Let agents in herdr call on any chat, even
  old ones, for context.
