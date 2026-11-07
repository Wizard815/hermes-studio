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

Roadmap: notifications (no Firebase), calendar/reminders, tasks and Kanban,
home-screen widgets.

Build: GitHub Actions workflow `Android APK` (see `.github/workflows/android-apk.yml`)
builds a debug APK on every change under `packages/android/`; download it from the
run's artifacts and sideload it, or drag it into BlueStacks / an Android Studio emulator.

Locally, with the Android SDK in `ANDROID_HOME`:

```bash
gradle --no-daemon :app:testDebugUnitTest :app:assembleDebug
```
