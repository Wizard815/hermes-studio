# The agents' screen

Studio shows Hermes's **Bot Screen**: a desktop (Xvnc + Xfce) with a real
browser that agents use. Pick **Screen** in the chat header switch
(Chat / herdr / Code / Screen): the screen on the left, the chat on the right.
You watch it live; **Take over** gives you the keyboard and mouse (a red border
shows it), and the agent's screen and browser tools wait until you **Hand back**.
Use it for logins, 2FA, CAPTCHAs and payments. One shared screen (the Hermes
profile's), with one shared browser and logins. Super administrators only.

## Install

- With `nousresearch/hermes-agent:latest` (Studio's default base image) the
  Screen view offers **Install screen**: Studio runs `apt-get update` and
  `hermes computer-use screen install -y` (TigerVNC + Xfce, about 900 MB on
  disk, under a minute). Packages live in the container, not the data volume,
  so after the container is recreated (an image update) Studio installs them
  again by itself on start (it remembers in `<Studio data>/screen/state.json`).
- With `BASE_IMAGE=nousresearch/hermes-agent:latest-desktop` the packages are
  already in the image.
- Needs Hermes 2026.9.24 or newer. Memory: about 0.26 GB for the desktop, about
  1 GB more with a browser open. Hermes stops a screen unused for 30 minutes.

Both were tested with the real images: the screen starts, its browser
(Hermes's Chrome) opens on it, and Studio's view, Take over and Hand back work.

## How it works

- `modules/studio/services/screen/manager.ts` runs Hermes's own commands
  (`hermes computer-use screen status --json | start | stop | install`) as
  Studio's user (`HERMES_DOCKER_EXEC_AS_ROOT=1` keeps the image's shim from
  switching users).
- `bin/bot-screen-bridge.py` runs with Hermes's Python and uses Hermes's
  `tools.bot_desktop`: the lease (who drives the screen, shared with the
  agent's computer_use and browser tools) and the RFB input filter.
  `lease get|take|release|force` changes control; `bridge <viewer>` pipes the
  screen's RFB socket, passing keyboard, mouse, clipboard and resizes only
  while that viewer holds control.
- `gateway.ts`: `POST /api/studio/screen/ticket` gives a single-use, 30-second
  ticket; the viewer (noVNC 1.5.0) opens `/api/studio/screen/ws?ticket=…`.
  Logins are checked again every minute. Closing the view hands control back;
  a dropped connection keeps it (you may be mid-login). Code 4000 means someone
  else took control; the view reconnects as a watcher.
- API (super admin): `GET /api/studio/screen`, `POST …/install`, `…/start`,
  `…/stop` (`{force}`), `…/ticket`, `…/control` (`{action: take|release|force}`).

- `modules/studio/services/screen-browser/`: the agents' `ekko_studio_browser_*`
  tools drive the screen's Chrome with the Desktop app's own Browser Broker and
  automation code (`packages/desktop/src/main/browser/`). `cdp-contents.ts` stands
  in for Electron's `WebContents` over one DevTools websocket (flattened sessions,
  one per page tab; tab ids are Chrome target ids, and tabs a person opens count
  too). The port comes from `bot-screen-bridge.py browser` (exit 42: a person holds
  control, so operations fail until they hand back; 41: the screen is started
  first). Once the screen is installed Studio writes
  `<Studio home>/desktop-browser/broker.json`, unless a Desktop app on the machine
  already publishes a live one, and `/api/studio/desktop-browser/request` uses it
  for super administrators with no Desktop app connected.

## Next

- Ekko's own (Hermes) browser tools and Studio's share this Chrome; nothing yet
  coordinates two agents on the same tab beyond the Broker's per-tab lease.
- Approvals before purchases, logins and form submits; a recording of what the
  agent did; Hermes's credential vault.
