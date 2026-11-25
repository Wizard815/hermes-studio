# Hermes Agent integrations in Studio

Studio is the UI for every Hermes Agent integration; Hermes's own dashboard is not needed.

## How it works

Studio starts Hermes's own API privately (`hermes dashboard --isolated` on a random
loopback port, with a session token only Studio knows) the first time a page needs it,
and stops it after 30 idle minutes (`STUDIO_HERMES_API_IDLE_MINUTES`). Studio's pages call
it through `/api/hermes-agent/<path>` (super administrators only), with Studio's active
profile added. Hermes's terminals, web app, secret reveal and self-update are never
forwarded. File uploads (restoring a backup) are streamed through unchanged. Hermes's
error messages that say "in the dashboard" say "in Studio".

## Where things are

| Page | What Hermes adds |
|---|---|
| Channels | Every Hermes messaging platform (generated from Hermes's field list), test buttons, Telegram and WhatsApp guided setup, pairing approvals, inbound webhooks, gateway restart banner |
| Memory | Memory provider picker (Honcho, Mem0, RetainDB, ByteRover, … and any future provider), its settings and setup |
| Skills | Skill hub (browse, preview, install, uninstall), curator card, skill lock, [UI skills (bundled)](ui-skills.md) |
| MCP | [Paper](#paper-design-canvas) card, "Your home" (Home Assistant, Unraid) short forms, then the catalog of curated servers with one-click install and OAuth sign-in |
| Plugins | Plugin hub (browse, install, update, update all, uninstall, auto-update, install from Git), [recommended plugins](#recommended-plugins) |
| Settings (Hermes) | Tools (toolsets and their keys/models), Terminal (local, docker, SSH, …), Subagents (delegation), Maintenance (doctor, security audit, backup/restore, checkpoints, hooks, version) |
| Jobs | Create a job from Hermes's templates |
| Models | Local models (llama.cpp: hardware, catalog, Hugging Face, downloads, activate/eject), API key pools, sign-ins Studio has no window for |

## Recommended plugins

Studio installs and enables eight Hermes plugins once per Hermes profile, about 30 seconds
after it starts (`STUDIO_RECOMMENDED_HERMES_PLUGINS_DELAY_MS`) and when a profile is created.
They come from Hermes's own plugin catalog by name, so Hermes installs the commit the
catalog pins, the same as the Install button on the Plugins page. They carry a
"Recommended" badge on the Plugins page (Installed and Browse tabs).

| Plugin | What it adds | What it needs before it does anything |
|---|---|---|
| agent-importers | `hermes import-agent` (OpenClaw, Claude Code, Codex, Cursor) | Nothing; Studio does not run an import. Run `hermes import-agent claude --dry-run` in a terminal yourself |
| homeassistant | Home Assistant platform and the `ha_*` tools | `HASS_TOKEN` (and `HASS_URL`) in the profile's `.env` |
| langfuse | A Langfuse trace per turn, LLM call and tool call | `HERMES_LANGFUSE_PUBLIC_KEY` and `HERMES_LANGFUSE_SECRET_KEY` (and `HERMES_LANGFUSE_BASE_URL` for your own server) |
| mcp-serve | `hermes mcp-serve`: Hermes's messaging chats as an MCP server | Nothing (see below) |
| bubblewrap | The `bubblewrap` terminal backend (Linux only) | Not used until you pick it in **Hermes Settings → Terminal → Backend**. Docker on Unraid may block `bwrap` (user namespaces); test a command there before you keep it |
| rea | REA's reverse-engineering MCP server (`npx rea-agents@6.7.0 mcp`) and two skills | Node.js 22.19+ on the Hermes host; npx downloads the package on first use. Ghidra/IDA/Hopper are your own installs |
| print3d | Idea or photo to a sliced Bambu Studio `.3mf` (community plugin) | Blender 4.2+ and `uv` on the Hermes host (Hermes refuses the install without Blender), Bambu Studio to slice. Blender runs the Python the agent writes, outside Hermes's terminal sandbox; Hermes asks before each such tool |
| gadget | Hermes Gadget (Adolanium/hermes-gadget-sdk, community): a `gadget` gateway platform for ESP32 devices such as D.A.S.H, the `gadget_*` tools and `hermes gadget` | Hermes 0.21.6+. A device to pair (`hermes gadget pair`); see [Hermes Gadget](#hermes-gadget-dash) |

Studio only enables them: it sets no keys, does not switch the terminal backend and does
not run an import. When an installed plugin's `requires_env` keys are not set, its row on
the Plugins page says which keys and that they go in the profile's `.env` file (the path is
shown), followed by a gateway restart.

**Once means once.** What Studio did is kept per profile in
`<HERMES_WEB_UI_HOME>/recommended-hermes-plugins.json`. A plugin that is done is never
touched again, so one you disable or uninstall later stays that way. A plugin that was
already installed and disabled before Studio got to it is left disabled. A plugin whose
catalog `platforms` excludes this machine (bubblewrap off Linux) is skipped for good.

**Disk.** Hermes 0.23 gives plugins with Python dependencies (homeassistant, langfuse)
their own dependency environment under `<HERMES_HOME>/installs/` plus a uv cache under
`<HERMES_HOME>/cache/uv`: plan on about 1-1.5 GB free in the Hermes data folder. With the
disk full, Hermes's own install state can end up half written; `hermes pm repair` fixes it.

**Failures are retried.** If the catalog cannot be reached (offline), a plugin needs a
newer Hermes than this one (`requires_hermes`), or Hermes refuses the install (print3d
without Blender), Studio logs one `[recommended-plugins]` warning, shows "not installed yet"
on the Plugins page and tries again on its next start. The watcher's bell gets one alert
per plugin and reason: a start that fails the same way again adds nothing; a new reason
adds a new alert. It never blocks startup or a chat.

**Slow MCP servers do not hold a chat.** A new Hermes chat waits at most 10 seconds for
the profile's MCP servers (`HERMES_AGENT_BRIDGE_MCP_WAIT_SECONDS`; `0` waits for all of
them, as before). A server that is still connecting keeps connecting in the background:
the chat starts without its tools, and chats started after it connected have them. Before
this, a server that never connected (rea, see below) made every new chat wait about 60 s.

**rea behind a proxy.** Hermes starts MCP servers with only `PATH`, `HOME`, `USER`, `LANG`,
`TERM`, `SHELL`, `TMPDIR` and `XDG_*` from its own environment. `HTTPS_PROXY`,
`NODE_EXTRA_CA_CERTS` and npm's settings are not passed, so `npx rea-agents` cannot reach
the npm registry through a proxy, even when its package is already in the npm cache, and
rea never connects ("CancelledError" in Hermes's log). Without a proxy it connects (the
first start downloads about 30 MB). To use rea through a proxy, give it its own entry in
the profile's `config.yaml`; an entry with the plugin's server name replaces the plugin's:

```yaml
mcp_servers:
  rea:
    command: npx
    args: ["-y", "rea-agents@6.7.0", "mcp"]
    env:
      HTTPS_PROXY: ${HTTPS_PROXY}
      NODE_EXTRA_CA_CERTS: ${NODE_EXTRA_CA_CERTS}
```

**mcp-serve on the MCP page.** Once mcp-serve is installed, Studio adds one stdio MCP
server named `hermes-chats` to the profile (`hermes [-p <profile>] mcp-serve`), with only
its read tools on (`conversations_list`, `conversation_get`, `messages_read`,
`attachments_fetch`, `events_poll`, `events_wait`, `channels_list`,
`permissions_list_open`). `messages_send` (sends as your connected accounts) and
`permissions_respond` stay off until you allow them under the server's tools on the MCP
page. Studio adds it once: remove it and it stays removed. A coding agent reads Hermes's
chats the same way: add a stdio server with that command under **Coding agents → MCP**.

**The gadget platform, once.** After gadget is installed, Studio sets
`platforms.gadget.enabled: true` in the profile's `config.yaml` (as `hermes gateway setup`
does), with `extra.host` / `extra.port` from `STUDIO_GADGET_HOST` / `STUDIO_GADGET_PORT`
when set. A platform that is already set on or off is left alone, and Studio never sets
it again, so switching it off stays off. The gateway listens after its next start.

**Turning it off.** **Hermes Settings → Agent → Recommended Hermes plugins → Install on
startup** (super administrators), or `STUDIO_RECOMMENDED_HERMES_PLUGINS=0` on the server
(the switch then shows as off and cannot be turned on). Turning it off installs nothing
more; plugins already installed stay. Turning the switch back on runs the install for
whatever is not done yet.

## UI skills

Every Hermes profile also gets ten UI and design skills once, in its
`skills/ui-skills/` folder (from jakubkrehel/skills, MIT). A skill you delete
or edit there stays that way. Ekko and the coding agents get them too. See
[ui-skills.md](ui-skills.md); turn it off in **Hermes Settings → Agent → UI
skills for every agent** or with `STUDIO_UI_SKILLS=0`.

## Paper (design canvas)

The MCP page's Catalog tab has a **Paper (paper.design)** card under
**Design**. Paper is a design canvas agents can read and draw on. **Add and
sign in** adds the remote server `https://mcp.paper.design` (named `paper`,
`auth: oauth`) and opens Hermes's sign-in. Studio never adds it on its own.

- Your designs and the agent's canvas edits go to Paper's servers (the model
  stays local). You need a Paper account. Paper's remote MCP is in early
  access and its limits may change.
- Clean rooms reach no host by default except the allowlist: add
  `mcp.paper.design` under **Settings → Clean rooms → Allowed hosts** for a
  clean-room agent that has Paper in its own MCP config.
- Coding agents: add the same URL in their MCP settings. Paper Desktop's local
  server (`http://127.0.0.1:29979/mcp`) is not reachable from Studio in Docker;
  use the remote one.
- Sign-in fails with "not reachable": the Paper server or your network is
  down, or the browser could not reach Hermes's callback; paste the address
  the browser landed on, as the sign-in window says.

## Hermes Gadget (D.A.S.H)

D.A.S.H and other Hermes Gadget devices talk to Hermes
through the Gadget plugin's WebSocket, protocol `hermes-gadget.v1`, on
`ws://<host>:8765/gadget`. The same device can also follow Studio's own agent activity:
it connects to Studio's Socket.IO namespace `/global-agent` and sends
`mcu.events.subscribe` (see [MCU webhook events](mcu-webhook-events.md)). The two links
are separate: Gadget runs inside the Hermes gateway, `/global-agent` inside Studio, so
turning Gadget on changes nothing on Studio's side. A device connects to `/global-agent`
with `auth: { token: <Studio login JWT>, profile, role: 'agent' }`; without `role: 'agent'`
the connection is treated as a browser and `mcu.events.subscribe` gets no answer.

- **Status:** **Connections → MCU devices → Hermes Gadget** shows whether the plugin and
  platform are on, whether the gateway listens (the plugin's `status.json` is fresh), the
  connected devices (from `plugin-data/gadget/`; device keys are never read out) and
  Hermes's own error for the platform, if any. **Restart gateway** applies a change.
  While the gateway restarts, Listening says "Restarting…" until the restarted gateway
  listens (usually within a minute); after 2 minutes without it the card says the
  restart did not come back and to check the gateway log.
- **Bind address and port:** the same panel (super administrators) writes
  `platforms.gadget.extra.host` and `.port`. Defaults: `0.0.0.0` and `8765`, or
  `STUDIO_GADGET_HOST` / `STUDIO_GADGET_PORT` the first time Studio turns the platform on.
- **Docker:** `docker-compose.yml` publishes `${STUDIO_GADGET_PUBLISH:-8765}` to the
  container's 8765 and the Dockerfile `EXPOSE`s 8765. Keep `0.0.0.0` inside the container
  and publish on one LAN address (`STUDIO_GADGET_PUBLISH=192.168.1.20:8765`); see
  [Docker](docker.md#hermes-gadget-devices-such-as-dash).
- **Safety:** plain `ws://` unless `tls_cert`/`tls_key` are set in the platform's
  `extra`; new devices need a pairing code. Never set `GADGET_ALLOW_ALL_USERS` outside
  development. A paired device can answer command approvals (allow once / deny) for its
  own chat.
- **Gadget tools in Studio's Hermes chats:** the `gadget_*` tools need the gadget hub,
  which lives in the gateway process; Studio's chats run Hermes in the bridge. There,
  `gadget_display` (title and text), `gadget_action` and `gadget_devices` go through the
  plugin's own handoff folder (`plugin-data/gadget/desk/`, the one its Desktop page uses):
  the bridge writes the request and the running gateway carries it to the device.
  A list, progress bar or QR code in `gadget_display` is shown as text lines. `gadget_ask`,
  `gadget_speak`, `gadget_play`, `gadget_widget` and `gadget_interpret` need the gateway's
  own chat (the gadget itself, Telegram, the Hermes API server); in a Studio chat they say
  so. With the gateway stopped, every gadget tool says to restart it.

## Your home: Home Assistant and Unraid

Hermes connects to both as MCP servers (MCP page, Catalog tab, "Your home"). The forms
save the server through Studio's own MCP add (`POST /api/hermes/mcp/servers`). Tokens go
to the profile's `.env` (`MCP_<NAME>_API_KEY`); config.yaml only holds `${MCP_<NAME>_API_KEY}`,
which Hermes fills in when it connects, so the MCP page never shows a token back. "Add and
test" then runs a real connection test and lists the tools.

### Home Assistant (read-only)

1. In Home Assistant: Settings → Devices & services → Add integration → "Model Context
   Protocol Server".
2. Choose what it can see: Settings → Voice assistants → Expose (the entities for Assist).
3. Your profile → Security → Long-lived access tokens → Create token.
4. In Studio: Home Assistant card → address (e.g. `http://homeassistant.local:8123`) and token.

It becomes:

```yaml
mcp_servers:
  home-assistant:
    url: http://homeassistant.local:8123/api/mcp     # streamable HTTP
    headers:
      Authorization: Bearer ${MCP_HOME_ASSISTANT_API_KEY}
    tools:
      include: ["*GetLiveContext", "*GetDateTime", "*get_items", "*get_history", "*render_template",
                "*search_actions", "*search_integrations", "search", "*__search", "*get_config_entries",
                "*get_system_info", "*get_entries", "*get_logs"]
```

"Read-only" is on by default: Hermes registers only Home Assistant's read tools. Home
Assistant 2026.11 offered 21 tools; these are the read ones (`readOnlyHint`): GetLiveContext,
GetDateTime, todo get_items, get_config_entries, search_integrations, get_history,
render_template, search_actions, search, get_system_info, system_log get_entries / get_logs.
These act and stay out: HassTurnOn, HassTurnOff, HassCancelAllTimers, HassBroadcast,
HassListAddItem / CompleteItem / RemoveItem, reload_config_entry, call_action. Older Home
Assistant versions name tools without the `domain__` prefix; the globs cover both.

### Home Assistant actions ask first

In Studio's Hermes chats, a tool call that changes something in Home Assistant asks
before it runs, like a risky command: the `homeassistant` plugin's `ha_call_service`
(turn a light on, set the heating), and every tool of Home Assistant's MCP server that is
not one of its read tools above (when "Read-only" is off). Reads go ahead: `ha_list_entities`,
`ha_get_state`, `ha_list_services` and the MCP read tools.

- The card says what would happen: `Home Assistant: light.turn_on on light.bed_light`.
- Approve once, for this chat, or always (Hermes keeps "always" per service:
  `light.turn_on`), or deny.
- In auto mode (`/yolo`, or an Agent work task set to auto) Studio answers for you and the
  call runs.
- **Trust this** in the watcher's bell offers a `tool` rule on the service. A pattern
  like `light.*` (every light service) or `light.turn_on`, for this chat, an Agent work
  task or every Hermes chat (agent `hermes`), lets the next call run without asking. See
  [watcher.md](watcher.md).

The Hermes bridge does this with a `pre_tool_call` hook that sends the call to Hermes's
own approval gate (`bridge_home_assistant.py`). Hermes's gateway chats (Telegram, the
Hermes API server) do not go through the bridge and do not ask.

### Making Home Assistant do things: Hermes builds, Home Assistant runs

Hermes does not control devices over MCP. When you want something done, Hermes writes a
script or automation and Home Assistant runs it, through the bundled skill
`home-assistant-builder` (Studio installs it into every profile):

1. Hermes writes a package with only `script:` / `automation:` and shows it to you in a
   question (clarify) before anything is copied.
2. `ha_build.py deploy` copies it over SSH to `<config>/packages/hermes/<name>.yaml`, runs
   Home Assistant's config check (a failure puts the old file back), and reloads scripts /
   automations.
3. To run a script it asks again, then calls `script.turn_on`.

Those are the only Home Assistant calls it can make: `check_config` (or `ha core check`),
`script.reload`, `automation.reload`, `script.turn_on`. Deploy needs the code `show` printed
for that exact YAML, and run needs the script's entity id, so the agent cannot skip showing
you what it deploys. After a deploy it reads `script.<id>` back and warns if Home Assistant
did not load it.

**Packages must be on, once.** Hermes's files load as packages, so configuration.yaml needs:

```yaml
homeassistant:
  packages: !include_dir_named packages
```

(if there is already a `homeassistant:` section, add only the `packages:` line under it),
then restart Home Assistant once. The skill never edits configuration.yaml: `status` (and
`deploy`) stop and print exactly that line when it is missing. An existing
`!include_dir_named <folder>` is used as it is (Hermes writes to `<folder>/hermes/`, which
Home Assistant reads because the include is recursive); `!include_dir_merge_named` or an
inline `packages:` list is reported, not changed.

#### Home Assistant OS (a VM): the SSH add-on

With Home Assistant OS the only way into the config folder is an SSH add-on inside the VM:
the official **Terminal & SSH** or the community **Advanced SSH & Web Terminal**. There is no
Docker host to SSH to.

1. MCP page → Home Assistant → tick "Let Hermes build scripts and automations". The form
   fills in port **22**, user **root** and **Studio's own key** (made once by Studio,
   `<profile>/ssh/ha_builder_ed25519`; the private key stays on the Hermes machine; "Use
   Studio's key" shows it again).
2. Copy the public key line the form shows. In Home Assistant: Settings → Add-ons →
   Terminal & SSH → Configuration → `authorized_keys`, paste it, Save, and restart the
   add-on. Advanced SSH & Web Terminal: the same under `ssh` → `authorized_keys`; its `ssh`
   `username` (default `hassio`) is the user to type in the form, and you are root after
   signing in. Under Network make sure port 22 is set (Terminal & SSH leaves it empty,
   which turns SSH off; Advanced SSH has 22).
3. SSH host: the VM's address (e.g. `homeassistant.local`). Leave "config folder" empty.

What the skill does there:

- **Config folder.** The add-ons mount Home Assistant's config at `/homeassistant`; current
  Terminal & SSH (10.x) and Advanced SSH also link `/config` to it, while older add-on
  versions only had `/config`. The skill looks for `configuration.yaml` in `/homeassistant`,
  then `/config` (`HA_BUILD_CONFIG_DIR=auto`); type a folder to override.
- **Config check with `ha`.** The add-ons ship the Supervisor's `ha` CLI, which needs the
  add-on's `SUPERVISOR_TOKEN`. Both add-ons write it to `/data/.ssh/environment` (that is
  `~/.ssh/environment`) and run sshd with `PermitUserEnvironment SUPERVISOR_TOKEN`, so a
  plain `ssh root@ha 'ha core check'` gets it; login shells also get it from
  `/etc/profile.d/homeassistant.sh`. The skill uses the session's token, else reads it from
  those files (or s6's `/run/s6/container_environment`), and runs
  `ha core check --raw-json`. Without `ha` (Docker installs) it uses Home Assistant's
  `check_config` API.
- **Reload and run** go through Home Assistant's API with the long-lived token from the
  form (`script.reload`, `automation.reload`, `script.turn_on`).

Home Assistant in Docker: SSH to the Docker host and type the host folder mounted at
`/config`. The values are saved as `HA_BUILD_URL`, `HA_BUILD_TOKEN`, `HA_BUILD_SSH_HOST`,
`HA_BUILD_SSH_PORT`, `HA_BUILD_SSH_USER`, `HA_BUILD_SSH_KEY`, `HA_BUILD_CONFIG_DIR` in `.env`.
Home Assistant's config check accepts a script with a bad field (it only logs and disables
it), so after deploying, Hermes confirms the script exists with the read tools.

### Unraid (Unraid Management Agent)

The form fits [tinkerologie/unraid-management-agent](https://github.com/tinkerologie/unraid-management-agent),
an Unraid plugin that serves stateful streamable HTTP MCP on port 8043:

- API token (default): `http://<unraid>:8043/mcp` with `Authorization: Bearer <token>`
  (Settings → Utilities → Unraid Management Agent → API Token → Generate, Apply).
- Connect URL: `http://<unraid>:8043/mcp/<connect-secret>` with no header; Studio stores the
  secret in `.env` and the URL as `.../mcp/${MCP_UNRAID_CONNECT_SECRET}`.
- No token: reads only (the agent refuses network writes without a token).

For watching only, turn on Read-Only Mode in the plugin (AI Agent Access (MCP)); it blocks
every state-changing tool on the server side. Other Unraid MCP servers can still be added
with the plain "Add" on My servers.

## Watch and trigger

Results go to "the home channel": a job's or webhook's delivery target. Until a chat app
is connected it stays in Studio (`local` / `log`); once Mattermost is connected on the
Channels page, pick Mattermost as the target and Hermes uses its home channel.

### (a) Hermes checks on a schedule (a job)

Jobs page → New job:

- Name: `House and server check`
- Schedule: `every 1h` (or `0 7,19 * * *`)
- Prompt: `Check the house with the Home Assistant tools (alarm, doors, smoke and water
  sensors) and the Unraid server with the Unraid tools (array, disks, SMART, temperatures,
  Docker, UPS). Reply only if something needs attention; otherwise reply [SILENT].`
- Deliver to: the home channel (`local` until Mattermost is connected).

The same through the API: `POST /api/hermes/jobs` with
`{"name": ..., "schedule": "every 1h", "prompt": ..., "deliver": "local"}`. `[SILENT]` runs
are not delivered, so the channel only hears about problems.

### (b) Home Assistant triggers Hermes (a webhook)

1. Channels page → Webhooks → Add: name `ha-alarm`, prompt for example
   `Home Assistant reports: {message} (entity {entity_id}, state {state}). Check the house
   with the Home Assistant tools and summarise for me.`, deliver to the home channel.
   `{field}` takes a value from the JSON Home Assistant sends.
2. In the "created" window press "Home Assistant YAML": it copies a `secrets.yaml` line
   with the secret, a `rest_command` that posts to the webhook URL, and an example
   automation. (On an existing webhook the button leaves a placeholder for the secret,
   which Hermes shows only once.)
3. Paste them into Home Assistant (secrets.yaml, configuration.yaml, automations), set the
   automation's `entity_id`, and restart Home Assistant (or reload REST commands and
   automations).

```yaml
rest_command:
  hermes_ha_alarm:
    url: "http://<studio-host>:8644/webhooks/ha-alarm"
    method: post
    content_type: application/json
    headers:
      X-Gitlab-Token: !secret hermes_ha_alarm_secret
    payload: '{{ {"event": event, "entity_id": entity_id, "state": state, "message": message} | to_json }}'
```

Home Assistant cannot compute an HMAC, so the secret goes in `X-Gitlab-Token`, which
Hermes's webhook checks as a plain shared secret (a wrong or missing one gets 401). Use it
on your LAN or over HTTPS.

### Tested on the demo box (2026-11-17)

- Home Assistant 2026.11.2 in Docker (`docker.io/homeassistant/home-assistant:stable`,
  host network, `:8123`; ghcr.io was blocked). Onboarded through its API
  (`/api/onboarding/users`, `/auth/token`, `core_config`, `analytics`, `integration`), a
  long-lived token from the websocket `auth/long_lived_access_token`, the `mcp_server`
  config flow (`POST /api/config/config_entries/flow`, handler `mcp_server`, then
  `{"llm_hass_api": ["assist"]}`), an `input_boolean.hermes_demo_light` from
  configuration.yaml exposed with `homeassistant/expose_entity`.
- Added through the form's calls: Test listed 21 tools; Hermes registered 16 (the 12 read
  tools plus resources/prompts helpers). A Hermes tool call to GetLiveContext returned the
  demo light's state; `HassTurnOn` was "Unknown tool".
