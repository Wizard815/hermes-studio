# APK builds

Installable Android builds of **Studio Own** (this repo, `packages/android`) and
**Omi** (Wizard815/omi-local, `app/`), built and tested in a cloud Linux container
on 2026-11-25. No model or paid API calls were made.

| File | App | Package | Built from |
|---|---|---|---|
| `studio-own-debug.apk` | Studio Own 0.4.0 (versionCode 4), debug | `com.ekkostudio.own` | hermes-studio `studio-herder` @ `bd7407b` + the fix below |
| `omi-dev-release.apk` | Omi Dev 1.0.543 (versionCode 2992), dev flavor, release, arm64-only, obfuscated, 96.2 MiB | `com.friend.ios.dev` | omi-local `studio-herder` @ `0f6fc00caf` + `omi-fixes.patch` |
| `omi-fixes.patch` | the two Omi commits as a `git am` patch (the session could not push to omi-local) | | |
| `TEST-CHECKLIST.md` | step-by-step phone test for both apps (calling home, Doze, share, links, Termux, Omi approvals) | | |
| `screenshots/` | Omi's Approvals page with Studio approval cards, rendered by a Flutter widget test | | |

## Install

```bash
adb install -r apk-builds/studio-own-debug.apk
adb install -r apk-builds/omi-dev-release.apk
```

