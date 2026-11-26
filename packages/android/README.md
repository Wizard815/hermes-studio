# Studio Own (Android)

A self-built Android client for your own Ekko Studio server: it does not use
the official app, its accounts or its cloud relay. It talks to the server you
point it at (for example a Cloudflare tunnel URL) using the normal Studio login.

What it adds on top of the web console:

- **Termux:** Studio's Android page shows *This phone*, which runs commands in
  Termux after you confirm each one on the phone. Termux needs
  `allow-external-apps = true` in `~/.termux/termux.properties`.
- **Install what you build:** downloading an `.apk` from your Studio server
  installs it through Android's installer.

Only pages from the server address you configured get these abilities (WebView
origin rules); see [docs/android-devices.md](../../docs/android-devices.md).

- **Share to Studio:** share text, links or images from any app into a new
  Studio chat or the open one; links to your server and `studio-own://chat/<id>`
  open in the app (see [docs/android-devices.md](../../docs/android-devices.md#share-to-studio-and-links)).

- **Approval alerts:** pair the app in Studio (Settings → Android app) and
  approvals arrive as notifications with Approve / Reject, over a stream from
  your own server (no Firebase). Live or Battery saver; see
  [docs/approval-alerts.md](../../docs/approval-alerts.md).

## Omi

The app works with the Omi app on the same
phone. The intent contract both ways is in [docs/omi.md](../../docs/omi.md).

- **From Omi:** share from Omi like from any app (above), or use the link
  `ekkostudio-own://chat?text=...`, which opens a new chat with the text in the
  composer; you press Send.
- **Open Omi:** the Android page's *This phone* card has **Omi and phone AI**
  (or long-press the app icon → **Omi**). It opens Omi on its approvals
  (`omi://approvals`), tasks (`omi://tasks`) or capture (`omi://capture`) screen,
  or Omi's main screen while Omi does not handle those links yet.
- **Phone AI:** the same panel starts (`~/bin/omi-phone-ai.sh`) and stops the
  phone's own model and speech-to-text servers from Omi's phone AI guide
  (`omi-host/PHONE-LLM.md` in the Omi repository) in Termux, after you confirm the
  command, and shows whether `127.0.0.1:8081` (chat) and `127.0.0.1:8080`
  (speech-to-text) answer. Termux needs `allow-external-apps = true`; the panel
  shows the steps when it is missing.

Roadmap: calendar/reminders, tasks and Kanban, home-screen widgets.

Build: GitHub Actions workflow `Android APK` (see `.github/workflows/android-apk.yml`)
builds a debug APK on every change under `packages/android/`; download it from the
run's artifacts and sideload it, or drag it into BlueStacks / an Android Studio emulator.

Locally, with the Android SDK in `ANDROID_HOME`:

```bash
gradle --no-daemon :app:testDebugUnitTest :app:assembleDebug
```
