---
name: home-assistant-builder
description: "Build a Home Assistant script or automation for the user and hand it to Home Assistant to run: write the YAML, show it and ask, copy it over SSH into packages/hermes, check the config, reload, and (when asked) start the script. Use when the user wants Home Assistant to DO something; Hermes's Home Assistant MCP tools are read-only."
version: 1.1.0
author: Ekko
license: MIT
platforms: [linux, macos]
metadata:
  hermes:
    tags: [home-assistant, smart-home, automation, yaml, ssh]
prerequisites:
  commands: [python3, ssh]
---

# Home Assistant builder

Hermes watches Home Assistant through its MCP server, which Studio sets up
read-only. When the user wants something done in the house, you do not control
devices yourself: you **build** a script or automation, and **Home Assistant
runs it**.

The tool is `scripts/ha_build.py` in this skill's folder. It makes only these
Home Assistant calls: the config check, `script.reload`, `automation.reload`
and `script.turn_on`. It writes only `packages/hermes/<name>.yaml` in Home
Assistant's config folder. It never edits configuration.yaml.

## Settings

Read from the profile's `.env` (Studio: MCP page, Home Assistant card, "Let
Hermes build scripts"): `HA_BUILD_URL`, `HA_BUILD_TOKEN`, `HA_BUILD_SSH_HOST`,
`HA_BUILD_SSH_PORT`, `HA_BUILD_SSH_USER`, `HA_BUILD_SSH_KEY`,
`HA_BUILD_CONFIG_DIR` (`auto` finds it), or `HA_BUILD_DOCKER` for a Home
Assistant container on this same machine. Never print or ask for the token in chat.

Home Assistant OS: the SSH host is the "Terminal & SSH" or "Advanced SSH & Web
Terminal" add-on (port 22, signed in with Studio's key). The tool finds the
config folder (`/homeassistant` or `/config`) and checks the config with the
add-on's `ha core check`.

Start with `python3 scripts/ha_build.py status`. If it says **Packages: NOT
READY**, stop and tell the user exactly what it printed: the line to add to
configuration.yaml (`homeassistant:` → `packages: !include_dir_named packages`)
and that Home Assistant needs one restart. Do not edit configuration.yaml
yourself, and do not deploy until `status` says packages are ready.

## Steps

1. Write the package to a file, e.g. `/tmp/ha_<name>.yaml`. Only `script:` and
   `automation:` at the top level. Give every script and automation a clear
   `alias`, and use ids starting with `hermes_`. Use entity ids you looked up
   with the Home Assistant MCP tools (search, GetLiveContext); do not guess.

   ```yaml
   script:
     hermes_porch_light_10min:
       alias: "Porch light on for 10 minutes (Hermes)"
       sequence:
         - action: light.turn_on
           target: { entity_id: light.porch }
         - delay: "00:10:00"
         - action: light.turn_off
           target: { entity_id: light.porch }
   ```

2. `python3 scripts/ha_build.py show /tmp/ha_<name>.yaml` checks it and prints
   the YAML and a `CONFIRM=<code>` line.
3. **Ask the user before deploying**, with your clarify tool (a question with
   choices "Deploy" / "Cancel"). Put the whole YAML in the question so they see
   exactly what Home Assistant will get. Do not deploy without a yes.
4. `python3 scripts/ha_build.py deploy /tmp/ha_<name>.yaml --name <name> --confirm <code>`
   copies it, runs Home Assistant's config check (a failure undoes the copy and
   prints the errors), and reloads scripts/automations. If it prints a WARNING
   that Home Assistant did not load the script, tell the user (usually Home
   Assistant still needs its one restart after the packages line was added).
5. To run a script now, **ask again** (clarify: "Run script.<id> now?"), then
   `python3 scripts/ha_build.py run script.<id> --confirm script.<id>`.
   Home Assistant runs it; confirm the result with the read-only MCP tools.

To take one away: ask, then `remove <name> --confirm <name>`.

## Rules

- No other Home Assistant calls, no editing other files, no shell commands on the
  Home Assistant host beyond what the tool does.
- Automations you deploy run on their own later; say so plainly when asking.
- If the tool fails, report its message; do not work around it.
