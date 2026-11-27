---
name: look-before-build
description: Before building a new app, service, tool or MCP server, searches awesome-selfhosted, awesome-mcp-servers and sindresorhus/awesome for projects that already do it.
metadata:
  keywords:
    - build something new
    - existing project
    - self-hosted alternative
    - mcp server
    - awesome list
    - before you build
---

# Look before you build

Many things people ask to build already exist as a self-hosted app, a library
or an MCP server. Spend one minute checking before writing code. This skill
searches three curated lists and any other "awesome" list on GitHub.

## When to use

- The user asks you to build, write or set up a new app, service, bot,
  dashboard, integration, connector or MCP server.
- The user asks "is there something that does X?" or "what should I use for X?".
- Skip it for small edits to existing code, bug fixes and one-off scripts.

## How to run

The helper needs only Python 3 and network access. It caches each list for a
week in `~/.cache/awesome-lists`.

```bash
python3 scripts/awesome_search.py "<what they want, 2-5 words>" --list all
python3 scripts/awesome_search.py "<words>" --list selfhosted   # apps you run at home (Docker etc.)
python3 scripts/awesome_search.py "<words>" --list mcp          # MCP servers (tools for agents)
python3 scripts/awesome_search.py "<topic>" --list awesome      # find a topic's own awesome list
python3 scripts/awesome_search.py "<words>" --list https://github.com/<owner>/awesome-<topic>
```

`scripts/` is next to this SKILL.md. Add `--json` for machine-readable output,
`--limit 20` for more results, `--refresh` to ignore the cache.

## Procedure

1. Turn the request into 2 to 5 plain words ("recipe manager", "zigbee logs").
   Try a synonym if the first search finds nothing.
2. Search `selfhosted` for apps and `mcp` for agent tools. For a programming
   topic, search `awesome` first, then search the sub-list it points to.
3. Open the top two or three hits (`web_extract` or the browser) and check the
   licence, the last commit date and whether it runs in Docker.
4. Tell the user what you found in a short list: name, link, one line on fit,
   licence. Then recommend one of:
   - **Use it as is** (give the Docker or install line),
   - **Extend it** (what is missing and where it would go), or
   - **Build new**, with the reason the existing ones do not fit.
5. Build only after the user picks, unless they already said to build anyway.

## Pitfalls

- The lists are curated, not exhaustive. "No matches" means "not on these
  lists", not "does not exist".
- awesome-selfhosted marks each entry's licence and language in backticks at
  the end of the line (`AGPL-3.0` `Docker`). Mention AGPL and non-free
  licences when the user would ship or modify the code.
- awesome-mcp-servers marks language and scope with emoji: 🐍 Python,
  📇 TypeScript, 🏎️ Go, 🦀 Rust, 🏠 local, ☁️ cloud, 🎖️ official.
- Do not install anything from a list without the user's go-ahead.
