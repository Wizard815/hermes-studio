### Oh My Hermes / OMH (https://hermes-agent.nousresearch.com/marketplace/omh, source https://github.com/rlaope/oh-my-hermes)
**Verdict:** Maybe — a real, active Hermes plugin, but it runs checks on the host without approval prompts, so try it in a clean room first, don't bundle it.
**What it is:** A Hermes plugin plus an `omh` CLI/skill pack (100+ `omh-*` skills, roles). It adds per-task model routing (categories like ultrabrain/quick with fallback chains), `/dag-ulw` graph runs through Hermes `delegate_task`, LSP tools (definition, references, diagnostics, rename), evidence probes, a file-backed memory provider and a status pane. Marketplace entry: v4.0.4, 28 tools, 10 hooks, needs Hermes 0.21.1+.
**Already in Studio/Hermes?** Partly. Studio has a model gateway (routes agents through a chosen model), approvals, and Hermes delegation already. OMH's category-based model chains overlap with the gateway; DAG runs overlap with Agent work/Vikunja only loosely. LSP tools and evidence probes are not in Studio. Studio has no OMH code (grep found only unrelated "omh" substrings).
**How to use it in Hermes Studio:** Run `hermes plugins install omh` in the Hermes container (or the "Install in Hermes" button), then enable it in Studio's Hermes plugins page (packages/server/src/modules/hermes/controllers/plugins.ts). Optionally `omh setup` for the skills. Test on one profile first. Keep its model chains pointed at the Studio gateway so routing and cost stay in one place.
**How to use it in herdr:** Not directly relevant; it is a Hermes-side plugin. Only indirect: a Hermes chat that uses `/dag-ulw` shows up as a normal herdr space, and its status pane is for Hermes Desktop, not herdr.
**How to integrate it properly (build work):**
- Small: add OMH to a "recommended plugins" list in the Hermes plugins page, with a warning about host-run checks.
- Small/medium: make `omh_gather_evidence` and `omh_team` run inside the clean room (docs/cleanroom.md) instead of the host, or leave them disabled.
- Medium (optional): show DAG run/status output in Studio chat; surface `omh_delegate_route` changes to config.yaml so they don't fight the gateway.
- Don't merge its model routing with the gateway until we see which one wins on conflicts.
**Risks:**
- `omh_gather_evidence` runs allowlisted checks on the host, outside sandbox backends and without Hermes approval; it executes any test code in the working dir. Bad fit with our ask/guarded modes.
- `omh_team` can run up to 8 approved commands on the host after one approval.
- `omh_delegate_route` writes config.yaml; the memory provider reads the profile's `.env`, `config.yaml` and pairing files.
- `omh_jev_ask` sends state to api.typesafe.ai (or openrouter.ai) only when the user names "Jev"; use own key.
- Young, fast-moving single-author project (version churn: 4.0.4 on marketplace vs 4.0.9 in repo); the marketplace has no README. Version drift against Hermes releases is a maintenance risk.
**Facts:** MIT licence (repo LICENSE; marketplace page doesn't name one). Author rlaope. Python (>=3.11), also npm package. Repo version 4.0.9, latest commit 2026-11-21, shallow clone showed 1 commit; stars not checked (GitHub API unreachable). Docs at omher.app.
