# Approval alerts: Mattermost, the Android app, both or off

When an agent waits for a yes or no, Studio can ask you outside the browser:
in Mattermost, on your phone with the Studio Own app, in both, or nowhere
(only Studio's bell and the chat). Each super admin picks for themselves.

The first answer counts, wherever it comes from (Studio, Mattermost, the
phone, Pondering Orb, Omi). The other places then stop asking and say where
it was answered: "Already approved on phone (Pixel 8).", "Already rejected in
Studio by robin."

## What you pick

**Settings → Watcher → Where approvals reach you**:

- **Send approvals to**: Mattermost, Android app, Both or Off.
- **Which ones**:
  - **Agent work**: work waiting for approval (Connections → Agent work).
  - **Chat approvals**: a chat's own "Allow once / Deny" (Hermes, Ekko, coding
    agents).
  - **Phone actions**: an agent asking to use a phone from the Android page.
  - **Blocked alerts**: the watcher's Blocked alerts (run limits, clean-room
    blocks, pipelock). Nothing to answer; they open Studio.

Nobody picked yet: Studio does what it did before. Agent work approvals go to
Mattermost (when Agent work has a channel); nothing else is new.

### Mattermost

Mattermost has one channel for everyone, the one in Connections → Agent
work. A kind goes there when at least one super admin sends it there (a super
admin who never picked counts as "Agent work to Mattermost").

- **Agent work** keeps its own `#agentwork #approval` posts with their
  buttons and ✅ / ❌ reactions. When nobody wants Agent work in Mattermost, the
  approval post is skipped; the other `#agentwork` posts stay.
- **Chat approvals and phone actions** get a post tagged `#approval
  #chatapproval` or `#approval #phone`, with the same Approve / Reject
  buttons. Answered anywhere, the post loses its buttons and says how it ended.
  There are no reactions on these posts.
- **Blocked alerts** are posted as the watcher posts them. The Mattermost
  column of Settings → Watcher still turns each event on by itself (run limits
  are on by default).
- The buttons need "Studio address for Mattermost buttons" in Connections →
  Agent work. Without it the posts say to answer in Studio or on the phone.
- Who may press the buttons: the same people as for Agent work (the user
  "Set up Mattermost" set up, and the mentioned usernames; nobody named means
  anyone in the channel).

### The Android app

Each item becomes a notification: a title ("Claude Code asks to run a
command in Fix the gate"), the command or task, and **Approve** / **Reject**.

- Risky ones (`rm -rf`, `sudo`, `git push --force`, `curl … | sh`, `DROP
  TABLE`, shell or install on a phone…) do not answer from the notification:
  the button opens the app, which shows the whole command and asks again, with
  **Open chat**.
- Tapping the notification opens the chat in the app.
- After an answer, the notification shows Studio's reply for a minute,
  including "Already approved in Studio by robin."
- When the question is answered anywhere else, its notification goes away.
- Blocked alerts are notifications without buttons.
- Android 13 and newer asks once to allow notifications. Without it nothing
  shows, and Settings → Android app says "Notifications are off for Studio Own".

## Pairing a phone

**Settings → Android app → Pair this phone** (super admins):

1. **Make a pairing code**. Studio shows a QR code and the code
   (`ABCD-EFGH`). It works once, for 10 minutes.
2. Scan the QR code with the phone's camera. It is a `studio-own://pair?…`
   link: Studio Own opens, asks "Turn on approval alerts?", and pairs.
   Or, inside Studio Own, open Settings → Android app and press **Pair this
   phone** (no code needed), or type a code made on another screen.
3. The phone gets its own key (`sk-studio-phone-…`). Studio keeps only its
   SHA-256 hash (`HERMES_WEB_UI_HOME/approval-alerts.json`). The key stays in
   the app's private storage.
4. Live alerts start.

**Remove** on a paired phone revokes its key at once and closes its stream;
the phone then forgets the key. **Send a test notification** sends a test to
the phones that are connected now.

The app pairs with the server it is already connected to. The QR code's
server is only used when the app has none yet. Twenty wrong codes in ten
minutes block pairing for ten minutes.

### What the phone's key can do

Only these, and only for its owner's choice (Android app or Both, and the
kinds picked). Anything else answers `403`:

| Request | What it does |
| --- | --- |
| `GET /api/studio/approval-alerts/device` | The phone's name, its owner, whether alerts are on. |
| `GET /api/studio/approval-alerts/device/approvals` | The waiting items, once. |
| `GET /api/studio/approval-alerts/device/stream` | Server-sent events: `approvals` with the whole list now and on each change; `test`; `revoked`. A `: ping` comment every 45 s. |
| `POST /api/studio/approval-alerts/device/approvals/<id>/approve` or `/reject` | Answer one. The reply's `message` says what happened. |

- The key must be in `Authorization: Bearer`. A key in the URL answers `401`.
- A removed key answers `401`. An owner who is no longer an active super admin
  answers `403`.