- Unraid Management Agent built from source (Go) and run with `API_TOKEN`, `READ_ONLY` and
  `MCP_CONNECT_SECRET`: token and Connect URL both connected with 127 tools; a wrong token
  failed the test with 401.
- Builder: an `openssh-server` container sharing Home Assistant's config folder stood in
  for the SSH add-on. `setup`, a Home Assistant restart, `deploy` of a script that toggles
  the demo light, `run` → the light went off → on in Home Assistant. A YAML syntax error
  was rolled back by the config check; a `shell_command:` package was refused.
- Webhook: the copied YAML in Home Assistant; running the script fired the automation,
  Home Assistant posted to the webhook and the gateway started a Hermes run
  ("Hermes demo light changed to off"). Wrong or missing token: 401.

#### Home Assistant OS through the SSH add-on (later the same day)

There is no Home Assistant OS VM on the demo box, so an SSH container mimicked the
add-ons (Alpine, openssh, run as root):

- "Terminal & SSH" 10.x layout: Home Assistant's config mounted at `/homeassistant`,
  `/config` a link to it, `SUPERVISOR_TOKEN` in `/data/.ssh/environment` (= `~/.ssh/environment`)
  with `PermitUserEnvironment SUPERVISOR_TOKEN`, and `/etc/profile.d/homeassistant.sh`.
