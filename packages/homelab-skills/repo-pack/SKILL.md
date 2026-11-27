---
name: repo-pack
description: Packs a GitHub repository or local folder into one Markdown file with repomix so you can read the whole codebase at once.
metadata:
  keywords:
    - read this repo
    - pack repository
    - repomix
    - github repo
    - codebase context
    - reference repo
---

# Repo pack

Packs a repository into a single AI-friendly file with
[repomix](https://github.com/yamadashy/repomix) (MIT), then you read that
file. Use it when the user names a repo to study, compare, borrow from or
build on, including their own GitHub repos.

## When to use

- "Look at github.com/x/y and tell me how it does Z."
- "Use these repos" or "read my repo X" at the start of a chat.
- A reference repo the user found online.

Skip it when the repo is already checked out in your working folder and you
only need a few files: read those files instead.

## How to run

Needs Node.js 18+ (`npx`). The version is pinned.

```bash
# A remote repo (public, or private when git can already reach it)
npx -y repomix@1.19.0 --remote https://github.com/<owner>/<repo> \
  --style markdown --compress --output /tmp/repo-pack/<repo>.md

# A branch, tag or commit
npx -y repomix@1.19.0 --remote <owner>/<repo> --remote-branch <ref> --style markdown --compress --output /tmp/repo-pack/<repo>.md

# A local folder, only some files
npx -y repomix@1.19.0 <path> --include "src/**,docs/**" --ignore "**/*.lock" --style markdown --output /tmp/repo-pack/<name>.md
```

Studio's chat composer also has an **Add a repo** button (next to the attach button): it packs
the repo on the server and attaches the file to the message, so you will see
an attached `.md` file whose path you can read directly.

## Procedure

1. Pack with `--compress` first. It keeps signatures and structure and drops
   function bodies, which cuts tokens by about 70%.
2. Read the "Directory Structure" section of the output first.
3. If the file is larger than about a quarter of your context window, do not
   read it whole. Search it for the parts you need, or pack again with
   `--include` for just those folders, without `--compress`.
4. Answer from the packed file and cite paths as `path/to/file.ts`.

## Pitfalls

- repomix runs Secretlint and leaves out files that look like secrets. Say so
  if a file the user asked about is missing.
- Private repos need git credentials on this machine. Never ask for or paste a
  token into the command line.
- `--remote` clones into a temp folder and deletes it afterwards; nothing is
  left in the user's repos.
- Keep the output outside the user's repos so it is never committed.
