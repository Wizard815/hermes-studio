# Too many tools for a small model

A Hermes chat can carry hundreds of tools: every plugin and MCP server adds
its own (rea alone has 209). Hermes's tool search then hides most of them
behind `tool_search` / `tool_describe` / `tool_call`. Big models cope. Small
ones (hy4-flash in the OpenRouter E2E run) often cannot use tool search at
all, and with it off they get lost in the list.

## What the user sees

- **A notice in the chat**, once per chat, when a Hermes chat starts with more
  tools than the threshold: "This chat has 252 tools. Small models may struggle
  to pick the right one." It says how many tool search hides, and has buttons:
  - **Turn off tool search**: writes `tools.tool_search.enabled: off` to the
    chat's profile `config.yaml`. It applies from the chat's next message: the
    bridge rebuilds an idle chat's tools when that value changes and re-pins
    them (Hermes keeps a chat's tools fixed for the prompt cache, and would
    otherwise keep the tool_search bridge). That one message misses the cache.
  - **MCP servers**: opens the MCP page, where each server has its own switch
    for the profile.
  - **Tools settings**: opens Settings → Tools.
  - **Dismiss**: hides it for good in that chat.
  The same text is saved in the chat as a Studio notice (never sent to the
  model), so it is still there after a reload. When the notice is shown it
  reads the profile's current tool search setting: if it is already off, the
  notice says "Tool search is already off for this profile." and has no
  button to turn it off.
- **The watcher** notes it as an Info alert, "Many tools in a chat" (kind
  `tool_load`, in the bell by default, not posted to Mattermost).
- **Settings → Tools** (super admins):
  - **Tool search for <profile>**: on (Hermes's `auto`) or off, for the active
    profile.
  - **Warn when a chat has more than N tools**: 80 by default; 0 turns the
    notice off. One value for all of Studio.

## How it works

- The bridge (`bridge_runtime._tool_load_info`) counts the chat's tools when a
  run starts and adds them to `bridge.context.ready`: `total_tool_count`
  (visible tools plus the ones tool search hides; the hidden count comes from
  the `tool_search` description, "Search N additional tools"),
  `deferred_tool_count`, `tool_search_active` and `tool_search` (the config
  value).
- `handle-bridge-run.ts` passes that to `services/tool-load`
  (`HERMES_WEB_UI_HOME/hermes-tool-load.json`: the threshold and the chats
  already told, at most 500). A new notice is saved as a command message,
  sent as `session.command` with `action: 'tool_load'`, and recorded in the
  watcher.
- API: `GET/PUT /api/studio/tool-load` (PUT: super admin),
  `GET /api/studio/tool-load/chats/:id`, `POST …/dismiss`. The switch uses
  `PUT /api/hermes/config` with `section: tools` and the `X-Hermes-Profile`
  header.
- Client: `components/hermes/tool-load/ToolLoadBanner.vue`,
  `components/hermes/settings/HermesToolSearchSettings.vue`,
  `stores/hermes/tool-load.ts`, strings in `i18n/tool-load-messages.ts`.

## Limits

- Only Studio's own Hermes chats are counted. Group chats, Hermes in herdr and
  the gateway (Telegram, Mattermost…) are not.
- A chat that was running when the switch changed keeps its tools until its
  run ends.
- An older Hermes without tool search reports only the visible tool count;
  the notice then uses that.

## Tests

`tests/server/tool-load.test.ts` (store, threshold, watcher kind, and the
bridge's counting via `tests/server/fixtures/hermes-bridge-tool-load.py`),
`tests/e2e/tool-load.spec.ts` (the notice's buttons and Settings → Tools).
