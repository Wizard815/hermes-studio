# Phone test checklist: Studio Own and Omi

For the APKs in this folder. Tick each box as you go. When something fails, write
what you saw next to it and save a log (see **Logs** at the end). Steps marked
**(adb)** need the phone plugged into a computer with USB debugging on. Everything
else is done on the phone alone.

Studio Own has no home-screen widgets yet (they're on its roadmap), so there's no
widget section. Omi's own widgets weren't part of these changes.

## 0. Before you start

- [ ] A phone with Android 8.0 or newer for Studio Own. It must be **arm64** for Omi,
      which almost every phone from 2017 on is. Android 13+ is best, because it also
      tests the notification permission prompt.
- [ ] Studio is running from the `studio-herder` branch, with the `apk-builds` fixes
      merged, and the phone can reach it (LAN address or tunnel URL).
- [ ] omi-local's stack is running, with `omi-fixes.patch` applied, and you have its
      username and password.
- [ ] You're a super admin in Studio. Pairing and approval settings need that.
- [ ] Uninstall older builds of either app if they were signed with a different key.
      Otherwise Android refuses the update ("App not installed").
- [ ] Install both apps: copy the APKs to the phone and open them (allow "Install
      unknown apps" for your file manager), or **(adb)**:
      ```bash
      adb install -r apk-builds/studio-own-debug.apk
      adb install -r apk-builds/omi-dev-release.apk
      ```
- [ ] **(adb, optional)** Start a log before testing:
      `adb logcat -c && adb logcat > phone-test.log`

## 1. Studio Own: first start and the web app

- [ ] The app opens and asks for the server URL. A wrong URL gives an error, not a crash.
- [ ] With the right URL, Studio's login shows. You can log in and the chat list loads.
- [ ] Open a chat, send a message and get a reply. Rotate the phone: the page survives.
- [ ] Close the app with Back and reopen it: it goes straight to Studio, without asking
      for the URL again.
- [ ] Turn on airplane mode, reopen the app, then turn airplane mode off: it recovers
      without reinstalling.

## 2. Studio Own: pairing for approval alerts

In Studio (on a computer): **Settings → Watcher → Where approvals reach you**

- [ ] Set **Send approvals to** to **Android app** (or **Both**), and tick **Agent work**,
      **Chat approvals**, **Phone actions** and **Blocked alerts**.

Pair with a QR code:

- [ ] **Settings → Android app → Pair this phone → Make a pairing code**. A QR code
      and an `ABCD-EFGH` code appear.
- [ ] Scan the QR code with the phone's camera. Studio Own opens and asks "Turn on
      approval alerts?".
- [ ] Say yes. On Android 13+, Android asks to allow notifications: **Allow**.
- [ ] A quiet "Approval alerts on" notification appears. This is the Live service.
- [ ] In Studio, the phone is listed under Settings → Android app as **Connected now**.

Or pair inside the app (do this on a second run, after **Remove**):

- [ ] In Studio Own: **Settings → Android app → Pair this phone** pairs with no code.
- [ ] Typing a code you made on the computer also works.
- [ ] A wrong code says "This code is wrong or has expired."

Then:

- [ ] **Send a test notification** in Studio: it arrives on the phone within a few seconds.
- [ ] If you denied notifications: Settings → Android app says "Notifications are off
      for Studio Own".

## 3. Studio Own: approvals from the phone

Make an agent ask for approval. For example, start a coding-agent chat without
`/yolo` and ask it to run a harmless command such as `ls`.

- [ ] A notification arrives with a title like "Claude Code asks to run a command in
      <chat>", the command, and **Approve** / **Reject**.
- [ ] **Approve** from the notification. The agent continues in Studio, and the
      notification shows Studio's reply for about a minute.
- [ ] Do it again and press **Reject**. The agent stops or is told no.
- [ ] Tap the notification body (not a button): the app opens on that chat.
- [ ] **Answered elsewhere:** trigger one more, answer it in Studio on the computer.
      The phone's notification goes away by itself.
- [ ] **First answer wins:** trigger one, approve it in Studio, then quickly press
      Approve on the phone. The phone says "Already approved in Studio by <you>."
- [ ] **Risky command:** ask the agent to run something like `rm -rf ./tmp-test` (in a
      throwaway folder). The notification button opens the app instead, which shows the
      whole command, asks again and offers **Open chat**.
- [ ] **Agent work** (Connections → Agent work) items arrive and can be answered.
- [ ] **Blocked alerts** (for example, a run limit) arrive as notifications without buttons.
- [ ] In Studio, the watcher shows "Approved on phone (<phone name>): …".

## 4. Studio Own: staying connected (calling home)

- [ ] Lock the phone for 10 minutes, then trigger an approval. The notification arrives
      within seconds.
- [ ] Switch Wi-Fi to mobile data and back. Alerts keep arriving (the app retries after
      2 s, 4 s, … up to 5 minutes).
- [ ] Stop Studio for 2 minutes and start it again. Alerts resume without touching the phone.
- [ ] Reboot the phone and don't open the app. The "Approval alerts on" notification
      comes back and alerts arrive.
- [ ] **Battery saver mode** (in the app's Settings → Android app): the ongoing
      notification disappears. An approval arrives within about 15 minutes.
- [ ] **Off:** no notifications at all. Switching back to **Live** brings them back
      without pairing again.
- [ ] **Remove** the phone in Studio. The app says "This phone is not paired any more"
      and stops alerting.
- [ ] **Open battery settings** (in the app) opens Android's battery page for
      Studio Own. Set it to Unrestricted for the next step.

**Doze (adb).** This simulates a phone left on a desk overnight:

```bash
adb shell dumpsys battery unplug
adb shell dumpsys deviceidle force-idle
# trigger an approval in Studio now, and note whether and when it arrives
adb shell dumpsys deviceidle unforce
adb shell dumpsys battery reset
```

- [ ] With Unrestricted battery: does the alert arrive while idle?
- [ ] With the default (Optimized) battery: does it arrive, and how late?
- [ ] Real use: leave the phone overnight, trigger an approval in the morning before
      touching it, and note the delay. Some phone makers (Samsung, Xiaomi, OnePlus) kill
      background apps harder. Write down the phone model.

## 5. Studio Own: phone and other apps

**Share to Studio**

- [ ] Share a link from Chrome → **Studio**. The app asks **New chat** or **Current chat**,
      and the link waits in the input. Nothing is sent until you press Send.
- [ ] Share 1–4 photos from the gallery: they wait in the input as images.
- [ ] Share 5 photos, or one bigger than 8 MB, or a PDF: the extra ones are left out and
      the app says so.
- [ ] Share text from Omi (or any notes app) into Studio.
- [ ] Clear the app's data, then share something: it asks for the server first, then
      offers the share.

**Links**

- [ ] **(adb)** `adb shell am start -a android.intent.action.VIEW -d "studio-own://chat/<a chat id>"`
      opens that chat.
- [ ] `studio-own://open?url=<a page on your server>` opens the page. The same with
      another site's URL is ignored.
- [ ] Tapping a normal link to another site inside Studio opens the browser, not the app.
- [ ] (Only if you rebuilt with `-PstudioOwnHost=<your host>` and set
      `STUDIO_OWN_ANDROID_CERT_SHA256`) An `https://<your host>/…` link in another app
      opens in Studio Own.

**Termux and installs**

- [ ] Install Termux from F-Droid, then run in Termux:
      `mkdir -p ~/.termux && echo "allow-external-apps = true" >> ~/.termux/termux.properties && termux-reload-settings`
- [ ] Studio's Android page → **This phone** → run `uname -a`. Android asks once for
      permission, the app shows the command and asks, and the output returns to the page.
- [ ] **Open in Termux** opens a Termux session.
- [ ] Download an `.apk` from Studio's Files: the app asks, then Android's installer opens.
      The first time, it asks to allow installs from Studio Own.

## 6. Omi

- [ ] The app opens. Sign in with the server URL (`http://<server-ip>:8000/` or a tunnel)
      and the seeded username and password.
- [ ] Conversations and memories load. Record a short phone-mic memo and check it
      transcribes. This shows the app and backend basics work.
- [ ] **Settings → Connections → Studio**: enter the Studio key, turn it on and press
      **Test connection**. It succeeds.

**Studio approvals in Omi**

- [ ] From Omi, send something to a Studio agent so a Studio chat is started from Omi.
      Make it need approval.
- [ ] Omi → **Approvals** → pull to refresh. The card shows under "Agents asking before
      they go on", with "Studio", the agent, the title, "Studio asks before it goes on",
      and **Approve** / **Decline**.
- [ ] **Approve**. In Studio it shows as answered by "<your first name> (Omi)" and the
      agent continues.
- [ ] Another one: **Decline** works the same way.
- [ ] Answer one in Studio first, then press a button in Omi. The card replaces its
      buttons with "Already approved in Studio by …" and **stays full width**. That's the
      fix in `omi-fixes.patch`.
- [ ] A household member signed in to Omi sees only the chats they started.

**Omi, Studio Own and Studio together**

- [ ] Trigger one approval that reaches both Omi and Studio Own. Approve it in Omi:
      the Studio Own notification goes away. Do it the other way round as well.

## 7. Logs and what to send back

**(adb)** Stop the `logcat` started in step 0 (Ctrl-C). Or grab the last part only:

```bash
adb logcat -d > phone-test.log
adb logcat -d -b crash > phone-crash.log
```

Send back:

- the phone model and Android version
- each step that failed, and what you saw
- `phone-test.log` / `phone-crash.log` if anything crashed
- the delays from section 4 (locked, Doze, overnight)
