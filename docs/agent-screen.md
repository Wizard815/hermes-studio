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

## Purchases and sign-ins

Before an agent's browser tool clicks, types, selects or presses Enter,
`bin/browser/risk.mjs` checks the agent's own snapshot (read by its id, so the
agent's refs stay valid) and the page address:

- purchases: card or bank fields, "Place order", "Pay", "Buy", "Checkout",
  paid subscriptions (not newsletters);
- sign-ins: password and one-time-code fields, "Sign in" on a login form,
  filling a saved login.

A coding-agent run asks the person through Studio's question prompt
(Allow / Don't allow; an Allow covers that site and kind for 10 minutes). A run
that cannot ask (no run credential: Hermes, Ekko) stops and tells the agent to
ask the person to take over the Screen. When the target cannot be read, the
check asks rather than lets it through. Hermes's own browser tools in Hermes
chats follow Hermes's rules, not these.

## Activity

Each browser action (pages, clicks, typing without the text, batches,
uploads, downloads, dialogs, tabs) and each approval is recorded:
`POST /api/studio/screen/activity` from the tools,
`GET /api/studio/screen/activity` for the Screen view's Activity panel.
`<Studio data>/screen/activity/YYYY-MM-DD.jsonl`, 14 days; addresses without
query strings.

## Saved logins

Hermes's encrypted vault (`hermes vault`). The Screen view's Saved logins
panel lists, adds and removes logins (`GET/POST /api/studio/screen/vault`,
`DELETE …/vault/:id`); passwords go to the helper on stdin. Agents use
`ekko_studio_browser_vault`: `list` shows sites and usernames only; `fill`
asks first (a sign-in), then `bot-screen-bridge.py vault fill` writes the
password into the page with Hermes's login-form classifier and origin-checked
fill script, only on the exact site it was saved for. The result carries
counts, never the password.

## Tested

In the Hermes image (Studio running inside it): an agent's tool process opened
a tab on the screen's Chrome, read the login form and typed the email; typing
the password, pressing Sign in and filling the saved login all stopped for the
person; the Activity panel listed each step; a saved login filled on its own
site and was refused elsewhere. Not tested live: the Allow answer in a real
coding-agent chat (the prompt itself is Studio's existing clarification).
