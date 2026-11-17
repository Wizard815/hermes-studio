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
| Skills | Skill hub (browse, preview, install, uninstall), curator card, skill lock |
| MCP | "Your home" (Home Assistant, Unraid) short forms, then the catalog of curated servers with one-click install and OAuth sign-in |
| Plugins | Plugin hub (browse, install, update, update all, uninstall, auto-update, install from Git) |
| Settings (Hermes) | Tools (toolsets and their keys/models), Terminal (local, docker, SSH, …), Subagents (delegation), Maintenance (doctor, security audit, backup/restore, checkpoints, hooks, version) |
| Jobs | Create a job from Hermes's templates |
| Models | Local models (llama.cpp: hardware, catalog, Hugging Face, downloads, activate/eject), API key pools, sign-ins Studio has no window for |

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

Those are the only Home Assistant calls it can make: `check_config`, `script.reload`,
`automation.reload`, `script.turn_on`. Deploy needs the code `show` printed for that exact
YAML, and run needs the script's entity id, so the agent cannot skip showing you what it
deploys. One-time setup: the skill's `setup` adds
`homeassistant: packages: !include_dir_named packages/hermes` to configuration.yaml (after
asking) and you restart Home Assistant once.

Turn it on in the Home Assistant form ("Let Hermes build scripts and automations"): SSH
host, port, user, a private key file on the Hermes machine, and the config folder on that
host. Home Assistant OS: the "Advanced SSH & Web Terminal" add-on, folder `/config`.
Home Assistant in Docker: SSH to the Docker host, folder = the host path mounted at
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


- When Hermes restarts the gateway itself (turning on webhooks, finishing WhatsApp setup),
  it restarts the gateway Studio supervises; Studio's supervisor replaces it with its own.
- Plugin installs act on Hermes's launch profile (Hermes's API works that way).
- Hermes's messaging relay and learning graph are not in Studio yet.
- "Use for new chats" in Local models sets Hermes's main model; Studio's own default model
  for new chats is set separately.
