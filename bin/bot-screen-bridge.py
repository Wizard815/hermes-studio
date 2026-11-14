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
  bot-screen-bridge.py vault list | add | rm <id> | fill <id> <port> [tab]
      Hermes's encrypted login vault. ``add`` reads the item as JSON on stdin
      (never argv). ``fill`` writes a saved login's password into the screen
      browser's page (DevTools port, optional tab target id) with Hermes's own
      login-form classifier and origin-checked fill script: only on the exact
      site the login was saved for, and the password never leaves this
      process (the result carries counts only).
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


def _cdp_eval(ws, expression: str, ids: list) -> dict:
    ids[0] += 1
    ws.send(json.dumps({"id": ids[0], "method": "Runtime.evaluate",
                        "params": {"expression": expression, "returnByValue": True, "awaitPromise": True}}))
    while True:
        message = json.loads(ws.recv(timeout=20))
        if message.get("id") == ids[0]:
            break
    result = (message.get("result") or {})
    if message.get("error") or result.get("exceptionDetails"):
        return {"success": False, "error": "page script failed"}
    return {"success": True, "result": (result.get("result") or {}).get("value")}


def _page_target(port: int, tab: str):
    import urllib.request
    with urllib.request.urlopen(f"http://127.0.0.1:{port}/json/list", timeout=5) as response:
        targets = [item for item in json.load(response) if item.get("type") == "page"]
    if tab:
        targets = [item for item in targets if item.get("id") == tab]
    return targets[0] if targets else None


def _vault_fill(handle: str, port: int, tab: str) -> dict:
    import secrets as _secrets
    from agent.vault_backends import backend_for_handle
    from agent.vault_login_classifier import (LoginControl, build_fill_js, build_inspection_js, classify_checkout_control,
                                              classify_login_control, select_checkout_fills, select_password_fill)
    from agent.vault_store import ADDRESS_FIELDS, PAYMENT_FIELDS, normalize_origin, scrub_secret_from_text
    from websockets.sync.client import connect

    backend = backend_for_handle(handle)
    meta = backend.get_meta(handle) if backend is not None else None
    if meta is None:
        return {"success": False, "error": f"No saved login {handle!r}."}
    if meta.kind not in ("login", "payment", "address"):
        return {"success": False, "error": f"Saved {meta.kind} items cannot be filled."}
    # Logins only on their own site; cards and addresses on their site when one was saved.
    allowed = {normalize_origin(origin) for origin in (meta.allowed_origins or (meta.origin,)) if origin}
    target = _page_target(port, tab)
    if not target:
        return {"success": False, "error": "No browser tab to fill."}
    ids = [0]
    with connect(target["webSocketDebuggerUrl"], max_size=8 * 1024 * 1024, open_timeout=10) as ws:
        origin = _cdp_eval(ws, "location.origin", ids)
        try:
            page_origin = normalize_origin(str(origin.get("result") or "")) if origin.get("success") else ""
        except Exception:
            page_origin = ""
        if meta.kind != "login" and not allowed and page_origin.startswith(("https://", "http://127.0.0.1", "http://localhost")):
            allowed = {page_origin}
        if page_origin not in allowed:
            return {"success": False, "error_type": "origin_mismatch",
                    "error": f"This login is saved for {', '.join(sorted(allowed))}, not {page_origin or 'this page'}. Nothing was filled."}
        nonce = _secrets.token_hex(8)
        inspect = _cdp_eval(ws, build_inspection_js(nonce), ids)
        raw = inspect.get("result")
        if isinstance(raw, str):
            try:
                raw = json.loads(raw)
            except ValueError:
                raw = None
        if not isinstance(raw, list):
            return {"success": False, "error": "Could not read the page's form fields."}
        classify = classify_login_control if meta.kind == "login" else classify_checkout_control
        classified = [item for item in (classify(LoginControl.from_dict(row)) for row in raw if isinstance(row, dict)) if item]
        if not classified:
            return {"success": False, "error": f"No {'login' if meta.kind == 'login' else meta.kind} form fields were found on this page."}
        secret = {"password": backend.resolve_password(handle)} if meta.kind == "login" else dict(backend.resolve_secret(handle))
        try:
            if meta.kind == "login":
                fills = select_password_fill(classified, secret["password"])
            else:
                fills = select_checkout_fills(classified, secret, PAYMENT_FIELDS if meta.kind == "payment" else ADDRESS_FIELDS)
            if not fills:
                return {"success": False, "error": f"No {'password' if meta.kind == 'login' else meta.kind} field matched on this page."}
            tokens = sorted(fill["token"] for fill in fills if "token" in fill)
            done = _cdp_eval(ws, build_fill_js(fills, expected_origin=page_origin, nonce=nonce), ids)
        except Exception as exc:  # never let the password reach the output
            return {"success": False, "error": scrub_secret_from_text(str(exc), secret)}
        finally:
            secret.clear()
    value = done.get("result")
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except ValueError:
            value = None
    if isinstance(value, dict) and value.get("refused"):
        return {"success": False, "error_type": "origin_changed", "error": "The page changed site before the fill; nothing was written."}
    filled = int(value.get("filled", 0)) if isinstance(value, dict) else 0
    if meta.kind != "login":
        return {"success": bool(filled), "filled_fields": filled, "origin": page_origin, "kind": meta.kind, "fields": tokens,
                "next": "Check the rest of the form, then submit only if the person asked you to complete this purchase."}
    return {"success": bool(filled), "filled_fields": filled, "origin": page_origin,
            "identifier": meta.identifier, "next": "Type the username yourself if it is empty, then submit."}


def _vault_cmd(argv: list[str]) -> int:
    os.environ["HERMES_HOME"] = _home()
    from agent.vault_store import VaultError, get_vault_store

    action = argv[0] if argv else "list"
    try:
        if action == "list":
            out = {"items": [item.to_dict() for item in get_vault_store().list_items()]}
        elif action == "add":
            data = json.loads(sys.stdin.read() or "{}")
            kind = str(data.get("kind") or "login")
            secret = {key: value for key, value in data.items() if key not in ("kind", "label", "origin")}
            meta = get_vault_store().add_item(kind, str(data.get("label") or ""), secret, data.get("origin") or None)
            out = {"item": meta.to_dict()}
        elif action == "rm" and len(argv) > 1:
            out = {"removed": get_vault_store().remove_item(argv[1])}
        elif action == "fill" and len(argv) > 2:
            out = _vault_fill(argv[1], int(argv[2]), argv[3] if len(argv) > 3 else "")
        else:
            out = {"error": "usage: vault list | add | rm <id> | fill <id> <port> [tab]"}
    except (VaultError, ValueError) as exc:
        out = {"error": str(exc)}
    print(json.dumps(out))
    return 0 if "error" not in out else 1


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
    if command == "vault":
        return _vault_cmd(rest)
    if command == "browser":
        return _browser_cmd()
    if command == "bridge" and rest:
        return _bridge(rest[0])
    sys.stderr.write(__doc__ or "")
    return 2


if __name__ == "__main__":
    sys.exit(main())
