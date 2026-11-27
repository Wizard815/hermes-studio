---
name: code-map
description: Uses tokensave's local code graph to find symbols, callers and impact in a repo with far fewer tokens than reading files.
metadata:
  keywords:
    - tokensave
    - code graph
    - find callers
    - impact analysis
    - where is this defined
    - codebase search
---

# Code map (tokensave)

[tokensave](https://github.com/aovestdipaperino/tokensave) (MIT) indexes a
repo into a local graph of symbols and their callers. Asking it "where is auth
handled" costs one tool call instead of dozens of searches and file reads.
This matters most for local models with small context windows.

## When to use

- You are about to explore an unfamiliar codebase, find who calls something,
  or check what a change would break.
- Skip it for repos of a few files, and for non-code folders.

## Prerequisites

- The `tokensave` binary (Rust): `cargo install tokensave --version 7.16.0`
  or a release binary from GitHub.
- The MCP server added to this agent: command `tokensave`, args `["serve"]`.
  In Studio: MCP → Directory → Recommended → tokensave → Add.
- The repo indexed once: `tokensave init` in its root (`tokensave sync` keeps
  it fresh; the server also syncs on connect).

## Procedure

1. Check the MCP tools are there (`tokensave_status` or `status`). If not, use
   `search_files` and `read_file` as usual and tell the user tokensave is not
   set up.
2. Start with the `context` tool and the task in plain words. It returns entry
   points, related symbols and code in one call.
3. Use `search` for a name, `callers` / `callees` to follow the graph, and
   `impact` before changing a public function.
4. Read whole files only for the parts you will edit.

## Pitfalls

- Only core tools are listed by default; call `tokensave_more` with an area
  (`analysis`, `edit`, `git`) when you need more.
- The index is per branch. After switching branches run `tokensave sync`.
- Do not narrate the `tokensave_metrics` savings line to the user; it wastes
  output tokens. Set `"report_savings": false` in `.tokensave/config.json`.
