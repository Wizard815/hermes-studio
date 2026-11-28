# Add a repo to a chat

The chat composer has an **Add a repo** button (next to the attach button,
admins only). Pick one of your GitHub repos or paste `owner/name`, a GitHub
link or another https git URL. Studio packs it with
[repomix](https://github.com/yamadashy/repomix) 1.19.0 (MIT) into one Markdown
file and attaches it to your message, so any model can read the whole codebase.

- **Branch, tag or commit**: empty means the default branch. A
  `github.com/o/r/tree/<ref>` link sets it too.
- **Only these files**: globs like `src/**,docs/**`.
- **Compress code** (on by default): keeps signatures and structure, drops
  function bodies; about 70% fewer tokens.

repomix runs Secretlint and leaves out files that look like secrets. The clone
is temporary and deleted after packing.

## Private repos and "your GitHub repos"

Studio uses `GH_TOKEN`, `GITHUB_TOKEN` or `gh auth token` on the Studio host.
With a token, the dialog lists your repos and private ones can be packed. The
token reaches git through the environment (`GIT_CONFIG_*`), never the command
line. Without one, only public repos work.

## Repos on the family forge (Forgejo)

When the active Hermes profile has `skills.config.forgejo.url` in config.yaml
and `FORGE_TOKEN` in its `.env`, the dialog also lists your forge repos, and
forge links work, plain http included (`http://192.168.20.5:3030/owner/repo`,
or a `/src/branch/<ref>` link). `FORGE_HOSTS` (comma separated) names other
addresses of the same forge, such as `forgejo:3000`. The token goes only to the
forge, as a one-off git header; github.com always stays GitHub, and git output
shown to you has the token masked.

The same thing is available to agents as the `/repo-pack` skill
([homelab skills](homelab-skills.md)) and as the repomix MCP server
([MCP directory](mcp-directory.md)).

API (admins): `GET /api/studio/repo-pack/repos`, `POST /api/studio/repo-pack`
with `{ repo, ref?, include?, compress? }`.

## What goes wrong

- **"git could not read owner/name. If it is private, set GH_TOKEN"**: the repo
  is private or misspelled.
- **"If it is private, set FORGE_TOKEN in the Hermes profile's .env"**: a forge
  repo without a token, or one the token cannot see.
- **"more than 20 MB"**: the repo is too big for one attachment. Use an include
  pattern.
- **"Node.js (npx) is not installed"**: only on a Studio built without Node;
  the Docker image has it.
- **Packing took longer than 5 minutes**: a huge repo or a slow network. Use an
  include pattern.