- An item of a kind the owner does not get on the phone answers `403`.

Pairing itself is `POST /api/studio/approval-alerts/pair` with `{code, name}`
(no login; the one-use code is the secret).

## Battery

**Live** (the default after pairing): a foreground service holds one
server-sent-events connection to Studio and shows a quiet "Approval alerts
on" notification, as Android requires for a service that keeps running.
Studio sends the list on connect and on each change, and a comment every 45
seconds (so proxies such as Cloudflare do not drop the idle connection). In
between, the radio sleeps. That costs about as much as a chat app. If the
connection drops, the app waits 2 s, 4 s, … up to 5 minutes before it tries
again.

Why this and not the others:

- **Google FCM** is not used (no Google services, no cloud relay).
- **WorkManager alone** cannot check more often than every 15 minutes, which
  is too slow for an agent waiting on you. It is the **Battery saver** mode.
- **UnifiedPush / ntfy** would save the one connection when you already run
  ntfy, but it needs a second server and app. Not built; a possible follow-up.

**Battery saver**: no service, no ongoing notification. Android runs a check
every 15 minutes when there is a network (it may wait longer in Doze).

**Off**: no notifications on this phone; the key stays.

Android's Doze can still pause the Live connection when the phone lies still
for a long time. Settings → Android app (inside the app) offers **Open battery
settings** to let Studio Own run without battery limits.

## What the watcher logs

An answer from the phone or a Mattermost button adds an alert of the kind
"Answered on phone or in Mattermost" (on by default in Settings → Watcher):
"Approved on phone (Pixel 8): npm publish". Agent work also logs "approved
on phone (Pixel 8)" in its activity, and its `decidedVia` is `phone`.

## What goes wrong

- **No notifications**: check Settings → Watcher → Where approvals reach you
  says Android app or Both, the kind is ticked, the phone is listed under
  Settings → Android app as "Connected now", and notifications are allowed
  for Studio Own in Android.
- **"This phone is not paired any more"**: it was removed in Studio. Pair it
  again.
- **The QR code does nothing**: the camera app must open `studio-own://`
  links; type the code in the app instead.
- **Mattermost posts without buttons**: set "Studio address for Mattermost
  buttons" in Connections → Agent work, and allow Studio's address under
  Mattermost's System Console → Developer → Allow untrusted internal
  connections.
- **Chat approvals answered from the phone after a restart**: questions asked
  before Studio restarted are not on the phone; answer them in Studio.

## Where things live

- Shared types: `packages/shared/approval-alerts.ts`.
- Server: `modules/studio/services/approval-alerts/` (`settings.ts`: choices,
  phone keys, pairing codes; `service.ts`: the list, answers, streams,
  Mattermost posts; `scope.ts`: what a phone key may do), API
  `routes/approval-alerts.ts`, wiring `bootstrap/approval-alerts.ts`. Sources:
  Agent work (`agent-work/index.ts`), the chat-run stream
  (`sockets/chat-run.ts`), the phone tools (`android/phone-agent.ts`), the
  watcher's Blocked alerts (`bootstrap/watcher.ts`). Mattermost buttons reach
  Agent work's one action route (`agent-work/service.ts`, `alert_id`).
- Client: `components/hermes/settings/ApprovalAlertsSettings.vue`,
  `AndroidAppSettings.vue`, `api/studio/approval-alerts.ts`, strings in
  `i18n/approval-alerts-messages.ts`.
- App: `ApprovalAlerts.kt` (list, stream parser, notification plan, pairing),
  `ApprovalAlertClient.kt` (HTTP), `ApprovalAlertService.kt` (Live service,
  Battery saver worker, mode control, boot and button receivers),
  `ApprovalNotifier.kt`, `ApprovalAlertStore.kt`, `MainActivity.kt` (pairing
  link, confirmation, page bridge `window.StudioOwn.approvalAlerts`).

## Tests

- `tests/server/approval-alerts.test.ts`: the key's scope and sign-in,
  pairing, routing for Mattermost / Android app / both / off, the stream's
  content, answer once with "Already … on phone", chat approvals, phone
  questions, Mattermost buttons, Blocked alerts.
- `tests/e2e/approval-alerts.spec.ts`: the Settings choice and the pairing
  screen.
- `packages/android/app/src/test/…/ApprovalAlertsTest.kt` and
  `ApprovalAlertClientTest.kt` (with a local HTTP server standing in for
  Studio), plus pairing links in `LinkRouteTest.kt` and the page bridge in
  `BridgeTest.kt`.

What was not built here: the APK (no Android SDK in this environment). The
Kotlin files that need Android (the service, notifications, receivers,
`MainActivity`) were not compiled; the pure files and their tests were
compiled with the real Kotlin compiler and run with JUnit. Real phones and
Doze behaviour were not tried.
