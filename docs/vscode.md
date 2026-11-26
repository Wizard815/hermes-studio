# VS Code in Studio

Studio runs VS Code (code-server, the open-source VS Code for the browser) and
shows it in a chat: pick **Code** in the chat header switch (Chat / herdr /
Code). VS Code opens on the chat's folder with the chat on the right, so you
can watch and edit the agent's work while you talk to it. Extensions install
from Open VSX inside VS Code as usual.

Super administrators only (VS Code has a terminal and full file access as
Studio's user). Not on phones.

## Install

The first time, the Code view offers **Install VS Code**: Studio installs
code-server 4.145.2 from npm into `<Studio data>/vscode/app` (about 800 MB,
a minute or two). It stays in the data volume, so rebuilding the container does
not reinstall it. code-server needs Node 24 (the Docker image has it); the
Docker image also has `libkrb5-dev`, which the install needs to build.

Studio uses, in order: `STUDIO_CODE_SERVER` (a code-server binary), its own
install, or `code-server` on `PATH`. `STUDIO_VSCODE_NODE` picks the Node that
runs its own install when Studio itself runs on an older Node.

## How it works

- `modules/studio/services/vscode/manager.ts` starts code-server on a Unix
  socket (`<Studio data>/vscode/cs.sock`, mode 600) with `--auth none`; it is
  never on a port. Settings, extensions and VS Code's data live in
  `<Studio data>/vscode/`. It starts on first use and stops after 30 minutes
  with no use and no open window (`STUDIO_VSCODE_IDLE_MINUTES`, 0 = never).
- `gateway.ts` serves it at `/vscode/<link>/`. `POST /api/vscode/session`
  makes a link for the signed-in super administrator; each request and each
  open connection (checked every minute) is checked against their login, so
  signing out or losing the role closes VS Code. Studio's `Authorization`
  header is never passed on. Only Studio may frame it.
- On a first start Studio hides VS Code's own AI chat panel (Studio's chat is
  beside it); change it in VS Code's settings.
- `extension.ts` is Studio's extension, written into the extensions folder on
  start. **Follow agent edits** (status bar, on by default) opens a file when
  something other than you changes it and scrolls to the change. It skips
  `.git`, `node_modules`, build output, lock files and logs, and files you
  just typed in or saved.

API (super admin): `GET /api/vscode` (status and install log),
`POST /api/vscode/install`, `POST /api/vscode/session`,
`DELETE /api/vscode/session/:id`, `POST /api/vscode/stop`.
