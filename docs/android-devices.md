# Android devices in Studio

The **Android** page (phone icon in the navigation rail, super admins only)
shows a live Android screen next to your chats and lets you use it: tap, swipe,
scroll, type, press Back/Home/Apps/volume/power, rotate, install an APK and open
it. It works the same in the web console, the desktop app and the Studio Own
Android app, because everything goes through Studio's own connection: no extra
ports, and it works through a Cloudflare tunnel.

Everything runs through `adb` on the machine that hosts the Studio **server**.
On Unraid or Docker that is the container; with the desktop app it is your
computer.

| Device | How Studio reaches it | Screen |
| --- | --- | --- |
| Android Studio emulator on the Studio machine | started from the page (headless) | live stream from the emulator, about 30 fps |
| Emulator in another container or machine | `adb connect host:5555` | screenshots, a few fps |
| Phone over Wi-Fi (Android 11+) | pair once, then connect | screenshots |
| Phone over USB | plug it in, allow debugging | screenshots |
| BlueStacks | `adb connect` to its ADB port | screenshots |

The live stream uses the emulator's own gRPC screen stream; it is adapted from
[herdr-sim](https://github.com/wobsoriano/herdr-sim) (MIT). Every other device
uses `adb exec-out screencap`, shrunk to a JPEG before it is sent.

## Unraid / Docker

The image includes `adb`, and `docker-compose.yml` keeps adb's key in
`hermes_data/android`, so devices stay authorized when the container is
recreated. Nothing else is needed for phones and BlueStacks: they are reached
over the network with `adb connect`.

**Phone over Wi-Fi (Android 11+).**
1. On the phone: Settings → About phone → tap *Build number* seven times.
2. Developer options → *Wireless debugging* → on.
3. *Pair device with pairing code*. In Studio, under **Pair a phone**, enter
   the address and 6-digit code the phone shows, then **Pair**.
4. Back on the *Wireless debugging* screen, enter the **IP address & port**
   shown there under **Connect over the network**.
The phone has to be on a network the Unraid server can reach. The connect port
changes when wireless debugging restarts; pairing does not need repeating.

**Phone over USB on Unraid.** Pass the USB bus to the container
(`--device /dev/bus/usb`, or the *Device* field in the Unraid template) and
allow debugging on the phone when it asks.

**Emulator on Unraid.** Run an emulator image as its own container with KVM
(`--device /dev/kvm`), for example
[docker-android](https://github.com/budtmo/docker-android), and connect to its
adb port (usually `5555`) from Studio. Its screen arrives as screenshots,
because the emulator's fast stream only listens inside that container.
Redroid needs the binder kernel module, which stock Unraid does not have.

## Desktop app on Linux (and Windows/macOS)

Install the Android SDK platform-tools and, for emulators, the emulator and a
system image (Android Studio's SDK Manager, or `sdkmanager`). Studio finds the
SDK in `ANDROID_HOME`, `ANDROID_SDK_ROOT`, `~/Android/Sdk` (Linux),
`~/Library/Android/sdk` (macOS) or `%LOCALAPPDATA%\Android\Sdk` (Windows); a
system `adb` on `PATH` (`apt install adb`) works too. Paths can also be set in
`<Studio state dir>/android/settings.json` (`adbPath`, `sdkPath`, `streamWidth`).

Your AVDs are listed under **Emulators**; **Start** boots one without a window
of its own and its screen appears in Studio with the live stream. On Linux the
emulator needs `/dev/kvm` (add yourself to the `kvm` group). Without a display
server Studio starts it with software rendering.

## BlueStacks

In BlueStacks: Settings → Advanced → turn on **Android Debug Bridge (ADB)**. It
shows an address such as `127.0.0.1:5555`.

- **Studio desktop app on the same PC:** connect to that address as shown.
- **Studio on Unraid:** BlueStacks only listens on the PC itself. On Windows,
  forward a port to it from an administrator terminal, then connect Studio to
  `<PC address>:15555`:

  ```bat
  netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=15555 connectaddress=127.0.0.1 connectport=5555
  netsh advfirewall firewall add rule name="BlueStacks ADB" dir=in action=allow protocol=TCP localport=15555
  ```

  Only do this on a trusted network: anyone who can reach that port controls
  BlueStacks.

## Installing what you build

- **On any connected device:** choose **Install APK…** under the screen. The
  file is uploaded to Studio, installed with `adb install -r -t`, and its
  package name is filled in so **Open app** starts it. Agents can do the same
  from Studio's terminal with `adb` directly.
- **On the phone running the Studio Own app:** download an `.apk` from Studio's
  Files. The app asks, downloads it from your server and hands it to Android's
  installer. The first time, Android asks you to allow installs from Studio.

Uploads are limited by `HERMES_MAX_UPLOAD_SIZE`.

## Termux on the phone (Studio Own app)

Inside the Studio Own app, the Android page shows **This phone**, which runs
commands in [Termux](https://termux.dev) on that phone:

1. Install Termux from F-Droid or GitHub (the Play Store build is outdated).
2. In Termux:
   ```bash
   mkdir -p ~/.termux && echo "allow-external-apps = true" >> ~/.termux/termux.properties
   termux-reload-settings
   ```
3. Run something from **This phone**. Android asks once to let Studio run
   Termux commands, and the app shows every command and asks before running it.

**Run in background** returns the output, error output and exit code to the
page. **Open in Termux** opens a Termux session instead.

Useful with it: `pkg install android-tools` gives the phone its own `adb`, so it
can install an APK onto itself over wireless debugging, and `pkg install git
nodejs python` lets you build and run small projects locally.

The bridge is offered only to pages from the server address you configured in
the app (WebView origin rules), never to other sites or embedded frames from
other origins.

## Limits

- Screens other than an emulator on the Studio machine are screenshots, a few
  frames per second. scrcpy-style video for phones is a possible follow-up.
- Pinch and multi-finger gestures are not supported; `input` only taps, swipes
  and long-presses.
- `input text` sends ASCII reliably; other characters depend on the device's
  keyboard.
- iOS simulators (the other half of herdr-sim) are not included: they need
  macOS and Xcode.
