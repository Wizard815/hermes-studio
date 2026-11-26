### REA - Reverse Engineer Anything (https://github.com/morluto/rea ; https://hermes-agent.nousresearch.com/marketplace/rea)
**Verdict:** Maybe — real and well kept, an official Hermes plugin, but it is a niche specialist tool; install it as an optional plugin, build nothing big.
**What it is:** One MCP server (npm `rea-agents`, ~200 tools) that lets an agent inspect native binaries, .NET, Electron/JS apps, Android packages, firmware and live process/browser traffic, and return evidence. It drives Ghidra, Hopper, IDA, Kuna, JADX, GDB and similar (you bring them). The Hermes marketplace page is the same project, listed as an official NousResearch plugin (pinned to rea-agents 6.7.0, two skills: `reverse-engineer-anything`, `crash-triage`).
**Already in Studio/Hermes?** No. Nothing in Studio touches reverse engineering (repo grep found nothing). Studio's generic MCP/plugin/skill support is the only overlap.
**How to use it in Hermes Studio:**
- In the Hermes container: `hermes plugins install rea` then `hermes plugins enable rea` (needs Hermes 0.22.3+ and Node 22.19+/24.11+/26+ on PATH).
- Or add as an MCP server in Studio settings: `npx -y rea-agents@<pinned> mcp`. `npx rea-agents setup` can also register it for Claude Code/Codex.
- Best place: a dedicated clean-room image (Node + Ghidra headless + procps `ps`) so analysis of untrusted binaries is isolated, allowlist network, no host mounts except the sample folder.
- Keep approvals on "ask" or "guarded" for this plugin: some tools run commands, launch apps, touch Android devices or overwrite files without a Hermes prompt.
**How to use it in herdr:** Mostly not relevant. A herdr space running a coding agent that has REA registered gets it for free. Optional: a Skills-dock entry for the two skills.
**How to integrate it properly (build work):**
- Small: docs note + a "Reverse engineering" preset in Studio settings (MCP entry with pinned version, defaults to approvals = ask).
- Small/medium: clean-room image variant `cleanroom-rea` with Node + Ghidra, wired through `docs/cleanroom.md` mechanism.
- Optional, medium: show REA evidence/snapshot output in a Studio panel. Not needed for first use.
- Version drift: the plugin pins 6.7.0 while the repo is at 6.10.1; bump when needed.
**Risks:** Big tool surface (~200 tools) bloats agent context (README says it uses compact schemas to reduce this). Can execute targets and run commands; analysing malware needs isolation. Native decompilers (Ghidra/IDA/Hopper) are separate installs with their own licences (IDA/Hopper are paid). DISCLAIMER.md excludes DRM/anti-cheat bypass and copying proprietary code, so legal use is on you. Runs via `npx` at start, so pin the version and cache it (supply-chain risk). Very fast release pace (many releases a day).
**Facts:** MIT licence. Latest release 6.10.1, last commit 2026-11-20 (the day of checking). TypeScript/Node, with Python bridge scripts; ~9k files in repo. Marketplace plugin added about a month ago, updated hours ago; star count not visible on either page. Has Discord, website rea.tools, skills.sh listing.