Or copy the file to the phone, open it and tap Install (allow "Install unknown
apps" for your file manager). Studio Own is signed with a throwaway debug key
and Omi Dev with omi-local's checked-in debug keystore. If you already have a
build signed with a different key, uninstall it first: Android refuses an
update with a different signature. Omi is **arm64 only**, so it won't install on
x86 emulators or BlueStacks x86 images. Studio Own has no native code and runs
anywhere with Android 8.0+ (minSdk 26).

Studio Own's link domain defaults to `studio-own.invalid`. To have links to your
server open in the app, rebuild with `-PstudioOwnHost=your.host`
(see `docs/android-devices.md`).

## How they were built

Toolchain: Ubuntu 24.04 x86_64 (4 cores, no KVM), Android SDK command-line tools 11076708,
platform-tools 37.0.3.

**Studio Own:** OpenJDK 17.0, Gradle 8.14.3 (the CI workflow uses 8.9; the project
has no wrapper), AGP 8.5.2, Kotlin 1.9.24, compileSdk/targetSdk 34, build-tools 34.0.0.

```bash
cd packages/android
gradle --no-daemon :app:testDebugUnitTest :app:assembleDebug :app:lintDebug
```

**Omi:** Flutter 3.44.5 stable (Dart in that SDK), OpenJDK 21.0, the project's Gradle
wrapper 8.14.2, AGP 8.11.1, Kotlin 2.2.20, compileSdk 36, NDK 28.2.13676358.
Before the build it needs the local, git-ignored files that `setup.sh android`
creates: `.dev.env` (`API_BASE_URL=http://127.0.0.1:8000/`), the local Firebase
options and `google-services.json`, and `android/key.properties` (debug keystore).
Then `dart run build_runner build` and `app/scripts/build_local_apk.sh` (with the
patch applied, which adds `--split-per-abi`). The output is
`build/app/outputs/flutter-apk/app-arm64-v8a-dev-release.apk`, copied here as `omi-dev-release.apk`.

Why `--split-per-abi`: without it the script gave a **152 MB** `app-dev-release.apk`,
over GitHub's 100 MB file limit. `--target-platform android-arm64` only limits the
Dart/Flutter libraries. Plugins still brought their x86_64 and armeabi-v7a native
libraries (onnxruntime and twilio, about 55 MB). So the "arm64-only" APK also
declared x86_64, and on an x86_64 device or emulator Android would pick that ABI
and then fail to find `libflutter.so`. The split build holds only `arm64-v8a`
(checked with `aapt2`). Flutter adds 2000 to its versionCode for arm64, so it
upgrades over an earlier 992 build. CI's emulator check builds its own x86_64 APK
without the script, so it isn't affected.
The server URL is entered in the app at sign-in, so the baked-in `127.0.0.1` default
doesn't matter.

## What was tested

**Studio Own**

- JVM unit tests: **32/32 pass** (Bridge 5, LinkRoute 4, ShareIntent 5,
  ApprovalAlerts 10, ApkInstaller 2, NormalizeUrl 2, ApprovalAlertClient 4).
- All the Android-only Kotlin that had never been built (foreground service,
  WorkManager worker, notifier, action/boot receivers, store, MainActivity
  changes, manifest, `work-runtime-ktx` 2.9.1) **compiled with no errors**.
- Android lint (`lintDebug`): **0 errors**, 21 warnings (RequiresFeature 7,
  SdCardPath 4, GradleDependency 4, ObsoleteSdkInt 2, SetTextI18n 2,
  PluralsCandidate 1, DataExtractionRules 1). None are in the new approval code.
- APK manifest checked with `aapt2`: `ApprovalAlertService` is a `specialUse`
  foreground service with its subtype property. The action and boot receivers are
  not exported. The permissions declared are POST_NOTIFICATIONS,
  FOREGROUND_SERVICE(_SPECIAL_USE), RECEIVE_BOOT_COMPLETED, WAKE_LOCK and
  ACCESS_NETWORK_STATE, and WorkManager's services are merged in.

**Omi**

- `flutter analyze` on the changed files (`api/connections.dart`,
  `schema/connections.dart`, `self_hosted_wire.g.dart`, `approvals_page.dart`,
  `agent_jobs_page.dart` and the connections tests): **no issues**.
- `flutter test test/pages/connections/`: **8/8 pass** (7 existing + 1 new).
- `flutter test test/pages/approvals/`, `test/providers/action_items_waiting_approval_test.dart`
  and `test/providers/task_delivery_test.dart`: **all pass** (34).
- `build_runner` regenerated nothing that differs from the committed `*.g.dart`
  (`self_hosted_wire.g.dart` matches the generator).
- A widget test rendered the real `ApprovalsPage`, with a fake server returning two
  Studio approvals, and tapped Decline on one that had already been answered in
  Studio. The results are in `screenshots/`. They use Roboto from the Flutter SDK
  because the app's own fonts aren't loaded in tests.

## What was not tested

- **No emulator or phone.** The container has no `/dev/kvm`, and the Android
  emulator won't run x86_64 images without it. The Omi APK is arm64-only anyway.
  So none of these were seen running: Studio Own's pairing and approval-alert
  settings, the live stream, the notifications with Approve / Reject, the
  WorkManager Battery saver fallback, boot restart, the share target and links.
  Omi wasn't launched either.
- Doze, battery optimisation, OEM background-kill behaviour and the Android 14
  `specialUse` foreground-service review: these need a real phone over hours.
- Notification permission prompts (Android 13+), and how notifications look and
  group on a device.
- The whole Omi test suite (only the changed and approval-related tests were run),
  and Omi against a real omi-local backend or Studio.

## Fixes made

**hermes-studio** (branch `apk-builds`):

- `fix(android): run ApprovalAlertClientTest against MockWebServer`.
  The test used the JDK's `com.sun.net.httpserver`, which isn't on the Android
  unit-test compile classpath, so the test source didn't compile. It now uses
  OkHttp's `mockwebserver` 4.12.0 (`testImplementation` only, not in the APK),
  with the same routes and assertions.

**omi-local** (`omi-fixes.patch`: two commits on a local `apk-fixes` branch from `studio-herder`):

- `App: keep a Studio approval card full width once someone else answered it`.
  The Approvals page lays its cards out in a start-aligned column. When Approve /
  Decline gave way to "Already approved in Studio by …", the card shrank to its
  text (it was visible in the first render). The card now takes the full width.
  The new widget test fails without the fix (466 px instead of 1200) and passes
  with it.
- `Build the local APK per ABI so it is really arm64-only`.
  `app/scripts/build_local_apk.sh` now passes `--split-per-abi` and checks for
  `app-arm64-v8a-dev-release.apk`. `OMI-LOCAL-SETUP.md` uses the new file name.
  The script was run again after the change and gave the same 96.2 MiB arm64-only APK.

  Apply both with: `cd omi-local && git checkout -b apk-fixes origin/studio-herder && git am /path/to/omi-fixes.patch`
