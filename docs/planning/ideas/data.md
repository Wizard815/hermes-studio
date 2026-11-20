### Data (https://hermes-agent.nousresearch.com/marketplace/data, source https://github.com/Adolanium/hermes-data)
**Verdict:** Maybe — the 4 chat tools are cheap to install now; the report page is built for Hermes Desktop and will not show in Studio without a port.
**What it is:** A community Hermes plugin (not Nous) by Adolanium. You open an Excel/CSV/JSON file, Hermes suggests a headline and 3–5 charts, and you accept the ones you want. All numbers are computed in code from your rows; the model only picks columns and wording. You can ask questions about the table or one chart, and export as HTML, Markdown, SVG or CSV.
**Already in Studio/Hermes?** No report/chart page in Studio. Closest things: coding agents can write charts ad hoc, and Pondering Orb is tasks, not data. Nothing to duplicate.
**How to use it in Hermes Studio:**
- Agent half (works headless): `hermes plugins install Adolanium/hermes-data` in the Hermes container (per profile, `-p <profile>`), then enable it. Chats then get `data_list`, `data_read`, `data_propose`, `data_create`.
- The UI half is `desktop/plugin.js` (206 KB, uses the Hermes Desktop SDK, system file dialog, single-file loader) plus a small dashboard stub. Neither runs inside Studio as is.
- Chat access to reports is off by default; turning it on copies columns, charts and the first 400 rows into `plugin-data/data/` in the Hermes home.
**How to use it in herdr:** Not relevant as a terminal feature. Only as a Tools-dock panel if we embed a Studio page for it (see below).
**How to integrate it properly (build work):**
- Small: add the plugin to the Hermes image / Studio plugin install list and confirm the 4 tools show up and `requires_hermes >=0.22.6` is met.
- Medium–large (optional): a Studio "Data" page using Studio's own plugin SDK (`packages/plugin-sdk`, ctx.host) or a native page: file upload instead of the desktop dialog, a backend route calling its `store.py`/`tools.py` (stdlib xlsx reader), a chart renderer. Port, not wrap; the Desktop JS is not reusable directly.
- Optional: show a report in the herdr Tools dock (Board-like tab), and let clean-room chats read reports through a mounted `plugin-data/data/`.
**Risks:** Hidden Hermes sessions (find story, ask) spend model tokens; "Ask" uses your tools and reads third-party web pages (prompt-injection surface), approvals are auto-denied there. Hidden sessions cannot be deleted. Report copies sit in Hermes home when chat access is on. Backend refuses paths inside the Hermes home (good). Young project, one author, fast version churn (0.1.8), tied to Desktop SDK changes. Disclosure says no telemetry, no credentials, no shell commands. I only read the files, did not audit all the code.
**Facts:** MIT; v0.1.8; last commit 2026-11-13 (listed "updated 5 days ago"); ~8 on the marketplace listing; Python backend + one big JS file; part of the author's "Hermes Folio" set with Sheets and Whiteboard plugins (they link to each other by window events, each works alone).
