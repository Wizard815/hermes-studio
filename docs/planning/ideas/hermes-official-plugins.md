### Hermes Official Plugins (https://github.com/NousResearch/hermes-official-plugins)
**Verdict:** Maybe — a catalog of 22 first-party Hermes plugins; nothing to build, just turn on 3-5 of them from Studio's existing Plugins page.
**What it is:** Nous Research's repo of every official Hermes Agent plugin, one folder each (plugin.yaml or plugin.json, Python code, some bundled skills, some Hermes Desktop UI). Each is pinned in the Hermes plugin catalog and installed with `hermes plugins install <name>`.
**Already in Studio/Hermes?** Yes, the plumbing. Studio's Plugins page (docs/hermes-integrations.md) is the plugin hub: browse, install, update, uninstall, install from Git (`packages/client/src/api/hermes/extensions.ts`, `dashboard/agent-plugins/install` with `enable: true`). The Installed tab toggles via `POST /api/hermes/plugins/:key/enable|disable`, which writes `plugins.enabled` / `plugins.disabled` in the profile's `config.yaml` (`packages/server/src/modules/hermes/services/plugins/plugins.ts`). Separate from Studio's own plugin center (ctx SDK, `docs/plugins.md`), which does not run these.
**How to enable (any plugin below):** Studio, Plugins, Hub tab, search the name, Install (it enables on install). Or `hermes plugins install <name>` on the host, then toggle it in the Installed tab. Set any API keys in Settings or the plugin's config. Restart the Hermes gateway if tools do not appear. Plugins marked Desktop-only UI (cards, tabs) will not draw in Studio; only their tools/skills work.

| Plugin | What it does | Turn on? | Why | How to enable in Studio |
|---|---|---|---|---|
| homeassistant | HA gateway platform + 4 tools (list/get/call), event bus, notify | Maybe | Studio already has an HA MCP form ("Your home"); this adds event-driven reactions and cron delivery to phone. Needs HASS_TOKEN | Hub install `homeassistant`; add HASS_TOKEN + HASS_URL under Channels |
| spotify | 7 tools: playback, queue, search, playlists | No | Toy for a server box; needs Premium + local login callback | Hub install `spotify` if wanted; `hermes spotify login` |
| langfuse | Traces every turn, LLM call and tool call to Langfuse with cost | Maybe | Useful if you run Langfuse; Studio already has usage/cost (docs/harness/usage-cost.md). Sends prompts to Langfuse (sanitized by default) | Hub install `langfuse`; set Langfuse keys/host in env |
| mcp-serve | `hermes mcp-serve`: Hermes as MCP server over stdio (conversations, events, approvals) | Maybe | Lets Claude Code/Codex in clean rooms read Hermes chats; overlaps Studio's own agents/herdr. Tools flag off by default | Hub install `mcp-serve`; add as stdio MCP server on Studio's MCP page |
| bubblewrap | Linux terminal backend, each command in a bwrap sandbox | Maybe | Cheap sandbox for Hermes' own terminal without Docker; clean rooms (docs/cleanroom.md) already cover coding agents. Docker-in-Docker on Unraid may block bwrap | Install, then Settings, Terminal backend `bubblewrap` (or `hermes config set terminal.backend bubblewrap`) |
| singularity | Apptainer rootless container terminal backend | No | Docker is already your container runtime | n/a |
| camofox | Self-hosted stealth Firefox browser tools (browser_*, cookies, vault logins) | Maybe | Only if the agent screen/browser needs anti-bot fingerprints; you must run the camofox server yourself | Install; run camofox-browser container; set CAMOFOX_URL |
| memory-wiki | Dashboard tab: browsable subject pages + daily logs from session history, memory audit | Maybe | Nice read-only view of memory; dashboard tab is Hermes dashboard UI, likely not shown in Studio (Studio has its own Memory page) | Install; check if tab appears, else skip |
| hermes-security | Local repo security review with evidence, validation, export (9 tools, subagents). Apache-2.0 | Maybe | Good for scanning your own repos; heavy (many subagent calls = token cost); has Desktop UI that Studio will not show | Install; ask Hermes to run a scan; watch cost |
| snyk | Scan code/deps/containers/IaC via Snyk MCP + skill | No | Needs Snyk account/CLI; vendor service | Skip, or install + Snyk auth |
| agent-importers | `hermes import-agent`: import OpenClaw, Claude Code, Codex, Cursor setups, skills, MCP | Yes (one-off) | You use many coding agents; import skills/MCP/memory once, then uninstall. Previews first, no keys imported | Install, run `hermes import-agent claude --dry-run` in a terminal, then disable |
| advanced-delegation | Extra delegate_task modes: named model routes or Hermes-profile routes | Maybe | Fits Studio's model gateway idea (cheap vs strong model per subagent); Studio has a Subagents settings page already. Needs Hermes >= 0.22.5 | Install; `hermes delegation config`; or Settings, Subagents |
| claude-subscription-directsdk | Drives Claude Pro/Max subscription through the Claude Code CLI as a model provider (experimental) | No | Subscription-in-agent use may break Anthropic terms; Studio gateway already routes Claude Code. Experimental | Skip |
| accent-picker | Desktop status bar colour picker | No | Hermes Desktop only; Studio has its own theme (docs/theme-customization.md) | n/a |
| elevenlabs-music | Song/stems/lyrics generation (8 tools) | No | Paid ElevenLabs plan; fun only; cards are Desktop-only | Hub install; set ELEVENLABS_API_KEY |
| elevenlabs-sound-effects | Text to sound effect (1 tool) | No | Same, low value | Same |
| meshy | Text/image to 3D, rig, print via Meshy MCP (npx) | No | Paid credits, off-theme | Hub install; set Meshy key |
| blender | Blender MCP + skills for 3D scenes | No | Needs Blender on the same machine | Skip |
| touchdesigner | TouchDesigner via twozero MCP | No | Needs TouchDesigner app | Skip |
| rea | Reverse engineering through REA MCP (npx) + skills | No | Niche; pulls npx package | Skip |
| xchat | X (Twitter) encrypted DM gateway | No | Needs X developer account; not a use case | Skip |

**Suggested order:** agent-importers (one-off), then homeassistant, langfuse or mcp-serve only if wanted, bubblewrap after testing on Unraid.
**How to use it in herdr:** not relevant. These are Hermes-side tools; herdr sees them only through Hermes chats. mcp-serve is the one hook: a coding agent in a herdr pane could use it to read Hermes conversations.
**How to integrate it properly (build work):**
- Small: add a "recommended" badge or short note on the Plugins hub for 4-5 above; hide Desktop-only plugins' UI hints.
- Small: warn when a plugin's `requires_env` is unset (read from plugin.yaml) with a link to key entry.
- Optional medium: a Desktop-plugin shim (not recommended).
**Risks:** Plugins run Python/Node code with Studio-host rights (npx packages for meshy, rea, snyk). Hub entries are pinned to reviewed commits, which helps. Langfuse and hermes-security move code and prompts out or burn tokens. Most `requires_hermes` are 0.21-0.22.6, so check the Hermes version in the container.
**Facts:** MIT (hermes-security Apache-2.0); last commit 2026-11-19 (very active); shallow clone shows no star or release data; Python plus some JS Desktop bundles; 22 plugin folders; official tier of the Hermes plugin catalog.
