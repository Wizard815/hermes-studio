# Homelab skills (bundled)

Skills Studio copies once into every Hermes profile, every Ekko profile and the
coding agents' skill folders, the same way as the UI skills. See
`docs/homelab-skills.md`. In Hermes each one is also a slash command
(`/caveman`, `/repo-pack`, ...).

| Skill | What it does | Upstream, licence |
| --- | --- | --- |
| look-before-build | Searches awesome-selfhosted, awesome-mcp-servers and sindresorhus/awesome before building something new. | Studio. The lists it reads are CC-BY-SA-3.0, MIT and CC0; nothing from them is copied here. |
| repo-pack | Packs a repo into one Markdown file with repomix, then reads it. | Studio; runs [repomix](https://github.com/yamadashy/repomix) 1.19.0 (MIT) with `npx`. |
| to-markdown | Converts PDF, Office, HTML and other files to Markdown with markitdown. | Studio; runs [markitdown](https://github.com/microsoft/markitdown) 0.1.9 (MIT) with `uvx`. |
| code-map | Uses tokensave's code graph instead of reading many files. | Studio; uses [tokensave](https://github.com/aovestdipaperino/tokensave) (MIT). |
| sandbox | Says when to try things in a throwaway container (`ekko_studio_use_sandbox`) or on the forge runners. | Studio |
| immich | Reads the user's own Immich library: search by what's in a photo, who, where and when; today's memories; people; albums. Read only. | Studio |
| emoji | Answers with one of ten emoji when that says it all (`/emoji`); Studio's composer has the same as a setting. | Studio |
| caveman, ultracave, megacave | Terse answer voice that keeps every technical fact (`/caveman`, `/ultracave`, `/megacave`). | [JuliusBrussee/caveman](https://github.com/JuliusBrussee/caveman), Apache-2.0 |
| caveman-commit, caveman-review | One-line commit messages and one-line review findings. | same |

The caveman skills are copied from commit
`e74a11ccdb38b98d15c9f9545787c907dd15f0ab` (2026-11-25). Each folder carries
the Apache-2.0 `LICENSE` and the upstream `NOTICE`. Changes from upstream: the
folded `description` is written on one line and `metadata.keywords` is added
(Ekko needs it to route skills). Nothing else is changed. The rest of caveman
(CLI, proxy, hooks, Caveman Cloud) is not bundled.
