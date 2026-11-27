# Projects

A project is one coordinator chat plus the threads it starts, like Claude's
projects. Each thread is an agent that runs in herdr. Normal chats do not
change: Projects is a second view of the same chat list.

## Where it is

- **Projects** in the chat menu (the chat page's sidebar, under New chat and
  Search) swaps the chat list for the projects list. **Chats** at its top
  swaps back. The choice is kept per browser (`studio_chat_list_view`), and
  `/hermes/chat?view=projects` opens it. From another page the button opens
  the chat page on Projects.
- Picking the coordinator opens its chat in the normal chat view, with the
  usual Chat | herdr switch. Super admins only, like herdr.
- On a wide screen, picking a thread keeps the coordinator open and shows the
  thread in a pane beside it (`ThreadPane.vue`): its latest messages, refreshed
  every 3 seconds, and a box that sends through `message_thread`. **Open full
  chat** swaps the thread into the main chat. On a phone a thread opens as the
  main chat. A thread waiting on you is answered in its full chat.
- The pane's header is a switcher: **All threads (n open)** or any thread,
  grouped by Needs you, Working, Done and Resolved. **All threads** (also a
  link under each project) lists every thread with its status, agent, branch
  and last message; picking one opens it.
- **All threads** has two tabs. Threads groups them like Claude's project
  threads (Needs you · 1, Working · 2, ...; Resolved starts collapsed), each with
  its latest line, how long ago it changed, its agent and its branch. Context
  shows the project's folder, instructions, default agent and switches.
- **Telling projects apart.** In the normal chat list a project's folder uses
  the Projects mark instead of a folder icon, and its chats carry a tag with the
  mark (the folder name in Recent; Coordinator or Thread inside the folder).
- **Counts.** The Projects button, and each project's folder in the normal chat
  list, carry two numbers: threads that need you (warning colour) and threads
  that are done or idle (success colour). They refresh every 10 seconds.
- A project row shows what needs you first ("1 need you", "2 working").
  Expanded, it lists the coordinator, then threads grouped as Needs you,
  Working, Done and Resolved, with herdr's status glyphs.
- **Move to project…** in a chat's right-click menu makes an existing chat a
  thread of a project (its history stays).

## What a project is made of

| Part | What it is | Stored in |
| --- | --- | --- |
| Project | Name, folder, instructions, default agent, worktrees and wake-up switches | `HERMES_WEB_UI_HOME/projects/projects.json` |
| Chat folder | A Studio chat folder with the project's name (an existing folder of that name is reused) | `session_categories` |
| Coordinator | A Hermes chat in that folder, titled "<name> · coordinator" | `sessions` |
| Thread | An agent launched in its own herdr space, its chat filed in the folder | the project file + `sessions` |

Because the project is a chat folder, Herdr App's Space Folders shows the
project's threads together (see `docs/harness/herdr.md`).

## How threads run

1. The coordinator (or **New thread** in the list) starts a thread with a
   brief and an agent (`claude-code`, `codex`, `hermes`, ...).
2. Studio launches the agent through the herdr bridge (`bridge.launchAgent`)
   with a work ref `{ project: { id, thread } }`. `folderForWork` in
   `bootstrap/herdr.ts` starts it in the project folder and files its chat
   in the project's chat folder.
3. The first prompt is the project's instructions, then the brief, then a
   request to end with a summary.
4. **Worktrees.** When the project folder is a git repo and the project's
   worktree switch is on (the default), each thread starts in its own git
   worktree under `HERMES_WEB_UI_HOME/projects/worktrees/<project>/<thread>`, on
   a new branch `studio/<title>-<thread id>` from the repo's current HEAD. Its
   prompt names the branch and says to commit there, and to push or open a pull
   request only when asked. Threads never see each other's uncommitted changes,
   and none of them changes the folder's own checkout. To combine work, the
   coordinator starts a thread that merges the branches. Outside a git repo, or
   with the switch off, threads share the project folder.
   A thread that leaves the project loses its worktree if it has no uncommitted
   changes; its branch and commits stay. A worktree with changes is left alone.
5. The bridge reports the agent's status (`workStatusChanged`) to the
   project. The list also reads live status from herdr's panes.
6. For agents herdr detects (Claude Code, Codex), the chat appears once the
   agent reports its session. Until then the thread shows "starting…" and
   cannot be opened.

## Thread stages

Each thread has a stage, worked out from what herdr reports and whether the
person has looked. FAITH's projects use the same names.

