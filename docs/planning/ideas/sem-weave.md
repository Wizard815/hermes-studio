### sem-weave (https://hermes-agent.nousresearch.com/marketplace/sem-weave)
**Verdict:** Maybe — a tiny, safe Hermes plugin (two instruction-only skills), but it only helps if the `sem` CLI is installed where the agent runs; cheap to try, low priority.
**What it is:** A Hermes plugin v0.1.0 by Ataraxy-Labs (source: github.com/Ataraxy-Labs/sem, folder `integrations/agent-plugin`). It adds two optional skills: `sem-code-review` (find functions/classes, callers, entity-level git diffs) and `weave-merge-preview` (preview a branch merge without applying it). It only adds instructions; the agent runs the `sem` / `weave` CLIs through its normal terminal and approvals.
**Already in Studio/Hermes?** No semantic diff or merge preview. Studio has VS Code, plain git diffs, and clean rooms. Nothing overlaps beyond normal git. The sem repo also ships an MCP server crate (`sem-mcp`) that could be used instead of the skills.
**How to use it in Hermes Studio:**
- Install the `sem` CLI (Rust binary) into the Hermes/Studio Docker image and into the clean-room coding image; weave optional. Check `sem --version` (GNU Parallel also has a `sem`).
- `hermes plugins install Ataraxy-Labs/sem/integrations/agent-plugin --ref <40-char SHA> --no-enable`, then `hermes plugins enable <name>`. Pin the SHA (page says catalog install `hermes plugins install sem-weave` exists; the README says not yet in the catalog — conflicting).
- Needs Hermes >= 0.21.6; Linux is fine (tested only on macOS).
**How to use it in herdr:** Not directly. Coding agents in herdr panes could use the `sem` CLI or `sem-mcp` if installed in their image; the Hermes plugin only helps Hermes chats.
**How to integrate it properly (build work):**
- Small: add `sem` (and maybe `weave`) to the Docker images / clean-room image build.
- Small: list the plugin in Studio's Hermes plugin/skills page as a suggested install, with a note about the CLI prerequisite.
- Optional medium: register `sem-mcp` as an MCP server for non-Hermes coding agents via the model gateway/agent settings.
**Risks:** Sem may keep local indexes outside the repo. Commands disable cloud/telemetry via env vars, but the CLI is not sandboxed, and tool output goes to the model provider. The sem repo has a cloud client crate, so keep cloud off. v0.1.0 is young. Static analysis can be incomplete; a clean merge preview is not proof.
**Facts:** Dual licence Apache-2.0 / MIT (repo LICENSE-APACHE, LICENSE-MIT; the plugin dir has its own LICENSE, not checked). Rust. Last commit 2026-11-14. CLI version 0.30.1 in the repo (plugin tested with 0.27.0). Marketplace shows "3.5k" by the author (unlabeled, probably stars). Plugin added about a month ago.
