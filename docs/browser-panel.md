# Browser panel: one browser for you and the chat's model

The chat's Browser panel shows the same browser the chat's model drives. Ask in
the chat ("open example.com and tell me what the Learn more page is called"):
the model uses its browser tools, and the panel follows it live. There is no
second model and no separate task box.

## Which browser

- **The agents' Screen is installed:** the panel shows the Screen's Chrome. The
  chat's browser tools already drive that Chrome, and it holds the saved logins.
- **No Screen:** the panel runs its own Chrome. Its DevTools port listens on
  `127.0.0.1` only, and the chat's browser tools drive it through Studio's
  Browser Broker.
- **A Desktop app is sharing its browser:** the tools drive the Desktop's
  browser, as before (see remote-desktop-browser.md).

Studio picks one when it starts. If you install the Screen later, restart
Studio so the panel moves to it.

## Watching it work

- The panel repaints after every navigation, click, typed text or new tab
  (`browser.changed` socket event, at most every 250 ms). The page view also
  catches up on its 5 s tab poll if an event is missed.
- A tab the model opens becomes the panel's tab. Tabs Studio opens in the
  background stay in the background.
- Pin comments (pin-comments.md) work on whatever page the model left open.

## What goes wrong

- **The panel shows a different page from the one the model talks about:** a
  Desktop app is sharing its browser, so the tools drive that one. Stop
  sharing, or watch the Desktop.
- **"neither the agents' screen nor the browser panel is running":** the
  panel's browser failed to start (no Chromium on the server). Check the Studio
  log for `browser panel`.
- **Not a sandbox:** the model acts in a real browser that may be signed in.
  Purchases and sign-ins still ask you first. Anything in the container can reach the
  loopback DevTools port.

## Tests

- `tests/server/browser-follow-agent.test.ts`: the tools' broker drives the
  panel's browser, and the panel follows it.
- `tests/e2e/browser-chat-agent.live.spec.ts`: a real model with Studio's
  browser MCP drives the panel (`LIVE_BROWSER_CHAT=1`, `BROWSER_CHAT_VIDEO=1`;
  Node needs `NODE_USE_ENV_PROXY=1` behind a proxy).
