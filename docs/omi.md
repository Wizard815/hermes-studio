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

## Studio Own and the Omi app on the phone

The Studio Own Android app (`packages/android`, package `com.ekkostudio.own`) and
the Omi app talk to each other with plain Android intents. Nothing goes through a
server, and nothing is sent or run without the person on the phone pressing a button:

- **Omi → Studio:** text (and images, by sharing) waits in a Studio chat's
  composer. The person reads it and presses Send.
- **Studio → Omi:** Studio Own opens Omi on a screen. Omi does the rest.
- **Phone AI:** Studio Own starts and stops the phone's own model servers in Termux,
  and each command is confirmed on the phone like every other Termux command.

On the servers, Omi and Hermes are already connected (MCP and "Send to agent"); that
is configured on the Omi side and not covered here.

### Omi → Studio Own

Studio Own accepts these intents. None of them sends anything: the text ends up
in a chat's composer, unsent.

| Intent | Example | Notes |
| --- | --- | --- |
| `ACTION_SEND`, type `text/plain` or `image/*`, `EXTRA_TEXT` (optional `EXTRA_SUBJECT`) | Omi's share sheet → **Studio** | The app asks **New chat** or **Current chat** first; see [android-devices.md](android-devices.md#share-to-studio-and-links). |
| `ACTION_VIEW` `ekkostudio-own://chat?text=<percent-encoded text>` | `ekkostudio-own://chat?text=Summarise%20this%20call` | `BROWSABLE`, so it also works from a link. Form encoding: `+` is a space; encode a literal `+` as `%2B`. Without `text`, an empty new chat opens. |
| `ACTION_VIEW` `ekkostudio-own://omi` | the app shortcut "Omi" | Opens Studio Own's Omi and phone AI panel. |

- Link text is trimmed and limited to **20,000 characters**; longer text is cut
  and the app says so.
- Studio Own is a single-task activity: a link while it is open replaces the page
  with the new chat (unsent drafts of other chats stay saved).
- If the app has no server configured yet, the text or share waits until the
  person connects.
- Reopening the app from Recents does not repeat a share.

From Omi (Flutter), either of these works:

```dart
// Share sheet (share_plus 11): Studio Own appears as "Studio".
SharePlus.instance.share(ShareParams(text: text, subject: title));  // then New chat or Current chat

// Straight to Studio Own (url_launcher). Encode the text.
launchUrl(Uri(scheme: 'ekkostudio-own', host: 'chat', queryParameters: {'text': text}),
    mode: LaunchMode.externalApplication);
```

To check whether Studio Own is installed, Omi's manifest needs
`<queries><package android:name="com.ekkostudio.own" /></queries>`.

#### How the text reaches the web page

Studio Own loads `<server>/#/hermes/chat?compose=<percent-encoded text>` in its
WebView, where `<server>` is the address configured in the app. Only that origin
ever gets the text, and because it is in the URL fragment it is not sent to the
server in the request. The Studio client
(`packages/client/src/utils/compose-link.ts`, `ChatPanel.vue`) removes the
`compose` query from the address, opens the new-chat page and puts the text in its
composer. The same link works in a browser.

### Studio Own → Omi

Studio Own's **Omi** panel (Android page → *This phone* → **Omi and phone AI**,
or long-press the app icon → **Omi**) opens Omi with these links:

| Button | Link | Omi should show |
| --- | --- | --- |
| Omi: waiting for your OK | `omi://approvals` | The items waiting for the person's OK (tasks, calendar events, agent commands). |
| Omi: tasks | `omi://tasks` | The task list. |
| Omi: capture | `omi://capture` | Start capturing: the recording / phone-mic screen. |

- The link is sent as `ACTION_VIEW` **to Omi's own package only**
  (`Intent.setPackage`), so another app that registers `omi://` never receives it.
  Packages tried, in order: `com.friend.ios` (prod flavor), then
  `com.friend.ios.dev` (dev flavor).
- If Omi does not handle the link (today's Omi has no `omi://` intent filter on
  Android), Studio Own opens Omi's launcher activity instead.
- Studio Own sends no extras and expects no result.

For Omi's side, an intent filter like this on its main activity is enough; the
Flutter code then routes on `uri.host`:

```xml
<intent-filter>
    <action android:name="android.intent.action.VIEW" />
    <category android:name="android.intent.category.DEFAULT" />
    <data android:scheme="omi" android:host="approvals" />
    <data android:scheme="omi" android:host="tasks" />
    <data android:scheme="omi" android:host="capture" />
</intent-filter>
```

`BROWSABLE` is not needed for Studio Own. Unknown hosts should just open Omi.

### Phone AI

Omi's phone AI guide (`omi-host/PHONE-LLM.md` in the Omi repository) runs
llama.cpp's `llama-server` (127.0.0.1:8081, with an API key) and `whisper-server`
(127.0.0.1:8080) in Termux. The Omi panel in Studio Own can:

| Button | Runs in Termux (background, in `~`) |
| --- | --- |
| Start phone AI | `~/bin/omi-phone-ai.sh` |
| Stop phone AI | `pkill llama-server; pkill whisper-server; termux-wake-unlock` |

Both go through the same confirmation as any Termux command from Studio: the app
shows the command and runs nothing until the person taps **Run**.

The panel shows a status line from two local requests, made by the app itself:

| Request | Answer | Shown as |
| --- | --- | --- |
| `GET http://127.0.0.1:8081/health` | 200 | chat model running |
| | 503 | loading the model |
| `GET http://127.0.0.1:8080/` | any HTTP answer | speech-to-text running |
| either | no answer within 1.5 s | off |

`/health` needs no API key, so the app never handles the key. The app already
allows cleartext HTTP (for Studio servers on a LAN), so no extra network security
configuration is needed for localhost.

If Termux refuses the command because `allow-external-apps` is not enabled, or
Termux is not installed, the panel shows the Termux setup steps
(see [android-devices.md](android-devices.md#termux-on-the-phone-studio-own-app)).
If the script is missing (exit code 127), it points to the phone AI guide.

## Tests

`tests/server/omi.test.ts` (key scope, sign-in, keys, webhook, approvals,
skill), `tests/server/chat-webhook-endpoint-filter.test.ts` (only Omi's chats
reach Omi's webhook), `tests/client/omi-client.test.ts` (messages, MCP card,
share parsing), `tests/e2e/omi-connection.spec.ts`.
