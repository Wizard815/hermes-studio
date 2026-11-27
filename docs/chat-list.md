# Chat list: chats under chats, and Clean up

Two optional extras in the Studio chat list. Nobody has to use them; the list
works the same without them.

## Chats under other chats

Right-click a chat and pick **Put under another chat…**. It then shows
indented under that chat, and moves to that chat's folder (category).

- One level only. A chat that already sits under another chat can't take
  chats under it, and a chat with chats under it can't go under another one
  (the menu item is hidden for it). The server answers 409 if you try.
- **Take out from under its chat** puts it back at the top level.
- Moving a chat to another folder takes it out from under its chat. Moving a
  chat that has chats under it takes them along.
- If the parent is not in the list you're looking at (archived, another
  profile, filtered out), the chat shows at the top level.

Folders still work as before, so you can use folders, nesting, or both.

API: `POST /api/studio/sessions/:id/nest` with `{ "parentId": "<id>" }`, or
`{ "parentId": null }` to take it out. Stored in the `nested_under` column.

## Clean up

The chat list's **⋯** menu has **Clean up chats…**. It lists chats you may
want to archive or delete, grouped by why:

- **Nearly empty**: two messages or fewer, and untouched for a day.
- **Same title as a newer chat**: untouched for a week. The newer chat is
  never suggested in the same list, so one copy always stays.
- **Not used for 30 days**.

Each chat shows its date, message count and its last message, so you can tell
what it was. Everything starts selected; untick what you want to keep.

**Archive** is the main button: archived chats come back from History.
**Delete** asks first and can't be undone.

Never suggested: pinned chats, archived chats, local-only chats, chats that are
running, project coordinators and threads, and chats with chats under them.

API: `POST /api/studio/sessions/last-messages` with `{ "ids": [...] }` returns
`{ "messages": { "<id>": { "role", "text", "at" } } }` for the chats you can see.

## What goes wrong

- A suggestion you disagree with: untick it. Suggestions are only computed
  from titles, message counts and dates; nothing reads the chat's meaning.
- "Last message" says "No messages" when the chat has none stored on this
  Studio (for example a chat still only on the device).
