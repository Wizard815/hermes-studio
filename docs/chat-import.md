# Import chats

Bring conversations from another Hermes install, Claude Code, Codex or
OpenClaw into Studio as normal chats. They show in the chat list, folders and
search like any other chat, and can be elevated to herdr.

Super admins only. Open the chat list's **⋯** menu (or History's) and pick
**Import chats…** (`/#/hermes/import-chats`).

## Steps

1. **Pick the source.**
   - *Folder on the Studio server*: a home folder (`/mnt/backup/home`), or one
     agent folder (`~/.hermes`, `~/.claude`, `~/.codex`, `~/.openclaw`). `~` is
     Studio's own home folder.
   - *Upload an archive*: a `.zip`, `.tar`, `.tar.gz` or `.tgz` of the same,
     from another machine. Up to 512 MB.
2. **Check the preview.** Every chat found, with its source, date, message
   count and folder. Nothing is written yet. Chats already imported are marked
   and cannot be picked again. Empty or unreadable sessions are skipped.
3. **Pick the profile and folder** the chats go into, then **Import**. A
   progress bar runs; the result links to each new chat.

Running it again is safe: a source chat always becomes the same Studio chat id
(`import-` and a hash of the source and its original session id), so chats
already imported are skipped as duplicates. A chat you deleted is imported
again. Chats Studio already has are duplicates too: scanning this server's own
`~/.hermes` lists Studio's Hermes chats (Hermes keeps them under their Studio
id), and scanning its `~/.claude` or `~/.codex` lists Studio's coding chats
(linked by the agent's session id).

## What is read

| Source | Files read |
|---|---|
| Hermes | `state.db` in the Hermes home and in `profiles/*/` (opened read-only; compressed sessions are merged back into one chat) |
| Claude Code | `projects/*/*.jsonl` |
| Codex | `sessions/**/rollout-*.jsonl` and `archived_sessions/` |
| OpenClaw | `agents/*/sessions/*.jsonl` |

Cursor is not supported: its chats live in a binary store per chat.

## What is imported

- Messages, titles and dates. Tool calls and their output become the chat's
  tool steps. Tool output over 32,000 characters is cut, and a tool result
  whose call is missing is dropped (a model refuses such a history).
- Message text is kept exactly as written, including anything that looks like
  a key that you typed or a tool printed.
- Hermes and OpenClaw chats become Hermes chats on the chosen profile, with
  that profile's default model.
- Claude Code and Codex chats stay Claude Code and Codex chats, with their
  working folder when that folder exists on this server.

## What is never imported

- Credential files are never opened or copied: `.env`, `auth.json`,
  `.credentials.json`, `credentials.json`, `cli-config.json`, OAuth and token
  files, keychains and key files. An upload is unpacked with only the chat
  files (`state.db`, `*.jsonl`); everything else in it is left out and counted.
- Settings, skills, memory and MCP servers. Use Hermes' own
  `hermes import-agent` (the agent-importers plugin) for those.

## Continuing an imported chat

- A Claude Code or Codex chat whose session file is in this server's own agent
  folder (`~/.claude`, or `CLAUDE_CONFIG_DIR`; `~/.codex`, or `CODEX_HOME`)
  keeps the agent's session id. Elevating it to herdr resumes that session.
  Claude Code also needs the chat's working folder to exist.
- Any other imported coding chat has no agent session here. Its first agent
  run starts fresh and gets a recap of the chat so far (the same as old chats
  without an agent session).
- An imported Hermes chat has no Hermes session yet. Chatting in Studio sends
  the history as usual. Elevating it to herdr gives the fresh Hermes session
  the recap too.

## Limits and errors

- Upload: 512 MB. Unpacked: 2 GB, 50,000 entries. One session file: 128 MB
  (bigger ones are listed as skipped). Preview: 5,000 chats; pick a smaller
  folder for the rest. One chat: 20,000 messages.
- An archive with a path that leaves it (`../`, absolute paths) is refused
  whole. Links and special files in it are skipped.
- An uploaded archive is unpacked in a temporary folder that is removed after
  the import, when you start over, or at the next scan an hour later.
- The single-chat **Import** on the History page (this server's own Hermes
  sessions) still works as before.

## Code

- Server: `packages/server/src/modules/studio/services/chat-import/`
  (parsers, discovery, archive, service), routes `/api/studio/chat-import/*`.
- Page: `packages/client/src/views/hermes/ChatImportView.vue`.
- Tests: `tests/server/chat-import.test.ts`, `tests/e2e/chat-import.spec.ts`.