| Stage | When | Shown as |
| --- | --- | --- |
| `working` | herdr says starting, working or unknown; for a chat with no herdr pane, Studio is running it | Working |
| `needs_you` | an approval or question is on its screen (blocked), or it **failed**: its pane closed while it was still working | Needs you (with "Failed") |
| `review` | it finished (done, idle, or its pane closed after it finished) and the person has not opened it since | Ready for review |
| `done` | it finished and the person opened it afterwards | Done |
| `resolved` | the person or the coordinator put it away | Resolved |

How herdr's reports move a thread:

- herdr reports each agent's state to Studio (`workStatusChanged`), and the
  list also reads each pane's live state. When a thread first reports
  done, idle or gone, it gets a `finishedAt` time. If it is reported done
  again, or its pane closes later, the time stays the same.
- Gone straight after working, blocked or starting means the agent died
  mid-task, so the thread is marked `failed` and moves to Needs you. A pane
  that was already gone when Studio last saw it working counts the same, so
  a thread lost while Studio was down shows as failed too. When it works,
  finishes or blocks again, the flag clears.
- Opening a thread (in the list or the thread pane) records `seenAt`. A
  finished thread opened after it finished is done. If it works and finishes
  again, it goes back to review. Opening a thread does not reorder the list.
- A resolved thread whose herdr pane starts working or blocks again comes
  back. That happens when someone types into it in herdr directly, or the
  coordinator sends it a message. A repeated done report leaves it resolved.
- Hermes threads run in herdr like any other agent (`hermes` in herdr), so
  they follow the same rules. A Studio chat added to a project has no herdr
  pane. It starts as done, and it shows as working while Studio runs it.