- Older layout: config mounted at `/config` only, the token only in the login profile (so a
  plain `ssh host cmd` has no token and the skill must find it).
- A `ha` shim on the PATH answering `ha core check [--raw-json]` like the Supervisor CLI: it
  refuses a missing or wrong `SUPERVISOR_TOKEN`, and otherwise runs the real Home Assistant
  container's config check (through Core's `check_config` API, where the real Supervisor
  runs `check_config` inside the Core container). Not mimicked: the Supervisor itself,
  add-on options (the key was written to `authorized_keys` directly) and the VM.

Results against Home Assistant 2026.11 (Docker, host network): the skill found
`/homeassistant` and `/config` on the two layouts and picked up the token on both; without
the packages line `status` printed the line to add and `deploy` stopped (configuration.yaml
untouched); after adding it and one restart, a chat in Studio ("make a script that turns on
the porch light at sunset") deployed `packages/hermes/porch_light_sunset.yaml` (a script and
a sunset automation) after the Deploy question, passed `ha core check`, reloaded, and after
the second question ran the script: `input_boolean.porch_light` went on. A YAML error was
rolled back with the check's message. The SSH key was Studio's (MCP page → "Use Studio's key").


- When Hermes restarts the gateway itself (turning on webhooks, finishing WhatsApp setup),
  it restarts the gateway Studio supervises; Studio's supervisor replaces it with its own.
- Plugin installs act on Hermes's launch profile (Hermes's API works that way).
- Hermes's messaging relay and learning graph are not in Studio yet.
- "Use for new chats" in Local models sets Hermes's main model; Studio's own default model
  for new chats is set separately.
