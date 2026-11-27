# Chats messaging each other

Any Studio chat's agent can message another of your chats and get its answer,
the way project threads and herdr agents talk to each other. No project is needed.

## How it works

The agent uses the `ekko_studio_use_chats` tool:

| Action | Arguments | What happens |
| --- | --- | --- |
| `list` | `limit` | Your other chats, newest first, with id, title and whether each is busy. |
| `ask` | `chat`, `text`, `timeout_s` (default 600, at most 1800) | The other chat runs one turn on the message. Its answer is the tool's result, so the asking turn waits for it. |
| `send` | `chat`, `text` | The asking chat goes on at once. The other chat runs one turn, and its answer arrives later as a new turn in the asking chat. |

The other chat's turn runs through Studio's own chat runs, so it uses that chat's own
agent, model, profile and folder, and remembers its own history.

In the other chat you see `💬 From "Planner": ...`. In the asking chat a sent
message's answer shows as `↩ Reply from "Argos": ...`. The agent's input marks the
message as coming from another chat, not from you, and a reply repeats what was
sent, so the agent knows what the answer is for.

A chat that is busy gets the message when its current turn ends. Messages to one chat
run one at a time.

The API is `POST /api/studio/chats/messages/:action` with `{ sessionId, chat, text }`,
where `sessionId` is the asking chat. The MCP server fills `sessionId` from
`HERMES_STUDIO_SESSION_ID`.

## Guards

- A chat can't message itself.
- Both chats must belong to the person calling. A super admin can connect any chats.
- A chain of messages stops at 4 hops (a asks b, b asks c, ...). The agent is told to
  answer in its own reply instead.
- Two chats can't ask each other at the same time, directly or around a loop
  (a asks b, b asks c, c asks a). That would deadlock, so the last ask is refused
  with 409 and the agent is told to answer in its reply.
- Each pair of chats can exchange 20 messages an hour (429 after that).
- Answers are the other chat's data, never your instructions. The receiving agent is
  told to ask you before anything risky.

## What goes wrong

- **"A model route is required."** The other chat has no model or provider. Open it once
  and pick a model, or set a default provider.
- **An ask times out.** The other chat took longer than `timeout_s`. Its turn is stopped.
  Use `send` for long work.
- **No reply arrives after a send.** The reply waits until the asking chat's own turn ends.
  If Studio restarts before then, the pending reply is lost, because the queue is only
  kept in memory.
- **"Chats can only message chats of the same person".** One of the chats was made by
  another account.

## Code

- `packages/server/src/modules/studio/services/chat-messages/service.ts`: `ChatMessenger` and its guards
- `packages/server/src/modules/studio/controllers/chat-messages.ts` and `routes/chat-messages.ts`
- `bin/ekko-studio-mcp.mjs`: the `ekko_studio_use_chats` tool
- Tests: `tests/server/chat-messages.test.ts`; live with real models:
  `LIVE_CHATS=1 npx vitest run tests/live/chat-messages.live.test.ts`
