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
- Picking the coordinator or a thread opens its chat in the normal chat view,
  with the usual Chat | herdr switch. Super admins only, like herdr.
- A project row shows what needs you first ("1 need you", "2 working").
  Expanded, it lists the coordinator, then threads grouped as Needs you,
  Working, Done and Resolved, with herdr's status glyphs.
- **Move to project…** in a chat's right-click menu makes an existing chat a
  thread of a project (its history stays).

## What a project is made of

| Part | What it is | Stored in |
| --- | --- | --- |
| Project | Name, folder, instructions, default agent | `HERMES_WEB_UI_HOME/projects/projects.json` |
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
4. The bridge reports the agent's status (`workStatusChanged`) to the
   project. The list also reads live status from herdr's panes.
5. For agents herdr detects (Claude Code, Codex), the chat appears once the
   agent reports its session. Until then the thread shows "starting…" and
   cannot be opened.

## The coordinator

Each turn of a chat in a project gets a `<studio_project_context>` block
(Hermes chats after the message, coding agents through the turn-context hook
like Studio's other blocks). The coordinator's block has the instructions,
the open threads with their status, and how to use its tool.

The coordinator's tool is `ekko_studio_use_project` in Studio's `use` MCP
toolset. Actions: `list`, `start_thread`, `message_thread`, `read_thread`,
`resolve_thread`. The project is the calling chat's project
(`HERMES_STUDIO_SESSION_ID`) unless `arguments.project` names one.

- `message_thread` types into the thread's herdr pane. A thread whose agent
  stopped is resumed in herdr first (as Elevate does).
- A thread blocked on an approval or question is never typed into: the
  person answers it in the thread.
- `read_thread` returns the latest messages only. The coordinator sees
  results, not every step.

## API

All routes need a super admin.

| Method and path | Does |
| --- | --- |
| `GET /api/studio/projects` | Projects with threads, live status and counts |
| `POST /api/studio/projects` | New project `{ name, folder?, instructions?, defaultAgent? }` |
| `GET/PUT/DELETE /api/studio/projects/:id` | Read, change, stop being a project (chats and folder stay) |
| `POST /api/studio/projects/:id/threads` | Start a thread `{ brief, title?, agent? }` |
| `POST /api/studio/projects/:id/chats` | Existing chat joins `{ sessionId }` |
| `GET /api/studio/projects/:id/threads/:threadId` | Latest messages |
| `POST /api/studio/projects/:id/threads/:threadId/message` | `{ text }` to the thread's agent |
| `PUT /api/studio/projects/:id/threads/:threadId/resolved` | `{ resolved }` |
| `DELETE /api/studio/projects/:id/threads/:threadId` | Thread leaves the project, chat stays |
| `GET /api/studio/projects/for-session/:sessionId` | The project and role of a chat |
| `POST /api/studio/projects/tool/:action` | The coordinator tool's entry point |

## What goes wrong

- **herdr off:** starting or messaging a thread fails with "Projects run their
  threads in herdr. Turn herdr on in Agents → herdr first." The list still
  works.
- **Agent not installed or not a herdr agent** (Ekko): the thread is refused
  with a 400 naming the agent.
- **A thread never shows a chat:** herdr did not detect the agent. Open the
  herdr page to see its pane.
- **Status looks stale:** the list refreshes every 5 seconds while visible.
- Projects are not shared between Studios yet. See the federation plan.

## Code map

- `modules/studio/services/projects/store.ts`: the project file.
- `modules/studio/services/projects/service.ts`: projects, threads, context
  block; the herdr side comes in through `setProjectRuntime`.
- `bootstrap/herdr.ts` `projectRuntime()`: launches, status and messages
  through the herdr bridge.
- `modules/studio/routes/projects.ts`, `controllers/projects.ts`.
- `bin/ekko-studio-mcp.mjs`: `ekko_studio_use_project`.
- Client: `components/hermes/chat/ProjectsList.vue`, `project-groups.ts`,
  `api/studio/projects.ts`; Projects button in `PageSidebarNav.vue`.

Tests: `tests/server/projects.test.ts`, `tests/client/project-groups.test.ts`,
the project case in `tests/server/studio-mcp-arguments.test.ts`, and
`tests/e2e/projects-list.spec.ts`.
