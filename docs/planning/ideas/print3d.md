### print3d (https://hermes-agent.nousresearch.com/marketplace/print3d, source https://github.com/mfranzon/print3d)
**Verdict:** Maybe — a good fit only if you own a Bambu printer; install it as a plain Hermes plugin and build almost nothing.
**What it is:** A Hermes Agent plugin (v0.1.0, by mfranzon) that turns an idea, a photo or a shop listing into a sliced Bambu Studio `.3mf` for the Bambu Lab X2D (0.4 mm nozzle). The agent writes a Blender script; the plugin runs it, checks the mesh (overhangs, thin walls, fits, likeness to a photo), slices it, and the agent loops until checks pass. It never talks to the printer. Also has an MCP server (`mcp.json`) so Claude Code, Codex, Cursor and Gemini CLI can use it.
**Already in Studio/Hermes?** No. Nothing about Blender, Bambu or 3MF in the Studio repo. Studio's plugin/skills pages should list it once installed in Hermes.
**How to use it in Hermes Studio:**
- Run `hermes plugins install mfranzon/print3d --enable` on the machine where Hermes runs, then start a new session. Needs Hermes 0.22.2+, Blender 4.2+, Bambu Studio and `uv` on the SAME machine.
- On Unraid/Docker the Hermes container would need Blender (headless) added to its image, and a volume for `~/print3d/jobs`. Bambu Studio is only needed to open the result, so it can stay on your desktop.
- For coding agents (Claude Code etc.), use the plugin's MCP setup and register it as an MCP server in Studio settings.
**How to use it in herdr:** Mostly not relevant. Small bonus: the job folder could be shown in the Files dock, and the 3D preview HTML opened in the agent browser.
**How to integrate it properly (build work):**
- Small: docs note plus Dockerfile/compose snippet adding Blender and a jobs volume.
- Small: a Studio "files/preview" link so `~/print3d/jobs/*/view.html` and `.3mf` can be downloaded from a chat (3D view needs three.js from jsdelivr, so allow that host in the web view/CSP).
- Medium (optional): put it in a clean room only, with Blender in the clean-room image, because it runs agent-written Python.
**Risks:**
- Blender runs agent-written Python with the user's permissions, outside Hermes's terminal sandbox. Run it in a clean room/container, keep approvals on "ask" or "guarded".
- Installs Pillow and mcp from PyPI; the 3D view loads three.js from a CDN. Claims no telemetry or credentials (not audited).
- Very new (0.1.0), one author, single printer model (X2D) targeted. Heavy dependency (Blender) on a NUC.
**Facts:** MIT licence (LICENSE in repo; the marketplace page itself does not state it). Last commit 2026-11-19. Python (uv, pyproject). Version 0.1.0. Stars not retrieved.
