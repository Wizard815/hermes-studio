# Clean rooms

A clean-room chat runs its coding agent inside its own container. Inside, the
agent may do anything without asking (it is the agent's yolo mode). It cannot
reach anything outside: the container is the limit, not a rule list.

Start one with `/cleanroom` (or `/cleanroom <task>` to also run the task) in a
coding-agent chat (Claude Code, Codex, Qwen, OpenCode, Grok, Pi, DSH, ...), or
`POST /api/coding-agents/cleanroom/sessions/:id`. The chat header shows a
"Clean room" badge. Ekko and Hermes chats run inside Studio and cannot be
clean rooms yet.

## What the container gets

| | |
| --- | --- |
| The chat's folder | read-write, at the same path |
| The agent program | read-only (its install folder) |
| The agent's Studio config folder | read-write (`coding-agent/model/<profile>/<provider>/<agent>`) |
| The room's own home folder | read-write at `/root` (`coding-agent/cleanroom/homes/<hash>`) |
| Studio | only its model proxies (`/api/codex-proxy/…`, `/api/claude-code-proxy/…`), through a tunnel |
| Internet | none directly (`--network none`); HTTPS through an allowlist proxy (`HTTPS_PROXY`) |
| Environment | only what Studio sets for the agent, never Studio's own (no host tokens) |

Not given: the host's home folder, other folders, the Docker socket, Studio's
API and tools (MCP), SSH keys, host credentials. It runs with
`no-new-privileges`, a few capabilities dropped, and CPU, memory and process
limits.

Network settings (`coding-agent/cleanroom/settings.json`,
`GET/PUT /api/coding-agents/cleanroom/settings`):

- `allowlist` (default): Studio plus `allowHosts` (model APIs and package registries).
- `studio`: only Studio (agents on Studio's providers work; installs do not).
- `internet`: any host through the proxy.

`image` (default `node:24-bookworm-slim`, needs node for the tunnel), `cpus`,
`memory`, `pids` are there too. Agents on Studio's providers (scoped mode) reach
their model through Studio; agents on their own logins need their API host in
`allowHosts` and their login inside the container.

## How it works

- `services/cleanroom/index.ts`: settings, the per-chat container
  (`studio-cleanroom-<chat>`, labeled `studio.cleanroom.session=<chat>`), the
  host side of the tunnel (two Unix sockets per room: Studio's port, filtered
  to the model proxies, and the allowlist proxy), `docker exec` wrapping.
- A clean-room launch's command is `studio-cleanroom://<container>/<command>`;
  `spawnInCleanRoom` turns it into `docker exec -i … setsid -w sh -c … <command>`
  (stopping the run stops the process inside too). Every turn runner uses it
  (run manager, Grok, Cursor, Antigravity, Codex compact).
- In herdr, a clean-room chat's pane runs `docker exec -it` into the same
  container, through a link to the docker client named after the agent
  (`coding-agent/cleanroom/bin/claude`, `cleanRoomTerminalDocker`): herdr
  knows a pane's agent by its foreground process, so it shows the agent and
  follows its status from the screen. The agent's own herdr hooks cannot reach
  herdr from the container, so Studio reports the session it resumes and
  types the chat so far into a fresh one (`HerdrBridge.followCleanRoom`).
  A fresh session is found by its transcript in the room's home folder and
  recorded as the chat's agent session (and reported to herdr), so the next
  resume uses `--resume <id>` and a Studio restart finds the pane live.
- Each room has a home folder on the host, mounted at `/root`
  (`coding-agent/cleanroom/homes/<hash>`, `cleanRoomHome`): the agent's
  sessions and any login made inside survive a new container, and herdr's
  transcript mirror reads the agent's transcripts there (`findChatTranscript`
  in `bootstrap/herdr.ts`). Rooms made before it get their `/root` copied in
  once. Deleting the chat deletes it; throwing the container away keeps it.
- `launchAsks()` is false in a clean room: agents run in their yolo mode.
- Deleting the chat removes its container (`bootstrap/cleanroom.ts`);
  `DELETE /api/coding-agents/cleanroom/sessions/:id/container` throws the
  container away and the next turn starts a fresh one (the folder stays).

## Docker

Studio needs the host's Docker: in docker-compose, uncomment the
`/var/run/docker.sock` mount (this gives Studio full control of Docker). The
image ships the Docker CLI. When Studio itself runs in a container, it maps its
paths to host paths through its own mounts (`docker inspect` of itself), so a
chat's folder must be on a mounted volume.
