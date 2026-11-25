# Omi

Studio connects to your self-hosted [Omi](https://github.com/Wizard815/omi-local)
(omi-local, a fork of BasedHardware/omi). Omi is optional. It works three ways:

- **Omi sends work to Studio.** "Send to agent → Studio" in Omi starts a Studio
  chat. Omi signs in with a **Studio key made for Omi**, not an admin login.
- **Studio sends results back.** When one of Omi's chats finishes, fails or
  waits for an approval, Studio tells Omi on Omi's signed webhook.
- **Hermes reads Omi.** The MCP page adds Omi's MCP server to a Hermes profile
  and installs Omi's Hermes skill.

Settings live in `HERMES_WEB_UI_HOME/omi/settings.json`
(`modules/studio/services/omi/`). Only super admins see Connections → Omi.

## Connections → Omi

- **Omi's address**: Omi's backend, for example `http://omi.lan:8000`
  (`BACKEND_PORT`, 8000 by default). **Test connection** asks Omi's
  `/v1/health` (then `/health`). If it fails, the message says what Omi
  answered or that it was not reachable.
- **Omi's web page**: where **Open Omi** goes. Empty: the address above.
- **Hermes profile**: the profile Omi's chats use. Empty: `default`.
- **Studio key for Omi**: **Make a key** shows the key once
  (`sk-studio-omi-…`). Studio keeps only its SHA-256 hash. **Revoke** stops it
  at once. Each row shows when the key was last used.
- **Results back to Omi**: **Register the webhook** adds a chat webhook
  (Settings → Webhooks, named "Omi results") to
  `<Omi's address>/v1/integrations/studio/events` for `chat.run.completed`,
  `chat.run.failed` and `chat.approval.requested`, with the answer's text.
  Studio shows the signing secret once. **New secret** replaces the webhook
  and its secret. The card shows how many were sent and the last error.
  Only chats Omi started with its key are sent; every other chat is filtered
  out before delivery (`setChatWebhookEndpointFilter`).
- **Work from Omi**: the chats Omi started, with their state. Click one to open it.

## What the key can do

The key acts as the admin who made it, but only on these paths. Anything else
answers `403 This key is for Omi` (`services/omi/scope.ts`):

| Request | What it does |
|---|---|
| `POST /api/studio/orb/work` or `/api/studio/omi/work` | Start a work chat: `{agentId, title, prompt, workspace?, profile?}`. The same body Omi sends today. |
| `GET /api/studio/orb/work` or `/api/studio/omi/work` | Omi's work chats and their state (`working`, `blocked`, `done`, `idle`, `gone`). With the key, only Omi's. |
| `GET /api/studio/omi/approvals` | Agent work waiting for approval in Omi's chats. |
| `POST /api/studio/agent-work/:id/approve` or `/reject` | Answer one of those. `{by?}` names who answered in Omi. |

- The key must be in the `Authorization: Bearer` header. A key in the URL is
  refused (`401`), because URLs end up in logs.
- A revoked or unknown key answers `401`. A disabled owner answers `403`.
- An approval in a chat Omi did not start answers `404`, as if it did not
  exist.
- The chat run itself is driven inside Studio with a one-hour login for the
  key's owner. That login never leaves Studio.

## Approvals from Omi

Agent work approvals in Omi's chats can be answered from Omi, as from Studio,
Mattermost or Pondering Orb. The first answer wins; the others get
"Already approved in Omi by …". Connections → Agent work shows "Done in
Omi" and logs "approved in Omi" in its activity. The watcher's bell shows
"Approved in Omi by Robin (Omi): …" when Settings → Watcher → "Agent work
decided" is on (it is off by default). `decidedVia` is `omi`.

Per-chat command approvals (the chat's own "Allow once / Deny") are not part
of this. Omi still shows those as "answer it in Studio".

## What Omi must change

Nothing in omi-local was changed for this. To switch Omi from the admin login
to the key:

1. In Studio: Connections → Omi → address → **Make a key** → copy it.
2. In Omi: Settings → Connections → Studio → token: paste the key (it replaces
   the long-lived admin login token). omi-local has no environment variable
   for the Studio token today (`backend/utils/integrations_out.py`,
   `ENV['studio'] = ('STUDIO_URL', None)`). To set it from the stack, add one
   there, for example `STUDIO_API_KEY`, as `HERMES_API_KEY` is for Hermes.
3. In Studio: **Register the webhook** → copy the secret. In Omi:
   `STUDIO_WEBHOOK_SECRET` in `omi-host/.env`, or the webhook secret in
   Settings → Connections → Studio.
4. `HERMES_WEB_UI_AUTH_JWT_EXPIRES_IN` no longer needs to be 365 days.
   Sign out the old Omi login if you made one only for Omi.

Omi's paths stay the same (`/api/studio/orb/work`), so step 2 is enough for
"Send to agent → Studio". To answer approvals from Omi, Omi needs to list
`GET /api/studio/omi/approvals` in its Approvals page and post
`/api/studio/agent-work/<id>/approve|reject` (`backend/utils/agent_jobs.py`,
`AgentJobApproval.answerableHere` in the app).

The webhook goes to Omi's backend port. omi-local's
`omi-host/examples/integrations/README.md` says `:8080`; the backend listens
on `BACKEND_PORT` (8000). Use the address that answers **Test connection**.

## MCP page → Your home → Omi

- **Connect**: Omi's address (a bare host gets port 8000) and an Omi MCP key
  (`omi_mcp_…`, Omi app: Settings → Developer → MCP → Create key). Studio adds
  the `omi` server to the profile the MCP page edits:

  ```yaml
  mcp_servers:
    omi:
      url: http://omi.lan:8000/v1/mcp
      headers:
        Authorization: Bearer ${MCP_OMI_API_KEY}
      timeout: 120
      connect_timeout: 30
      tools:
        exclude: [delete_action_item, delete_memory, dismiss_person]
        resources: false
        prompts: false
  ```

  The key goes to the profile's `.env` as `MCP_OMI_API_KEY`, as in Omi's own
  Hermes recipe (`omi-host/examples/hermes/README.md`). "Add and test" then
  lists Omi's tools; the delete tools show as off.
- **Add Omi skill to Hermes**: copies Omi's skill to
  `<profile>/skills/productivity/omi/SKILL.md` in the profile you choose.
  The skill is bundled in Studio (`services/omi/skill.ts`), copied unchanged
  from omi-local's `omi-host/examples/hermes/skills/omi/SKILL.md` (MIT,
  Wizard815 and Hermes Agent). It is not added to other profiles.
- An Omi MCP key reads one person's conversations. Add it to that person's
  own profile, never a shared or household one. The model that reads it
  should be local.

## Studio Own (Android)

The Studio Own app takes **Share → Studio** from any app, including Omi's own
share button. See [android-devices.md](android-devices.md#share-to-studio-and-links).

## Tests

`tests/server/omi.test.ts` (key scope, sign-in, keys, webhook, approvals,
skill), `tests/server/chat-webhook-endpoint-filter.test.ts` (only Omi's chats
reach Omi's webhook), `tests/client/omi-client.test.ts` (messages, MCP card,
share parsing), `tests/e2e/omi-connection.spec.ts`.
