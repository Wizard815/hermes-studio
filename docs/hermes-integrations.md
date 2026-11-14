# Hermes Agent integrations in Studio

Studio is the UI for every Hermes Agent integration; Hermes's own dashboard is not needed.

## How it works

Studio starts Hermes's own API privately (`hermes dashboard --isolated` on a random
loopback port, with a session token only Studio knows) the first time a page needs it,
and stops it after 30 idle minutes (`STUDIO_HERMES_API_IDLE_MINUTES`). Studio's pages call
it through `/api/hermes-agent/<path>` (super administrators only), with Studio's active
profile added. Hermes's terminals, web app, secret reveal and self-update are never
forwarded. File uploads (restoring a backup) are streamed through unchanged. Hermes's
error messages that say "in the dashboard" say "in Studio".

## Where things are

| Page | What Hermes adds |
|---|---|
| Channels | Every Hermes messaging platform (generated from Hermes's field list), test buttons, Telegram and WhatsApp guided setup, pairing approvals, inbound webhooks, gateway restart banner |
| Memory | Memory provider picker (Honcho, Mem0, RetainDB, ByteRover, … and any future provider), its settings and setup |
| Skills | Skill hub (browse, preview, install, uninstall), curator card, skill lock |
| MCP | Catalog of curated servers with one-click install and OAuth sign-in |
| Plugins | Plugin hub (browse, install, update, update all, uninstall, auto-update, install from Git) |
| Settings (Hermes) | Tools (toolsets and their keys/models), Terminal (local, docker, SSH, …), Subagents (delegation), Maintenance (doctor, security audit, backup/restore, checkpoints, hooks, version) |
| Jobs | Create a job from Hermes's templates |
| Models | Local models (llama.cpp: hardware, catalog, Hugging Face, downloads, activate/eject), API key pools, sign-ins Studio has no window for |

## Known limits

- When Hermes restarts the gateway itself (turning on webhooks, finishing WhatsApp setup),
  it restarts the gateway Studio supervises; Studio's supervisor replaces it with its own.
- Plugin installs act on Hermes's launch profile (Hermes's API works that way).
- Hermes's messaging relay and learning graph are not in Studio yet.
- "Use for new chats" in Local models sets Hermes's main model; Studio's own default model
  for new chats is set separately.
