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
| The agent program | read-only (its install folder; a link into another tree mounts that tree) |
| The agent's own config home (`CODEX_HOME`, …) | read-write (`coding-agent/model/<profile>/<provider>/<agent>`) |
| Studio's prompt and MCP files for the agent | read-only |
| The room's own home folder | read-write at `/root` (`coding-agent/cleanroom/homes/<hash>`) |
| UI skills ([ui-skills.md](ui-skills.md)) | read-only at `/root/.claude/skills/<name>` and `/root/.agents/skills/<name>`, unless turned off |
| The container's own files | read-only; `/tmp` (1 GB), `/var/tmp` and `/run` are small tmpfs folders |
| Studio | only its model proxies (`/api/codex-proxy/…`, `/api/claude-code-proxy/…`), through a tunnel |
| Internet | none directly (`--network none`); HTTPS through an allowlist proxy (`HTTPS_PROXY`) |
| Environment | only what Studio sets for the agent, never Studio's own (no host tokens) |

Not given: the host's home folder, other folders, the Docker socket, Studio's
API and tools (MCP), SSH keys, host credentials. It runs with
`no-new-privileges`, no Linux capabilities (`--cap-drop ALL`), as a non-root
user, and with CPU, memory and process limits.

Network settings (`coding-agent/cleanroom/settings.json`,
`GET/PUT /api/coding-agents/cleanroom/settings`):

- `allowlist` (default): Studio plus `allowHosts` (model APIs and package registries).
- `studio`: only Studio (agents on Studio's providers work; installs do not).
- `internet`: any host through the proxy.

The allowlist has no Paper host by default. For an agent that uses Paper's
design canvas ([hermes-integrations.md](hermes-integrations.md#paper-design-canvas)),
add `mcp.paper.design` to **Allowed hosts**.

`image` (default `node:24-bookworm-slim`, needs node for the tunnel), `cpus`,
`memory`, `pids` are there too.

The walls and checks are settings too. Each default is the safe one:

| Setting | Default | What it does |
| --- | --- | --- |
| `readOnlyRoot` | `true` | `--read-only`, with tmpfs `/tmp`, `/var/tmp`, `/run`. Off: the agent can change the image's files (only in its own container). |
| `dropAllCaps` | `true` | `--cap-drop ALL`. Off: Docker's default set minus `NET_RAW`, `SYS_CHROOT`, `MKNOD`, `AUDIT_WRITE`. |
| `capAdd` | `[]` | Capabilities given back (only `CHOWN`, `DAC_OVERRIDE`, `FOWNER`, `FSETID`, `KILL`, `SETGID`, `SETUID`, `NET_BIND_SERVICE`, `SYS_CHROOT`, `AUDIT_WRITE`, `SETFCAP`, `MKNOD`, `NET_RAW`). No supported agent needs one. |
| `user` | `auto` | Who the agent runs as. `auto`: Studio's own user, or, when Studio runs as root, the owner of the chat's folder. `room`: a user id of the room's own (20000–59999; the chat's folder must be writable for it). `root`: root, still without capabilities. |
| `selfCheck` | `true` | Run the self-check when a room starts. |
| `leakCheck` | `true` | Look for secret-looking files in the chat's folder before mounting it. |
| `egressLog` | `true` | Log every outside connection attempt. |
| `auditChain` | `true` | Link each egress line to the one before by hash. |
| `allowWebTools` | `false` | Let agents use their own web search and fetch. Off: each agent's own switch turns them off (see [Web tools](#web-tools)). |

Changing a wall (image, network, user, capabilities, read-only root, web
tools, limits) makes the room again on its next turn. The chat's folder and
the room's home folder stay.

If an agent does not start with the walls on, check its error first: it most
often wants to write somewhere outside `/root`, `/tmp` or the chat's folder.
Turn `readOnlyRoot` off for that room only as a last resort. Agents on Studio's providers (scoped mode) reach
their model through Studio; agents on their own logins need their API host in
`allowHosts` and their login inside the container.

## Web tools

With `allowWebTools` off (the default), Studio turns each agent's own web
search and fetch off with the agent's own switch
(`services/cleanroom/web-tools.ts`). Policy files are mounted read-only in
every room; each agent reads only its own. Turning `allowWebTools` on makes
the room again without them.

| Agent | How | Tools turned off | Where the switch is documented |
| --- | --- | --- | --- |
| Claude Code | `/etc/claude-code/managed-settings.json` (`permissions.deny`) | `WebSearch`, `WebFetch` | Claude Code managed settings |
| Codex | `/etc/codex/managed_config.toml` (`web_search = "disabled"`) | `web_search` | Codex managed config |
| Qwen Code | `/etc/qwen-code/settings.json` (system settings: `permissions.deny` and `tools.disabled`) | `web_fetch`, `web_search` | Qwen Code `docs/users/configuration/settings.md` |
| Gemini CLI | `/etc/gemini-cli/settings.json` (system settings: `tools.exclude`) | `google_web_search`, `web_fetch` | Gemini CLI `docs/reference/configuration.md`. Studio does not run Gemini CLI as a chat agent; the file covers it if it runs inside a room. |
| OpenCode | `/etc/opencode/opencode.json` (managed config, read last: `permission` `deny`) | `webfetch`, `websearch` | opencode 1.19.6 (`opencode-linux-x64`): managed config folder `/etc/opencode`; a `deny` permission removes the tool |
| Grok | `/etc/grok/requirements.toml` (always enforced: `disable_web_search`, `[features] web_fetch`, `backend_tools`) | `web_search`, `web_fetch`, xAI's server-side search | Grok 1.0.92 built-in user guide (config reference) |
| DSH | a patch turning the `tool-web` plugin off, `--patch /etc/studio-cleanroom/dsh-no-web-tools.patch.yml` | `web_search`, `web_fetch` | `@deepseek-ai/dsh-base` `cordis.patch.yml` (plugin id `tool-web`), `dsh-tool-web` README |
| Copilot | flags `--excluded-tools=web_fetch --disable-mcp-server=github-mcp-server` | `web_fetch`; `web_search` (from the built-in GitHub MCP server) | Copilot CLI changelog (`--excluded-tools` works in ACP mode) |
| Qoder | flags `--disallowed-tools WebSearch`, `WebFetch`, `ImageSearch` | `WebSearch`, `WebFetch`, `ImageSearch` | `@qoder-ai/qodercli` 1.1.98 (`--disallowed-tools <tool>`) |
| CodeBuddy | flag `--disallowedTools=WebSearch,WebFetch` | `WebSearch`, `WebFetch` | `@tencent-ai/codebuddy-code` 2.187.0 (`--disallowedTools`) |
| Kimi Code | `[tools] disabled` in its `config.toml` | `WebSearch`, `FetchURL` | Kimi Code `docs/en/configuration/config-files.md` |
| Pi | nothing to turn off | none: Pi has no web tools | `@earendil-works/pi-coding-agent` 1.6.1 (read, bash, edit, write, grep, find, ls) |
| Cursor, Antigravity, ZCode | can't be turned off | their web tools stay on | no switch Studio can rely on (Cursor's CLI and docs could not be read; Antigravity and ZCode document none) |

What goes wrong:

- Kimi Code has no system or managed settings file. Studio writes the switch
  into the `config.toml` Kimi reads: Studio's own (`KIMI_CODE_HOME`, written
  again every turn) or, on the agent's own login, `/root/.kimi-code/config.toml`
  in the room's home, between two marker comments it takes out again when
  web tools are allowed. The agent can edit that file inside the room; the
  change counts from its next start.
