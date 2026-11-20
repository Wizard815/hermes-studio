### Whiteboard (https://hermes-agent.nousresearch.com/marketplace/whiteboard)
**Verdict:** Maybe — a nice planning board, but its page only runs inside Hermes Desktop, so Studio gets the chat tools and Kanban link, not the board UI, unless we build a page for it.
**What it is:** A community Hermes plugin by Adolanium ("An agentic whiteboard"). You describe a plan and Hermes lays it out as a route, columns or a map with sticky notes. It groups rough notes, proposes owners/action items you accept one by one, and can "Run the route" (up to 3 hidden agent sessions, final brief) or "Hand to Hermes" (one agent does one note, with sources). Boards export to Markdown/CSV and can go to/from Hermes Kanban.
**Already in Studio/Hermes?** No whiteboard in Studio (repo search found nothing). Partly overlaps Pondering Orb (ideas/tasks), Agent work (Vikunja tasks) and the Hermes Kanban client (`packages/client/src/api/hermes/kanban.ts`). Nothing draws a free-form board.
**How to use it in Hermes Studio:**
- `hermes plugins install Adolanium/hermes-whiteboard` inside the Hermes Agent that Studio talks to (needs Hermes >= 0.22.6), then enable it (starts off).
- The 4 chat tools (`whiteboard_list/read/propose/create`) and the 4 hooks work in any Hermes chat, so Studio's Hermes chats can read and create boards once "Chats can read my boards" is on.
- The board page itself is `desktop/plugin.js` (Desktop SDK) and does not load in Studio. The repo also has a `dashboard/` folder (manifest.json, plugin_api.py, dist) which may be a Hermes web dashboard version; check whether Studio can embed it before building anything.
**How to use it in herdr:** Not relevant directly. Only indirect: a board linked to a chat could show what that chat is doing, but herdr spaces are not Hermes Desktop chats.
**How to integrate it properly (build work):**
- Small: docs note plus a Studio plugin-install check that shows the plugin when present.
- Medium: a "Boards" page in the client that iframes/embeds `dashboard/dist` through the Hermes proxy (if the dashboard API is stable), or a read-only board view using `plugin_api.py`.
- Medium: map "send to Kanban" to Studio's Kanban/Agent work views.
- Large (not advised): rewrite the Desktop plugin UI for Studio.
**Risks:** Very new (added ~9 days ago, v0.1.10, fast-moving), so the API will change. Hidden agent sessions can use all Hermes tools and read web pages (4 min / 24 tool-call limit; approvals denied, so they cannot do risky things). When chat access is on, board copies are kept in plugin data and notices are added to chat messages. Four hooks run every chat turn (return early if not linked). Kanban access only runs `hermes kanban` commands, no shell. Any other Desktop plugin could see board events. One user per board, 600 items max. Community project, not by Nous.
**Facts:** MIT; author Adolanium (30 plugins in catalog); v0.1.10; last commit 2026-11-20 (today); page shows "98" unlabeled (maybe installs/stars); Python backend plus one unminified JS file, no telemetry or credentials claimed; requires Hermes >= 0.22.6. I read the repo and did not run it.
