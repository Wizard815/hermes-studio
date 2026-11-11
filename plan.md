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

- Check approvals and questions from Ekko inside herdr on a real setup.
- Cost: each open herdr pane uses about 0.12% CPU in herdr itself, so 300 chats
  use about 38% of one core. If that is too much, add a "recent chats only"
  limit, with older chats opened from herdr's Studio chats picker.

## Later (parked until the UI goal is finished)

- **Folder suggestions.** Studio or herdr suggests a folder (or subfolder) for
  uncategorized chats and asks before moving them.
- **Condensing chats.** Start a new chat from an old chat's summary and goal.
- **herdr agents use old chats.** Let agents in herdr call on any chat, even
  old ones, for context.
