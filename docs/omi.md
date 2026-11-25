# Omi and Studio Own on the phone

The Studio Own Android app (`packages/android`, package `com.ekkostudio.own`) and
the Omi app talk to each other with plain Android intents. Nothing goes through a
server, and nothing is sent or run without the person on the phone pressing a button:

- **Omi → Studio:** text arrives in the composer of a new Studio chat. The person
  reads it and presses Send.
- **Studio → Omi:** Studio Own opens Omi on a screen. Omi does the rest.
- **Phone AI:** Studio Own starts and stops the phone's own model servers in Termux,
  and each command is confirmed on the phone like every other Termux command.

On the servers, Omi and Hermes are already connected (MCP and "Send to agent"); that
is configured on the Omi side and not covered here.

## Omi → Studio Own

Studio Own accepts three intents. All of them end in the same place: Studio's
new-chat page, with the text in the composer, unsent.

| Intent | Example | Notes |
| --- | --- | --- |
| `ACTION_SEND`, type `text/plain`, `EXTRA_TEXT` (optional `EXTRA_SUBJECT`) | Omi's share sheet → **Send to Studio** | A subject that is not already in the text is put above it, followed by an empty line. |
| `ACTION_VIEW` `ekkostudio-own://chat?text=<percent-encoded text>` | `ekkostudio-own://chat?text=Summarise%20this%20call` | `BROWSABLE`, so it also works from a link. Form encoding: `+` is a space; encode a literal `+` as `%2B`. Without `text`, an empty new chat opens. |
| `ACTION_VIEW` `ekkostudio-own://omi` | the app shortcut "Omi" | Opens Studio Own's Omi and phone AI panel. |

- Text is trimmed and limited to **20,000 characters**; longer text is cut and the
  app says so.
- Studio Own is a single-task activity: a share while it is open replaces the page
  with the new chat (unsent drafts of other chats stay saved).
- If the app has no server configured yet, the text waits until the person connects.
- Reopening the app from Recents does not repeat a share.

From Omi (Flutter), either of these works:

```dart
// Share sheet (share_plus 11): Studio Own appears as "Send to Studio".
SharePlus.instance.share(ShareParams(text: text, subject: title));

// Straight to Studio Own (url_launcher). Encode the text.
launchUrl(Uri(scheme: 'ekkostudio-own', host: 'chat', queryParameters: {'text': text}),
    mode: LaunchMode.externalApplication);
```

To check whether Studio Own is installed, Omi's manifest needs
`<queries><package android:name="com.ekkostudio.own" /></queries>`.

### How the text reaches the web page

Studio Own loads `<server>/#/hermes/chat?compose=<percent-encoded text>` in its
WebView, where `<server>` is the address configured in the app. Only that origin
ever gets the text, and because it is in the URL fragment it is not sent to the
server in the request. The Studio client
(`packages/client/src/utils/compose-link.ts`, `ChatPanel.vue`) removes the
`compose` query from the address, opens the new-chat page and puts the text in its
composer. The same link works in a browser.

## Studio Own → Omi

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

## Phone AI

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