**Auto-resolve.** Every hour, and when Studio starts, done threads are
resolved once they have been done for the project's `autoResolveDays` (3 by
default, 0 never, at most 90). A thread counts as done from whichever is later,
when it finished or when it was last opened. The sweep never touches threads in
needs_you, review or working. It checks each thread again just before saving,
so a herdr report that arrives during the sweep wins. Reopening a thread
starts its count again. The setting is in the project form ("Resolve done
threads after").

**The coordinator** sees each open thread's stage, for example
`needs_you (gone)`. It is told to resolve a thread only when nothing is left
for it or the person, and never to resolve one in needs_you or review on its
own. `resolve_done` resolves every done thread at once. On a wake-up, a
failed thread reads "failed: its herdr pane closed while it was still
working". `message_thread` resumes it.

## Board

The pane's **Board** tab is the project's kanban, with columns To do, In
progress, Needs you, Review and Done. The pane widens while it shows.

- **Threads** are cards by themselves, placed by status: working in In
  progress, needs you (blocked or failed) in Needs you, review or done in Review, resolved in Done.
  A thread moves only in or out of Done, which resolves or reopens it.
- **Tasks** are cards that are not threads yet: a to-do, or a pull request to
  follow. Add one with **Add task**; move it by dragging or with its **Move to**
  menu. **Start as thread** starts a thread on the project's default agent with
  the task's title and notes as the brief; the board then shows that thread.
- **PRs.** A card can carry a pull request (or merge request) link, shown as
  `#41`. A thread that finishes and names a PR link in its last messages gets it
  linked by itself. Add or change one with **+ PR link**, or the coordinator's
  `set_pr`.
- **Live PR status.** For github.com links, the card shows the PR's state
  (Open, Draft, Merged, Closed), its checks (Checks pass, Checks fail, Checks
  running) and Conflicts. Studio asks GitHub with `GH_TOKEN` or `GITHUB_TOKEN`,
  else `gh auth token`, else no token (public repos only), caches each answer
  for a minute, and the board refreshes every minute while it shows. A link
  with no status shows "?"; hover it for why (private repo with no token, rate
  limit, or not GitHub).
- The coordinator sees board tasks that are not threads in its context block,
  and can `add_task`, `update_task` and `start_task`.

## Artifacts

The top of the pane's **Threads** tab lists what the project made for you
("Artifacts · 2"): files (a report, a screenshot, a build) and links (a
dashboard, a deployed page), newest first, with the thread that made each.
A file opens through Studio's download route; a link opens in a new tab; ✕
takes it off the list (the file stays).

Threads and the coordinator add one with `add_artifact` (`title`, and `path` or
`url`). A relative path is taken from the thread's workspace. A file must be
inside the project folder or a thread's workspace, and must exist; links must
be http(s). A project keeps 300.

## From a repo URL

**New project** takes a **Repo URL** (`https://`, `ssh://` or `git@host:path`).
Studio clones it with the host's git (and its credentials) into the folder you
give, or, with the folder empty, into
`HERMES_WEB_UI_HOME/projects/repos/<repo>-<id>`. The project then works in the
clone like any folder: worktrees per thread, branches, PRs. The URL shows in
the Context tab.

- Local paths, `file://`, plain `http://` and option-like text are refused.
- A folder that already has files is refused (409), so nothing is overwritten.
- A failed clone (wrong URL, no access) is shown with git's last line, and no
  project is made. git never prompts for a password; set up an SSH key or a
  credential helper on the host for private repos.

## Memory

A project keeps short facts every thread and the coordinator should know: a
decision, a path, a preference. They are in the coordinator's context block,
in each new thread's brief, and in a thread chat's context block (the newest
fit in about 4000 characters).

- You add or forget one in the pane's **Context** tab, under Memory.
- The coordinator saves with `remember` (`text`) and removes with `forget`
  (`memory` id). Threads can `remember` too; only the coordinator forgets.
- Each memory says who saved it. A repeated fact is saved once. A memory is
  at most 1000 characters, and a project keeps 200.

## Models

Each thread can run its own model. In **New thread**, **Model** names it (empty:
the agent's own default); the coordinator passes `model` (and `provider`) to
`start_thread` or `start_task`. A project's **Default model** goes to threads
of its default agent only, since a model for one agent rarely fits another.
The model shows next to the agent in the list, the pane and the board. herdr
starts the agent with it, the same as picking a model when launching an agent
in herdr; an agent that doesn't know the model fails to start, and the error
shows.

## Threads talking to each other

A thread's brief tells it its thread id and project id. With
`ekko_studio_use_project` a thread can:

- `message_coordinator` (`from`, `text`): a question or an early finding. It
  reaches the coordinator as its next project turn ("Project update: “Fix the
  login test” sent a message"), even with wake-ups off.
- `message_thread` (`from`, `thread`, `text`): typed into the other thread,
  marked with who sent it and how to answer.
- `list`, `read_thread`, and `set_pr` for its own thread.

A call with `from` (or from a thread's own chat) is a thread's call: starting,
resolving and board changes are refused with a 403, so a thread asks the
coordinator instead. Messages are capped at 4000 characters and 50 waiting per
coordinator.

## Federation

Two Studios on your LAN or Tailscale can pair and share projects. Open
**Projects → Studios** (the two-squares button next to New project).

1. On Studio A, **Make a pairing code**. It lasts 5 minutes and works once;
   only its hash is stored.
2. On Studio B, type A's address (like `http://studio-a.tailnet.ts.net:8648`),
   the code, and B's own address as A reaches it. **Connect**.
3. A shows B as "Waiting for your approval". A's super admin approves it.
4. Each side picks, per paired Studio, which of its projects that Studio may
   see. Nothing is shared until you pick one.

Under **Show its projects**, B sees each project A shares: open threads with
their agent, status and PR, and board tasks. B can message A's coordinator
(it arrives as a project turn marked "From the paired Studio …", and the
coordinator is told to check with its person before anything risky) or add a
task to A's board (its notes say which Studio added it).

What crosses: project name, counts, thread titles, agents, status and PR links,
task titles and columns, and link artifacts. What never crosses: provider keys,
chats and briefs, instructions, project memory, files, the folder, approvals,
and every project you did not share.

How it is secured:

- Each Studio has its own Ed25519 device key (the one the app relay uses).
  Pairing swaps public keys; the code proves the person typed it.
- Every request between Studios is signed over the method, path, body hash,
  a nonce and the time. Requests more than 5 minutes off, replayed nonces,
  unknown keys and changed bodies get a 401.
- **Unpair** removes the Studio here and tells the other side to forget this
  one too.
- Starting threads on another Studio's herdr ("remote herdr") is not built:
  a paired Studio can only message the coordinator, which decides.

The coordinator tool has no federation actions; the person uses the Studios
dialog. Paired Studios are kept in `projects/peers.json` under the Web UI home
(mode 600).

## The coordinator

Each turn of a chat in a project gets a `<studio_project_context>` block
(Hermes chats after the message, coding agents through the turn-context hook
like Studio's other blocks). The coordinator's block has the instructions,
the open threads with their status, and how to use its tool.

The coordinator's tool is `ekko_studio_use_project` in Studio's `use` MCP
toolset. Actions: `list`, `start_thread`, `message_thread`, `read_thread`,
`resolve_thread`, `resolve_done`, `set_pr`, `add_task`, `update_task`, `start_task`, and
`message_coordinator` for threads. The project is the calling chat's project
(`HERMES_STUDIO_SESSION_ID`) unless `arguments.project` names one.

- `message_thread` types into the thread's herdr pane. A thread whose agent
  stopped is resumed in herdr first (as Elevate does).
- A thread blocked on an approval or question is never typed into: the
  person answers it in the thread.
- `read_thread` returns the latest messages only. The coordinator sees
  results, not every step.
- **Wake-ups.** When herdr reports a thread done, idle, stopped or blocked, the
  coordinator gets a turn by itself (the project's wake-up switch, on by
  default). Reports are gathered for 5 seconds, so threads that finish together
  give one turn. The turn is a `<studio_project_event>` with each thread's state
  and its last message, shown in the chat as "Project update: … is done". If the
  coordinator is already running (the person is talking to it), the wake-up
  waits for that run to end, retrying every 15 seconds for up to an hour. A
  thread that went back to work before the wake-up is left out.

## API

All routes need a super admin.

| Method and path | Does |
| --- | --- |
| `GET /api/studio/projects` | Projects with threads, live status and counts |
| `POST /api/studio/projects` | New project `{ name, folder?, repo?, instructions?, defaultAgent?, defaultModel?, autoResolveDays? }` |
| `GET/PUT/DELETE /api/studio/projects/:id` | Read, change, stop being a project (chats and folder stay) |
| `POST /api/studio/projects/:id/threads` | Start a thread `{ brief, title?, agent? }` |
| `POST /api/studio/projects/:id/chats` | Existing chat joins `{ sessionId }` |
| `GET /api/studio/projects/:id/threads/:threadId` | Latest messages |
| `POST /api/studio/projects/:id/threads/:threadId/message` | `{ text }` to the thread's agent |
| `PUT /api/studio/projects/:id/threads/:threadId/resolved` | `{ resolved }` |
| `POST /api/studio/projects/:id/threads/:threadId/seen` | The person opened it: review becomes done |
| `DELETE /api/studio/projects/:id/threads/:threadId` | Thread leaves the project, chat stays |
| `PUT /api/studio/projects/:id/threads/:threadId/pr` | `{ pr }`: the thread's PR link, `''` clears it |
| `GET /api/studio/projects/:id/prs` | Live status of the board's GitHub PRs |
| `POST /api/studio/projects/:id/artifacts` | Add `{ title?, path? or url?, thread? }` |
| `DELETE /api/studio/projects/:id/artifacts/:artifactId` | Take one off the list |
| `POST /api/studio/projects/:id/memory` | Remember `{ text }` |
| `DELETE /api/studio/projects/:id/memory/:memoryId` | Forget one |
| `POST /api/studio/projects/:id/tasks` | New board task `{ title, notes?, column?, pr? }` |
| `PUT/DELETE /api/studio/projects/:id/tasks/:taskId` | Change `{ title?, notes?, column?, pr? }` or remove a task |
| `POST /api/studio/projects/:id/tasks/:taskId/start` | Start a thread from a task `{ agent? }` |
| `GET /api/studio/projects/for-session/:sessionId` | The project and role of a chat |
| `POST /api/studio/projects/tool/:action` | The coordinator tool's entry point |

Paired Studios (super admin):

| Method and path | Does |
| --- | --- |
| `GET /api/studio/peers` | This Studio's id and label, and paired Studios |
| `POST /api/studio/peers/code` | A one-time pairing code `{ code, expiresAt }` |
| `POST /api/studio/peers/pair` | Pair `{ url, code, selfUrl, label? }` |
| `PUT /api/studio/peers/:peerId` | `{ approved?, label?, url?, projects? }`: approve, rename, or pick shared projects |
| `DELETE /api/studio/peers/:peerId` | Unpair on both sides |
| `GET /api/studio/peers/:peerId/projects` | The projects that Studio shares with this one |
| `POST /api/studio/peers/:peerId/projects/:projectId/message` | `{ text }` to its coordinator |
| `POST /api/studio/peers/:peerId/projects/:projectId/tasks` | `{ title, notes? }` on its board |

Between Studios (no login; signed with the sender's device key, headers
`x-studio-peer`, `x-studio-nonce`, `x-studio-timestamp`, `x-studio-signature`):
`POST /api/studio/federation/pair`, `GET /api/studio/federation/projects`,
`POST /api/studio/federation/projects/:id/message`,
`POST /api/studio/federation/projects/:id/tasks`,
`DELETE /api/studio/federation/peer`.

## What goes wrong

- **herdr off:** starting or messaging a thread fails with "Projects run their
  threads in herdr. Turn herdr on in Agents → herdr first." The list still
  works.
- **Agent not installed or not a herdr agent** (Ekko): the thread is refused
  with a 400 naming the agent.
- **A thread never shows a chat:** herdr did not detect the agent. Open the
  herdr page to see its pane.
- **Status looks stale:** the list refreshes every 5 seconds while visible.
- **A new thread shows "Working" with no chat yet:** herdr takes a moment to
  list a new pane. A thread gets 60 seconds before a missing pane counts as
  failed.
- **A new thread moves to "Needs you" after a minute:** the agent sat on its
  first-run screen (sign-in, trust or theme) and never started. Open its pane
  in herdr and answer it.
- **A failed thread:** its pane closed while it worked. Send it a message; it
  resumes in a new pane and keeps reporting to the project, even after a
  Studio restart.
- **"That pairing code is wrong or expired":** codes last 5 minutes and work
  once. Make a new one on the other Studio.
- **"The other Studio at … isn't answering":** check that it runs and that
  this Studio can reach the address over the LAN or Tailscale.
- **"Waiting for approval":** the other Studio has not approved this one yet.
- **401 between Studios:** the clocks are more than 5 minutes apart, or a
  reverse proxy changes the path or body. Sync the clocks (NTP), and serve
  Studio at the root of its address.
- **A shared project shows nothing:** the other side shared no projects with
  this Studio yet.

- **"Could not make a git worktree for the thread":** git refused, usually
  because the repo has no commit yet or a branch of that name exists. Commit
  once, or turn the project's worktree switch off.
- **The coordinator never hears back:** its wake-up switch is off, or Studio's
  chat runs were not ready. Ask it to check with `read_thread`. A failed
  wake-up turn is logged ("Project coordinator wake-up failed") and not
  retried.
- **herdr fails to launch the agent:** the thread and its worktree are
  removed, and the error is shown. Its branch was never used, so nothing is
  lost.
- **A project folder inside a repo** (say `apps/web`): each thread starts in
  the same subfolder of its own checkout.
- **A message to a resolved thread** reopens it, so its next report reaches
  the coordinator.
- **A thread shows "Failed":** its herdr pane closed while it was working,
  for example because the agent crashed, the pane was closed or herdr
  restarted. Send it a message to carry on, or resolve it.
- **A finished thread stays in "Ready for review":** nobody has opened it
  since it finished. Open it once and it moves to Done.
- **Done threads never go away by themselves:** the project's auto-resolve is
  0. Edit the project and set a number of days.
- **"Auto-resolve takes a whole number of days from 0 (never) to 90":** the
  setting accepts only that.
- **"A PR is a link that starts with https://":** PR links must be http(s)
  URLs. Paste the PR's address, not its number.
- **A thread card won't move to To do or Review:** threads follow their status.
  Only Done (resolve) and back can be chosen.
- **A thread removed while it is open in the pane:** the pane shows all
  threads instead. If the whole project is removed, the pane closes.

## Code map

- `modules/studio/services/projects/store.ts`: the project file. Changes
  build on the latest saved copy, so two changes that land together both
  stay.
- `modules/studio/services/projects/service.ts`: projects, threads, context
  block, wake-ups; the herdr side comes in through `setProjectRuntime`.
- `modules/studio/services/projects/worktree.ts`: thread worktrees and branches.
- `bootstrap/herdr.ts` `projectRuntime()`: launches, status and messages
  through the herdr bridge.
- `modules/studio/routes/projects.ts`, `controllers/projects.ts`.
- `modules/studio/services/projects/peers.ts`, `routes/peers.ts`,
  `controllers/peers.ts`: paired Studios and the federation API.
- `bin/ekko-studio-mcp.mjs`: `ekko_studio_use_project`.
- Client: `components/hermes/chat/ProjectsList.vue`, `ThreadPane.vue`, `ProjectBoard.vue`, `StudiosDialog.vue`, `ProjectAttentionBadges.vue`, `ProjectIcon.vue`, `project-groups.ts`,
  `api/studio/projects.ts`; Projects button in `PageSidebarNav.vue`.

Tests: `tests/server/projects.test.ts`, `tests/client/project-groups.test.ts`,
the project case in `tests/server/studio-mcp-arguments.test.ts`, and
`tests/e2e/projects-list.spec.ts`, `tests/e2e/projects-thread-pane.spec.ts`,
`tests/e2e/projects-board.spec.ts`.

Live check with real models (opt-in, uses OpenRouter):
`LIVE_PROJECTS=1 NODE_USE_ENV_PROXY=1 npx vitest run tests/live/projects-coordinator.live.test.ts`.
A coordinator model drives the real project service; each thread is a worker
model with file and git tools in the project's one folder. herdr and the
database are stood in. Models are set with `LIVE_COORDINATOR_MODEL`,
`LIVE_CLAUDE_MODEL`, `LIVE_CODEX_MODEL` and `LIVE_HERMES_MODEL`.
