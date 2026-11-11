# Pondering Orb

Studio connects to [Pondering Orb](https://github.com/Wizard815/pondering-orb), a homelab
dashboard with tasks, projects, ideas and upkeep. Orb is optional.

- **Connect.** Connections → Pondering Orb: Orb's address and an API token from Orb's
  `ORB_API_TOKENS` (for example `studio:<token>`), or `ORB_URL` / `ORB_TOKEN` on the Studio
  server. Settings live in `HERMES_WEB_UI_HOME/orb/settings.json`
  (`modules/studio/services/orb/client.ts`, `GET /api/studio/orb`, `PUT /api/studio/orb/settings`).
- **Studio agents use Orb.** Studio's MCP server has `ekko_studio_use_orb_read` and
  `ekko_studio_use_orb_update` (in the `use` toolset), which go through
  `GET /api/studio/orb/data/:kind` and `POST /api/studio/orb/tools/:name` (an allow-list of
  Orb tools).
- **Orb sends work to Studio.** `POST /api/studio/orb/work` with `agentId` (`ekko-agent`,
  `hermes`, `claude-code`, `codex`, `pi`, `grok`, `opencode`), `prompt`, optional `title`,
  `workspace` and `orb` (`{ task: { title, list } }` or `{ project }`) starts a new Studio chat
  through Studio's own chat run and returns once it is under way. Studio follows the run and
  reports to Orb with `orb_set_agent_status`: working on its first event, blocked when it asks
  for approval or a clarification or fails, done when the run completes. Reports are sent in
  order, each with the state it was made for (`services/orb/work.ts`, kept in
  `HERMES_WEB_UI_HOME/orb/work.json`). `GET /api/studio/orb/work` lists those chats; the
  Connections tab shows them.
- **herdr.** None of this needs herdr; the herdr integration lives on the `herdr-integration`
  branch and reads the same Orb settings from Studio.

Tests: `tests/server/orb-client.test.ts`, `tests/server/orb-work.test.ts`,
`tests/e2e/orb-connection.spec.ts`.