- Flags only reach turns Studio starts and herdr panes Studio opens. A
  command the agent runs inside the room (another copy of itself) does not
  get them.
- For Cursor, Antigravity and ZCode the web tools stay on. The network
  allowlist still blocks other sites, but an agent whose provider searches on
  its own servers (outside the room) is not stopped by the room.

## Self-check

When a room starts, Studio runs a small probe inside it (`services/cleanroom/probe.ts`,
plain node). It reports, and Studio judges against the settings:

- mounts, and which ones the agent can write to (the program and Studio's
  prompt files must be read-only, the chat's folder writable);
- the user it runs as (root is a warning);
- `no-new-privileges` and the capabilities left (any is a failure with
  `dropAllCaps`);
- the names of its environment variables, never their values;
- the network: a direct connection out must fail, `example.com` through the
  proxy must be refused, an allowed host (`registry.npmjs.org`) should answer,
  Studio's API must be refused;
- no Docker socket;
- web tools, for the room's agent: off (and how), "has no web tools" (Pi),
  missing (a policy file is not there, or Kimi's `config.toml` does not name
  its web tools: a failure), or "can't be turned off for <agent>; the
  network allowlist still blocks other sites" (a warning).

The chat shows a short line above the messages ("Self-check passed", or what
failed); click it to see each item. The result is kept per room
(`coding-agent/cleanroom/checks/<hash>.json`). A failed self-check does not
stop the agent: it says which wall is missing. An allowed host that does not
answer is a warning: the network outside the room is the problem, not the room.

- `GET /api/coding-agents/cleanroom/sessions/:id/check`: the last self-check and leak check.
- `POST /api/coding-agents/cleanroom/sessions/:id/check`: run the self-check again (super admin).

## Leak check

Before a new room mounts the chat's folder, Studio looks through it (four
levels deep, at most 20,000 entries, skipping `node_modules`, `.git`, build
folders) for files that usually hold secrets: `.env` files (not
`.env.example`), SSH keys (`id_rsa`, …), `*.pem`, `*.key`, keystores,
`credentials.json`, `.aws/credentials`, `.netrc`, and `.npmrc`, `.pypirc` or
`.docker/config.json` with a token line. Only file names are kept and shown,
never contents. It warns and still mounts the folder: move the files out if
the agent must not read them.

## Egress log

The allowlist proxy writes one JSON line per outside connection attempt to
`coding-agent/cleanroom/logs/<hash>.jsonl`:

```json
{"time":"2026-11-24T10:00:00.000Z","host":"example.com","port":443,"allowed":false,"reason":"not allowed (allowlist)","prev":"…","hash":"…"}
```

`allowed: true` with a `reason` means the host was allowed but could not be
reached. With `auditChain` on, each line holds the sha256 of the line before
(`prev`) and of itself (`hash`), so an edited or removed line shows: the panel
says "Log chain broken at line N". Anyone who can write the file can still
rewrite the whole chain; it shows mistakes and simple edits, it is not a
signature. A log moves to `<file>.1` at 2 MB (one old file is kept).

- `GET /api/coding-agents/cleanroom/sessions/:id/egress?limit=200`: the newest
  lines (newest last) and whether the chain holds.

Connections to Studio's model proxies go through the tunnel, not the proxy,
and are not logged here. Direct connections are impossible (`--network none`).

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
