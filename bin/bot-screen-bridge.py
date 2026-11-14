#!/usr/bin/env python3
"""Studio's side of Hermes's Bot Screen, run with Hermes's own Python.

Studio does not reimplement the screen's control rules: it uses Hermes's
``tools.bot_desktop`` (the lease shared by the agent's computer_use and browser
tools, and the RFB input filter), so the agent and Studio always agree on who
drives the screen.

  bot-screen-bridge.py lease get|take|release|force [viewer_id] [reason]
      Prints the lease as JSON (``lease.public_view``).
  bot-screen-bridge.py browser
      Makes sure the screen's browser (Hermes's own: same Chrome, same
      profile and logins as the agent's browser tools) runs on the screen and
      prints {"port": <DevTools port>}. Exit 42: a person holds control.
  bot-screen-bridge.py bridge <viewer_id>
      Pipes the screen's RFB stream: stdin (from the viewer) -> filter -> Xvnc,
      Xvnc -> stdout. Keyboard, mouse, clipboard and resizes only pass while
      this viewer holds the lease. Exit 40: another person took control from
      this viewer. Exit 41: the screen is not running.

The profile's HERMES_HOME comes from STUDIO_SCREEN_HOME (or HERMES_HOME).
"""

from __future__ import annotations

import json
import os
import select
import socket
import sys
import time
from pathlib import Path

LEASE_REFRESH_S = 0.25
ACTIVITY_STAMP_S = 60.0
CHUNK = 64 * 1024
EXIT_CONTROL_TAKEN = 40
EXIT_SCREEN_GONE = 41


def _home() -> str:
    home = os.environ.get("STUDIO_SCREEN_HOME") or os.environ.get("HERMES_HOME")
    if not home:
        home = str(Path.home() / ".hermes")
    return home


def _lease_cmd(argv: list[str]) -> int:
    from tools.bot_desktop import lease

    home = _home()
    action = argv[0] if argv else "get"
    viewer = argv[1] if len(argv) > 1 and argv[1] else None
    reason = argv[2] if len(argv) > 2 else ""
    if action == "take":
        if not viewer:
            print(json.dumps({"error": "viewer id required"}))
            return 2
        current = lease.acquire(viewer, profile_key=home, reason=reason)
    elif action == "release":
        current = lease.release(viewer, profile_key=home)
    elif action == "force":
        current = lease.release(None, profile_key=home)
    else:
        current = lease.get(profile_key=home)
    print(json.dumps(lease.public_view(current)))
    return 0


def _cdp_port(profile: str):
    """DevTools port of a Chrome running on ``profile`` (Chrome writes it to DevToolsActivePort; the
    file outlives a closed Chrome, so the owner pid must be alive and the port must answer)."""
    try:
        with open(os.path.join(profile, "DevToolsActivePort"), encoding="utf-8") as fh:
            port_line = fh.readline().strip()
        target = os.readlink(os.path.join(profile, "SingletonLock"))
    except OSError:
        return None
    pid_text = target.rpartition("-")[2]
    if not (port_line.isdigit() and pid_text.isdigit()):
        return None
    try:
        os.kill(int(pid_text), 0)
    except OSError:
        return None
    try:
        with socket.create_connection(("127.0.0.1", int(port_line)), timeout=0.5):
            pass
    except OSError:
        return None
    return int(port_line)


def _browser_cmd() -> int:
    os.environ["HERMES_HOME"] = _home()
    from tools.bot_desktop import browser, lease, runtime

    if lease.human_holds(profile_key=_home()):
        print(json.dumps({"error": "A person has taken over the screen; wait until they hand it back."}))
        return 42
    launch = browser.dock_launch()
    if not launch:
        print(json.dumps({"error": "No Chromium for the screen"}))
        return 3
    exe, profile = launch
    port = _cdp_port(profile)
    if port is None:
        env = runtime.desktop_env()
        if not env.get("DISPLAY"):
            print(json.dumps({"error": "The screen is not running"}))
            return EXIT_SCREEN_GONE
        Path(profile).mkdir(parents=True, exist_ok=True)
        import subprocess
        subprocess.Popen(browser.dock_argv(exe, profile), env=env, stdin=subprocess.DEVNULL,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        deadline = time.monotonic() + 20
        while port is None and time.monotonic() < deadline:
            time.sleep(0.25)
            port = _cdp_port(profile)
        if port is None:
            print(json.dumps({"error": "The screen's browser did not start"}))
            return 3
    if hasattr(runtime, "touch_activity"):
        runtime.touch_activity()
    print(json.dumps({"port": port, "profile": profile}))
    return 0


def _write_all(fd: int, data: bytes) -> None:
    view = memoryview(data)
    while view:
        written = os.write(fd, view)
        view = view[written:]


def _bridge(viewer: str) -> int:
    from tools.bot_desktop import lease
    from tools.bot_desktop.rfb_filter import RfbClientFilter

    home = _home()
    sock_path = Path(home) / "bot-desktop" / "rfb.sock"
    activity = Path(home) / "bot-desktop" / "activity"
    try:
        rfb = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        rfb.connect(str(sock_path))
    except OSError as exc:
        sys.stderr.write(f"screen not reachable: {exc}\n")
        return EXIT_SCREEN_GONE

    state = {"allowed": lease.viewer_may_send_input(viewer, profile_key=home), "at": time.monotonic()}
    held = {"ever": state["allowed"]}

    def refresh() -> None:
        current = lease.get(profile_key=home)
        state["allowed"] = current.holder == lease.HUMAN and current.viewer_id == viewer
        state["at"] = time.monotonic()
        if current.holder != lease.HUMAN:
            held["ever"] = False
        elif current.viewer_id == viewer:
            held["ever"] = True
        elif held["ever"]:
            # Someone else took control from this viewer: its page drops to watching.
            raise SystemExit(EXIT_CONTROL_TAKEN)

    def may_send_input() -> bool:
        if time.monotonic() - state["at"] > LEASE_REFRESH_S:
            refresh()
        return state["allowed"]

    gate = RfbClientFilter(may_send_input)
    stdin_fd = sys.stdin.fileno()
    stdout_fd = sys.stdout.fileno()
    stamped = 0.0
    try:
        while True:
            ready, _, _ = select.select([stdin_fd, rfb], [], [], 0.5)
            if time.monotonic() - state["at"] > 0.5:
                refresh()
            if rfb in ready:
                chunk = rfb.recv(CHUNK)
                if not chunk:
                    return EXIT_SCREEN_GONE
                _write_all(stdout_fd, chunk)
                if time.monotonic() - stamped > ACTIVITY_STAMP_S:
                    stamped = time.monotonic()
                    try:
                        activity.touch()
                    except OSError:
                        pass
            if stdin_fd in ready:
                chunk = os.read(stdin_fd, CHUNK)
                if not chunk:
                    return 0
                try:
                    allowed = gate.feed(chunk)
                except ValueError as exc:
                    sys.stderr.write(f"bad RFB from viewer: {exc}\n")
                    return 3
                if allowed:
                    rfb.sendall(allowed)
    except (BrokenPipeError, ConnectionError):
        return 0
    finally:
        try:
            rfb.close()
        except OSError:
            pass


def main() -> int:
    if len(sys.argv) < 2:
        sys.stderr.write(__doc__ or "")
        return 2
    command, rest = sys.argv[1], sys.argv[2:]
    if command == "lease":
        return _lease_cmd(rest)
    if command == "browser":
        return _browser_cmd()
    if command == "bridge" and rest:
        return _bridge(rest[0])
    sys.stderr.write(__doc__ or "")
    return 2


if __name__ == "__main__":
    sys.exit(main())
