# Homelab skills (bundled)

Studio ships a second set of bundled skills next to the [UI skills](ui-skills.md).
They are copied the same way, to the same agents, with the same rules.

| Skill | Slash command in Hermes | What it does |
| --- | --- | --- |
| look-before-build | `/look-before-build` | Before building something new, searches awesome-selfhosted, awesome-mcp-servers and sindresorhus/awesome for projects that already do it, and recommends use, extend or build. |
| repo-pack | `/repo-pack` | Packs a GitHub repo or folder into one Markdown file with repomix, then reads it. |
| to-markdown | `/to-markdown` | Converts PDF, Office, HTML, EPUB and more to Markdown with markitdown. |
| code-map | `/code-map` | Uses tokensave's code graph (MCP) instead of reading many files. |
| sandbox | `/sandbox` | When to try things in a throwaway container on the Studio machine, any distro, and when to use the forge runners instead. See [sandbox](sandbox.md). |
| emoji | `/emoji` | Answers with one of ten emoji when that says it all; words otherwise. See [reply styles](reply-styles.md). |
| caveman, ultracave, megacave | `/caveman`, `/ultracave`, `/megacave` | Short answers that keep every technical fact. "stop caveman" turns it off. |
| caveman-commit, caveman-review | `/caveman-commit`, `/caveman-review` | One-line commit messages and one-line review findings. |

Sources and licences are in `packages/homelab-skills/README.md`. The caveman
skills are Apache-2.0 and carry their `LICENSE` and `NOTICE`.

## Where they go

The same targets as the UI skills (Hermes and Ekko profiles, `~/.claude/skills`,
`~/.agents/skills`). In Hermes and Ekko they sit in their own category folder,
`skills/homelab-skills/`. Studio copies them about seven seconds after it starts
and when a Hermes profile is made.

Studio records each copy in `<HERMES_WEB_UI_HOME>/homelab-skills.json`. A copy
you delete stays deleted; a copy you edit is never overwritten; a folder of the
same name that you made yourself is left alone.

`GET /api/studio/homelab-skills` lists the skills and each one's state per agent.

## Turn it off

Set `STUDIO_HOMELAB_SKILLS=0` on the container. Copies already made stay;
delete them by hand if you want them gone. Clean rooms do not get these
skills mounted.

## What goes wrong

- **look-before-build says "could not fetch list".** The agent's host cannot
  reach raw.githubusercontent.com. It uses a cached copy (up to a week old) when
  there is one.
- **repo-pack or to-markdown fails with "command not found".** repo-pack needs
  Node.js (`npx`); to-markdown needs `uv` (`uvx`) or markitdown installed. The
  Studio image has both; a coding agent elsewhere may not.
- **code-map says tokensave is not set up.** Add it on the MCP page
  (Directory, Recommended) and install the binary on the Hermes host.
