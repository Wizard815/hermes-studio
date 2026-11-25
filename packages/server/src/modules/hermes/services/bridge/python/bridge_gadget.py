"""Hermes Gadget tools in Studio's Hermes chats.

The Gadget plugin's ``gadget_*`` tools talk to devices through the hub inside the Hermes
gateway process. Studio's Hermes chats run in the bridge, another process, so every
call answered "gadget hub is not running in this process". The plugin already has a way
for other processes to reach a device: its Desktop page writes a request to
``<plugin data>/desk/inbox/<id>.json`` and the running gateway carries it to the device
and writes the outcome to ``desk/done/<id>.json``. When a gadget tool fails that way in
the bridge, the bridge sends the same request:

- ``gadget_devices``: read from ``devices.json`` and the gateway's ``status.json``;
- ``gadget_display``: a card (title and text; a list, progress or code become text lines);
- ``gadget_action``: a device action.

The other gadget tools (ask, speak, play, widget, interpret) need the gateway's chat and
are answered with a plain message saying so.
"""
from __future__ import annotations

import json
import os
import tempfile
import time
import uuid
from pathlib import Path
from typing import Any

NOT_HERE = "not running in this process"
STALE_AFTER_S = 90
MAX_TITLE = 64
MAX_TEXT = 600
WAIT_CARD_S = 8.0
WAIT_ACTION_S = 18.0
DESK_TOOLS = ("gadget_devices", "gadget_display", "gadget_action")


def _result(payload: dict) -> str:
    return json.dumps(payload)


def _error(message: str) -> str:
    return _result({"success": False, "error": message})


def gadget_data_dir() -> Path:
    try:
        from plugins.plugin_storage import plugin_data_dir

        return Path(plugin_data_dir("gadget"))
    except Exception:
        home = os.environ.get("HERMES_HOME") or os.path.expanduser("~/.hermes")
        return Path(home) / "plugin-data" / "gadget"


def _read(path: Path) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def live_devices(data_dir: Path, now: float | None = None) -> tuple[bool, dict[str, dict]]:
    """(gateway running, connected devices) from the gateway's status.json."""
    raw = _read(data_dir / "status.json")
    now = time.time() if now is None else now
    updated = raw.get("updated_at")
    fresh = isinstance(updated, (int, float)) and -5 <= now - updated <= STALE_AFTER_S
    running = bool(raw.get("running")) and fresh
    devices = raw.get("devices") if running and isinstance(raw.get("devices"), dict) else {}
    return running, {k: v for k, v in devices.items() if isinstance(v, dict) and v.get("online", True)}


def _known(data_dir: Path) -> dict[str, dict]:
    devices = _read(data_dir / "devices.json").get("devices")
    return devices if isinstance(devices, dict) else {}


def _name(device_id: str, live: dict, known: dict) -> str:
    return str((live.get(device_id) or {}).get("name") or (known.get(device_id) or {}).get("name") or device_id)


def resolve_device(data_dir: Path, ref: Any) -> tuple[str | None, str]:
    """(device id, name) or (None, why not)."""
    running, live = live_devices(data_dir)
    if not running:
        return None, "the Hermes gateway is not running (or the Gadget platform is off), so no gadget is reachable. Start it in Studio: Connections → MCU devices → Hermes Gadget → Restart gateway"
    known = _known(data_dir)
    ref = str(ref or "").strip()
    if ref:
        for device_id in live:
            if ref == device_id or ref.lower() == _name(device_id, live, known).lower():
                return device_id, _name(device_id, live, known)
        names = ", ".join(f"{_name(d, live, known)} ({d})" for d in live) or "none connected"
        return None, f"no connected gadget matches {ref!r}; connected: {names}"
    if len(live) == 1:
        device_id = next(iter(live))
        return device_id, _name(device_id, live, known)
    if not live:
        return None, "no gadget is connected"
    return None, "several gadgets are connected; pass device: " + ", ".join(_name(d, live, known) for d in live)


