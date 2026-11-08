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

## Connecting to an emulator anywhere

Studio talks to every device through adb, and adb works over the network, so
where the emulator runs does not matter. There are three ways in:

1. **Same machine as the Studio server** (the desktop app's own computer):
   nothing to do. adb finds local emulators and BlueStacks by itself, and
   Studio reads BlueStacks' config to name and connect its instances.
2. **A device that listens on the network** (a phone with wireless debugging,
   an emulator container such as docker-android): **Connect over the network**
   with its `host:port`. Studio remembers it and reconnects it automatically.
3. **Everything on another computer** (BlueStacks, Android Studio emulators,
   USB phones on your gaming PC): run an adb server there and point Studio at
   it under **Connection settings → Use devices from another computer**:

   ```bash
   adb kill-server
   adb -a -P 5037 nodaemon server
   ```

   Enter that computer's `address:5037`. Studio then sees exactly what that
   computer's adb sees, including BlueStacks without enabling anything but
   BlueStacks' own ADB switch. Keep the terminal open (or run it as a service),
   allow port 5037 through that computer's firewall, use the same adb version
   on both sides (Docker image and platform-tools are both recent), and only do
   this on a trusted network: anyone who can reach port 5037 controls those
   devices. With a remote adb server, the emulator's fast stream is not
   reachable, so screens arrive as screenshots, and **Start** for emulators is
   hidden: start them on that computer.

### Which emulator to use

For developing and testing your own apps, the **Android Studio emulator
(AVD)** is the better choice: current Android versions with Google APIs, a
real `adb shell`, snapshots, and on the Studio machine the fast live stream.
**BlueStacks** works (it is a full Android with ADB) but runs an older Android
build tuned for games and gets the slower screenshot view. On Unraid, an AVD in
a container with `/dev/kvm` (for example docker-android) gives you an emulator
that is always on.

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

- **Studio desktop app on the same PC:** nothing to type. Studio reads
  BlueStacks' own `bluestacks.conf` (Windows `%ProgramData%\BlueStacks_nxt`,
  macOS `/Users/Shared/Library/Application Support/BlueStacks`), shows each
  instance under **BlueStacks on this PC**, and connects to the running ones.
  They appear in the device list under their BlueStacks name. Turn this off with
  **Find BlueStacks on this PC automatically**.
- **Studio on Unraid:** BlueStacks only accepts adb connections from the PC
  itself. The simplest route is an adb server on the PC (see *Connecting to an
  emulator anywhere*, option 3). Alternatively, forward a port to BlueStacks
  from an administrator terminal on Windows, then connect Studio to
  `<PC address>:15555`:

  ```bat
  netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=15555 connectaddress=127.0.0.1 connectport=5555
  netsh advfirewall firewall add rule name="BlueStacks ADB" dir=in action=allow protocol=TCP localport=15555
  ```

  Only do this on a trusted network: anyone who can reach that port controls
  BlueStacks.

## Remembered devices

Every device you connect over the network (a phone, BlueStacks on another PC,
an emulator container) is remembered in `<Studio state dir>/android/settings.json`
(`autoConnect`). Whenever the Android page refreshes, Studio checks which of
them answer and reconnects those, so a BlueStacks you start later, or a phone
that comes home, shows up on its own. **Disconnect** or **Forget** removes one.
A phone on wireless debugging gets a new port each time debugging restarts, so
connect it again then.

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
