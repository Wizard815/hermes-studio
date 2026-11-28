# Commits on the project board

Each card on a project's **Board** (docs/projects.md#board) lists the commits
its thread or pull request is working on. Hover a commit, or tab to it, and a
short caveman summary says what it does in plain words:

> Board show commits now. Hover one, get short summary. Summary saved, so model asked once.

## Where the commits come from

- **A thread with its own worktree:** the commits on its branch that no other
  branch has (local or remote, except the branch's own copy on the remote).
  That is the thread's own work, newest first, pushed or not.
- **A card with a pull request:** the PR's commits from GitHub (`GH_TOKEN`,
  `GITHUB_TOKEN` or `gh auth token`) or the homelab forge (`FORGE_URL`,
  `FORGE_TOKEN`; docs/forge.md). Each links to the commit. A thread with a PR
  shows the PR's list once it has commits, else its branch's.

A card shows the newest three and **Show all** for the rest (up to 30). The
board refreshes the lists every minute while it is open; PR lists are cached
a minute on the server.

## Summaries

The first hover asks a cheap model through Argos for one or two short
sentences. The summary is saved per commit SHA in
`HERMES_WEB_UI_HOME/projects/commit-summaries.json` (the newest 5,000), so
each commit is summarized once, and later hovers and other cards with the same
commit show it at once.

| Setting (Studio host env) | What it does |
|---|---|
| `ARGOS_URL` | Argos's OpenAI-compatible API, e.g. `http://argos:8080/v1`. Without it there are no summaries; the commit list still shows. |
| `ARGOS_API_KEY` | Only if your Argos wants a key. |
| `STUDIO_COMMIT_SUMMARY_MODEL` | The Argos model name. Default `studio-caveman`: add that name in Argos and point it at a small, cheap model. |
| `STUDIO_COMMIT_SUMMARY_URL`, `STUDIO_COMMIT_SUMMARY_API_KEY` | Another OpenAI-compatible endpoint for summaries only; they win over the Argos ones. |

The model reads the commit message, the changed files and the start of the
diff (about 6 KB). Summaries are only made for commits on a thread's branch or
a PR on the project's board.

## API

- `GET /api/studio/projects/:id/commits` → `{ threads: { [threadId]: list }, prs: { [link]: list } }`,
  where a list is `{ commits: [{ sha, short, subject, author, date, url, summary }], more }`
  or `{ error }`. `summary` is filled in when it is saved already.
- `GET /api/studio/projects/:id/commits/:sha/summary?thread=<id>` or `?pr=<link>` → `{ summary }`.

Both are super-admin only, like the rest of Projects.

## What goes wrong

- **"No summary: No summary model: set ARGOS_URL…"** `ARGOS_URL` is not set on
  the Studio host. Set it and restart Studio.
- **"Argos has no model studio-caveman"** Add that model name in Argos, or set
  `STUDIO_COMMIT_SUMMARY_MODEL` to one it has.
- **"Argos isn't answering"** Argos is down or `ARGOS_URL` is wrong. A failed
  commit is not asked again for 5 minutes, so hovering does not hammer Argos.
- **A thread shows no commits.** It has no branch (worktrees are off, or the
  folder is not a git repo), it has not committed yet, or its work is merged
  and fetched into another branch. Its PR still lists them.
- **"No commits: GitHub has no such pull request…"** The repo is private and
  Studio has no `GH_TOKEN`, or the link is wrong.

## Code map

- `packages/server/src/modules/studio/services/projects/commits.ts`: branch and PR commits, summaries, the saved file.
- `packages/server/src/modules/studio/controllers/project-commits.ts`: the two routes.
- `packages/client/src/components/hermes/chat/ProjectCommits.vue`: the list and hover on a board card.
- Tests: `tests/server/project-commits.test.ts`, `tests/client/project-commits-messages.test.ts`, `tests/e2e/projects-commits.spec.ts`.
