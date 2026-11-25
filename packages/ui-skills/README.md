# UI skills (bundled)

Ten UI and design skills from [jakubkrehel/skills](https://github.com/jakubkrehel/skills)
by Jakub Krehel, MIT licence (see `LICENSE` in this folder). Copied from commit
`672ae44ace6aaed65b86cbb1e2fd6fbea0e79578` (2026-11-18).

Studio installs them once into Hermes profiles, Ekko profiles and the coding
agents' skill folders. See `docs/ui-skills.md`.

| Skill | What it does |
| --- | --- |
| better-interface | One ranked UI review across all the areas below. |
| interface-review | Reviews a branch, PR or uncommitted change for UI regressions (user-invoked). |
| better-accessibility | Keyboard, focus, ARIA, forms, screen readers, WCAG 2.2. |
| better-motion | When to animate, with exact durations, easing and recipes. |
| better-ui | Radius, shadows, optical alignment, icons. |
| better-typography | Type scale, wrapping, truncation, font features. |
| better-colors | Palettes, semantic tokens, measured contrast. |
| better-layout | Grouping, alignment, responsive and RTL layout. |
| better-writing | Interface copy: labels, errors, empty states. |
| build-design | Builds UI from a Figma file or a design image. |

Left out: `afk` and `upskill` (not about UI; upskill reads past agent sessions),
`break`, `state-machine` and `variant` (they start dev servers and write
throwaway pages), and `explain-interface` (it browses outside sites).

Changes from upstream: each `SKILL.md` gets `metadata.keywords` in its
frontmatter, which Ekko needs to route skills. Nothing else is changed.
