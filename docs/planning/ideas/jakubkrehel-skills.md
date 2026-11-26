### jakubkrehel/skills (https://github.com/jakubkrehel/skills)
**Verdict:** Maybe — a good set of UI/design-engineering skills; install a few for coding agents when you build frontend (incl. Studio's own web UI), not as Hermes skills.
**What it is:** 16 agent skills (SKILL.md folders, plain markdown, no code to run) by Jakub Krehel about UI quality: review, motion, type, colour, a11y, layout, copy. Installed with `npx skills add jakubkrehel/skills`. Each skill also has an `agents/openai.yaml` for Codex.
**Already in Studio/Hermes?** No design/UI-review skills found. Studio already has skill pages and herdr's Skills dock; this only adds content.

**The skills (short):**
- better-interface: ranked UI review across all areas below. **Worth it.**
- interface-review: reviews a branch/PR/uncommitted diff for UI regressions. **Worth it** (fits PR flow).
- better-accessibility: keyboard, focus, ARIA, forms, WCAG 2.2. **Worth it.**
- better-motion: durations, easing, enter/exit, drag recipes. Worth it for animation work.
- better-ui: radius, shadows, optical alignment, icons. Worth it.
- better-typography / better-colors / better-layout: type scale, palettes + contrast, grouping/responsive. Optional.
- better-writing: UI copy (labels, errors, empty states). Optional; useful for Studio strings.
- build-design: build UI from Figma or an image. Only if you use Figma.
- break, state-machine, variant: render a component on a throwaway page (all scenarios / states / variants). Need a browser + dev server; run only in a clean room. Optional.
- explain-interface: explains how a site/effect was built from a URL or screenshot. Optional, needs browser.
- afk: works alone on a project on a local branch and writes a report. Useful idea, but overlaps Studio auto approvals; use only in a clean room.
- upskill: reads your past agent sessions and proposes new skills/hooks. Reads private session history; skip unless wanted, run locally.
(afk, upskill, break, state-machine, variant, interface-review, explain-interface are user-invoked only: `disable-model-invocation: true`.)

**How to use it in Hermes Studio:** Hermes is a general agent, so most of this is low value there. If wanted, copy 2-3 folders (better-writing for copy, better-interface) into the Hermes skills dir via the Skills page. Better target: the coding agents in chats. Put the folders in `~/.claude/skills/` (or the clean-room image's skills mount) so Claude Code chats see them; Codex reads the `openai.yaml`.
**How to use it in herdr:** Install into the Claude Code skills dir (or via skillshare, which syncs one skills folder to every agent) so every herdr space/pane gets them. Recommended set: better-interface, interface-review, better-accessibility, better-motion, better-ui. Check them in the Skills dock.
**How to integrate it properly (build work):**
- None required; it is content. Small: add a "Design skills" preset (git URL + chosen folders) to the skills install flow, and mount it into clean-room containers.
- Optional small: docs line in docs/cleanroom.md on which skills the image ships.
**Risks:** Skills are prompts that steer the agent; read before installing. The `npx skills add` installer runs third-party npm code, so copy folders by hand/clone instead. Several skills open a browser and start dev servers (break, state-machine, variant, afk); upskill reads session history. Token cost: SKILL.md files are long; auto-invoked ones add context every chat. Single-maintainer repo, 1 commit visible in a shallow clone.
**Facts:** MIT licence (c) 2026 Jakub Krehel; last commit 2026-11-18; 16 skills; markdown only; listed on skills.sh. Stars/releases not checked.
