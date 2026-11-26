# UI skills (bundled)

Studio ships ten UI and design skills so every agent builds nicer interfaces.
They come from [jakubkrehel/skills](https://github.com/jakubkrehel/skills) by
Jakub Krehel, under the MIT licence. Each skill folder carries the licence,
and `packages/ui-skills/README.md` names the commit they were copied from.

| Skill | What it does |
| --- | --- |
| better-interface | One ranked UI review across all the areas below. Start here. |
| interface-review | Reviews a branch, PR or uncommitted change for UI regressions (only when asked). |
| better-accessibility | Keyboard, focus, ARIA, forms, screen readers, WCAG 2.2. |
| better-motion | When to animate, with exact durations, easing and recipes. |
| better-ui | Radius, shadows, optical alignment, icons. |
| better-typography | Type scale, wrapping, truncation, font features. |
| better-colors | Palettes, semantic tokens, measured contrast. |
| better-layout | Grouping, alignment, responsive and RTL layout. |
| better-writing | Interface copy: labels, errors, empty states. |
| build-design | Builds UI from a Figma file or a design image. |

Not bundled: `afk` and `upskill` (not about UI; upskill reads your past agent
sessions), `break`, `state-machine` and `variant` (they start dev servers and
write throwaway pages; use them in a clean room if you want them), and
`explain-interface` (it browses outside sites). Studio never runs the repo's
`npx skills add` installer; the files are plain Markdown copied at build time.

## Where each agent gets them

About five seconds after Studio starts, it copies each skill once into:

| Agent | Folder |
| --- | --- |
| Hermes | every profile's `skills/ui-skills/` (a category; the Skills page shows it as "UI skills (bundled)") |
| Ekko | every Ekko profile's `skills/<profile>/ui-skills/` |
| Claude Code | `~/.claude/skills/` |
| Codex, OpenCode, Pi, Grok, DSH, Cursor, Antigravity | `~/.agents/skills/` (each reads it; Grok and Antigravity get it through Studio's sync) |
| Qwen, Kimi, CodeBuddy, Qoder, Copilot, ZCode | no skills folder Studio fills: their Studio prompt gets one line that points at `~/.agents/skills/<name>/SKILL.md` |
| Clean rooms | read-only at `/root/.claude/skills/<name>` and `/root/.agents/skills/<name>` |

`~` is the coding agents' home (`HERMES_CODING_AGENT_GLOBAL_HOME`, else the
user's home). A new Hermes profile gets them when it is made. herdr panes run
the same agents, so they see the same folders. If you use skillshare, its
merge mode leaves these folders alone; `skillshare collect` takes them into
its library if you want it to sync them.

Clean rooms mount a copy kept in Web UI state (`<HERMES_WEB_UI_HOME>/ui-skills/bundle`),
because Docker cannot see Studio's own image files. A skill you removed from
`~/.claude/skills` or `~/.agents/skills` on the host is left out of that
folder in new rooms too. If that copy is not on a mounted volume, rooms start
without the skills instead of failing.

## Your changes win

Studio records every copy in `<HERMES_WEB_UI_HOME>/ui-skills.json`.

- **Removed**: a skill folder you delete stays deleted. Studio never puts it back.
- **Edited**: a copy you change is never overwritten. An unchanged copy is
  replaced when a newer Studio ships a newer version of that skill.
- **Your own**: if a folder of that name was already there, Studio leaves it.

The card on each Skills page (Hermes, Ekko, and every coding agent's Skills
tab) lists the skills, the credit, and each one's state for that agent:
Installed, Edited by you, Removed by you, Your own copy, or Not yet.

## Turn it off

- **Hermes Settings → Agent → UI skills for every agent → Install on startup**.
  Off: Studio copies nothing more and stops the prompt line and clean-room
  mounts. Copies already made stay; delete them by hand if you want them gone.
- Or set `STUDIO_UI_SKILLS=0` on the container. This wins over the switch.

API (admins): `GET /api/studio/ui-skills` (the skills, the switch, each
folder's state), `PUT /api/studio/ui-skills` with `{ "enabled": false }`.

## What goes wrong

- **A skill does not show for one agent.** Check the card on that agent's
  Skills page. "Removed by you" or "Your own copy" means Studio will not touch
  it; copy the folder from `packages/ui-skills/<name>` (or `dist/ui-skills`)
  by hand. "Not yet" means Studio could not write the folder; the server log
  says why (`[ui-skills]`), and it tries again on the next start.
- **Hermes shows them under "misc".** The `skills/ui-skills/DESCRIPTION.md`
  file was deleted. Put a one-line description back, or leave it: the skills
  still work.
- **Long prompts.** The skills are long; agents load one only when it matches
  the task. `interface-review` loads only when you ask for it.
