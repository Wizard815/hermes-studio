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
- **Done: its pull request merged**: every github.com pull request the chat
  links to is merged or closed (one merged at least), and untouched for a day.
  The merged PR's title shows under the chat.
- **Same title as a newer chat**: untouched for a week. The newer chat is
  never suggested in the same list, so one copy always stays.
- **Not used for 30 days**.

Each chat shows its date, message count, a one-line summary and its last
message, so you can tell what it was. The summary is written by the chat's own
model (else the profile's default), with no tools and no memory, from the
chat's last 30 messages; it is kept until the chat gets new messages.
Everything starts selected; untick what you want to keep.

**Archive** is the main button: archived chats come back from History.

**Delete** asks first. Then:

1. **Save key facts to the wiki before deleting** (on by default, shown only
   when the chat's profile has an LLM wiki address and token, see
   [llm-wiki.md](llm-wiki.md)): the chat's model lists what is worth keeping,
   and Studio files it as a note named "Chat: <title>" in the wiki's inbox with
   the profile's own token. If a note can't be saved, that chat is kept and
   you're told why. A chat with nothing worth keeping is deleted without a note.
2. The chats are archived, so they leave the list.
3. **Undo** shows for 10 seconds and brings them back. After that they are
   deleted for good. If you close the page in those 10 seconds, they stay
   archived instead.

**Remind me once a month** (off by default) shows "N chats could be cleaned
up" with a **Clean up** button when you open the chat page, at most once a
month and only when there are three or more suggestions. The setting is kept
in this browser only.

Never suggested: pinned chats, archived chats, local-only chats, chats that are
running, project coordinators and threads, and chats with chats under them.

API (all take `{ "ids": [...] }` and skip chats you can't see):

- `POST /api/studio/sessions/cleanup/prs`: `{ prs: { id: [{ url, state, title }] }, wikiProfiles }`.
  PR states come from GitHub with `GH_TOKEN`/`GITHUB_TOKEN` or `gh auth token`
  on the Studio host (public repos work without one), cached for a minute.
- `POST /api/studio/sessions/cleanup/summaries`: `{ summaries: { id: text } }`, at most 40 chats.
- `POST /api/studio/sessions/cleanup/save-to-wiki`: `{ saved, skipped, errors }`.
- `POST /api/studio/sessions/last-messages` with `{ "ids": [...] }` returns
`{ "messages": { "<id>": { "role", "text", "at" } } }` for the chats you can see.

## What goes wrong

- A suggestion you disagree with: untick it. Suggestions come from titles,
  message counts, dates and PR states; the summary only describes the chat.
- No summaries: the chat (and its profile) has no model Studio can reach.
  The list still works.
- A private repo's PR never counts as merged when Studio has no GitHub token.
- "Last message" says "No messages" when the chat has none stored on this
  Studio (for example a chat still only on the device).
