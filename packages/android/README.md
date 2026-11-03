# Studio Own (Android)

A self-built Android client for your own Ekko Studio server: it does not use
the official app, its accounts or its cloud relay. It talks to the server you
point it at (for example a Cloudflare tunnel URL) using the normal Studio login.

Roadmap: notifications (no Firebase), calendar/reminders, tasks and Kanban,
home-screen widgets, Termux integration.

Build: GitHub Actions workflow `Android APK` (see `.github/workflows/android-apk.yml`)
builds a debug APK on every change under `packages/android/`; download it from the
run's artifacts and sideload it, or drag it into BlueStacks / an Android Studio emulator.