def _write_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".req.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(data, handle)
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def desk_request(data_dir: Path, device_id: str, kind: str, fields: dict, timeout: float, poll: float = 0.15) -> dict:
    """Send one request through the plugin's desk folder and wait for the gateway's answer."""
    req_id = uuid.uuid4().hex
    inbox = data_dir / "desk" / "inbox" / f"{req_id}.json"
    done = data_dir / "desk" / "done" / f"{req_id}.json"
    _write_json(inbox, {"device": device_id, "kind": kind, "at": time.time(), **fields})
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        answer = _read(done)
        if answer:
            return answer
        time.sleep(poll)
    inbox.unlink(missing_ok=True)  # withdrawn: a gateway that starts later must not act on it
    return {"ok": False, "error": "the gateway did not answer in time; is it running with the Gadget platform on?"}


def _devices(data_dir: Path) -> str:
    running, live = live_devices(data_dir)
    known = _known(data_dir)
    connected = [{"device_id": d, "name": _name(d, live, known), "board": (known.get(d) or {}).get("board"),
                  "activity": ((live.get(d) or {}).get("activity") or {}).get("state")} for d in live]
    offline = [{"device_id": d, "name": _name(d, live, known), "board": rec.get("board"), "last_seen": rec.get("last_seen")}
               for d, rec in known.items() if d not in live and isinstance(rec, dict)]
    note = ("Studio chat: gadget_display (title and text) and gadget_action work here; device action names "
            "come from the gadget itself (try face.set). The other gadget tools need a gateway chat.")
    if not running:
        note = "The Hermes gateway is not running, so no gadget is connected. " + note
    return _result({"success": True, "connected": connected, "offline": offline, "note": note})


def _card_text(args: dict) -> str:
    lines = [str(args.get("text") or "").strip()]
    items = args.get("items")
    if isinstance(items, list):
        lines += [f"- {str(item).strip()}" for item in items[:12] if str(item).strip()]
    if args.get("progress") is not None:
        try:
            lines.append(f"{max(0, min(100, int(args['progress'])))}%")
        except (TypeError, ValueError):
            pass
    if str(args.get("qr") or "").strip():
        lines.append(str(args["qr"]).strip())
    return "\n".join(line for line in lines if line)[:MAX_TEXT]


def studio_gadget_result(tool_name: str, args: Any, data_dir: Path | None = None) -> str:
    """What a gadget tool returns in a Studio chat (see the module doc)."""
    args = args if isinstance(args, dict) else {}
    data_dir = data_dir or gadget_data_dir()
    if tool_name == "gadget_devices":
        return _devices(data_dir)
    if tool_name not in DESK_TOOLS:
        return _error(f"{tool_name} only works in chats the Hermes gateway runs (a gadget's own chat, Telegram, "
                      "the Hermes API server). In this Studio chat use gadget_display or gadget_action.")
    device_id, name = resolve_device(data_dir, args.get("device"))
    if device_id is None:
        return _error(name)
    if tool_name == "gadget_display":
        title = str(args.get("title") or "").strip()[:MAX_TITLE]
        text = _card_text(args)
        if not title and not text:
            return _error("text is required")
        try:
            seconds = max(0, min(int(args.get("seconds", 20)), 3600))
        except (TypeError, ValueError):
            seconds = 20
        answer = desk_request(data_dir, device_id, "card", {"title": title, "text": text, "seconds": seconds}, WAIT_CARD_S)
        if not answer.get("ok"):
            return _error(f"could not reach {name}: {answer.get('error') or 'no answer'}")
        result = {"success": True, "device": name, "shown_for_s": seconds or "until dismissed"}
        if args.get("items") or args.get("progress") is not None or args.get("qr") or args.get("id"):
            result["note"] = "from a Studio chat a card is title and text: the list, progress and code are shown as text, and id is not used"
        if answer.get("held"):
            result["note"] = (result.get("note", "") + "; " if result.get("note") else "") + "the screen is off: the card shows when it lights up"
        return _result(result)
    action = str(args.get("action") or "").strip()
    if not action:
        return _error("action is required")
    call_args = args.get("args") or {}
    if not isinstance(call_args, dict):
        return _error("args must be an object")
    answer = desk_request(data_dir, device_id, "action", {"action": action, "args": call_args}, WAIT_ACTION_S)
    if not answer.get("ok"):
        return _error(str(answer.get("error") or f"{name} did not answer"))
    return _result({"success": True, "device": name, "action": action, "result": answer.get("result")})


def needs_desk(tool_name: str, result: Any) -> bool:
    """A gadget tool that failed only because this process has no gadget hub."""
    return str(tool_name or "").startswith("gadget_") and isinstance(result, str) and NOT_HERE in result
