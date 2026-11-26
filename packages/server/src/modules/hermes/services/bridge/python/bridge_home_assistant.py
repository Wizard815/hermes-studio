"""Home Assistant actions ask first in Studio's Hermes chats.

Hermes asks before risky shell commands, not before a Home Assistant service call, so
"turn the heating off" ran without a question. The bridge adds a ``pre_tool_call`` hook:
a call that changes something in Home Assistant goes to Hermes's own approval gate
(``{"action": "approve"}``), which reaches Studio as an ordinary ``approval.requested``.
Studio then does what it does for every Hermes approval: it asks you, or answers by
itself in auto mode or when a watcher trust rule (``light.*``, ``light.turn_on``) allows it.
Reads (list entities, get a state, list services, the MCP server's read tools) go ahead.

Two sources of Home Assistant tools:

- the ``homeassistant`` Hermes plugin: ``ha_list_entities``, ``ha_get_state``,
  ``ha_list_services`` (reads) and ``ha_call_service`` (asks);
- Home Assistant's own MCP server (Studio's "Your home" form, ``<address>/api/mcp``):
  its read tools go ahead, every other tool asks.
"""
from __future__ import annotations

import fnmatch
import json
import re
from typing import Any

PLUGIN_READS = frozenset({"ha_list_entities", "ha_get_state", "ha_list_services"})
PLUGIN_ACTION = "ha_call_service"

# Home Assistant's read tools (readOnlyHint), as Studio's "Your home" form includes them
# (packages/client/src/api/hermes/extensions.ts HOME_ASSISTANT_READ_TOOLS).
MCP_READ_GLOBS = (
    "*GetLiveContext", "*GetDateTime", "*get_items", "*get_history", "*render_template",
    "*search_actions", "*search_integrations", "search", "*__search", "*get_config_entries",
    "*get_system_info", "*get_entries", "*get_logs",
)

_HA_SERVER_NAMES = {"home_assistant", "homeassistant", "hass"}


def _clean(value: Any, limit: int = 120) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()[:limit]


def _sanitize(name: str) -> str:
    return re.sub(r"[^A-Za-z0-9_]", "_", str(name or ""))


def home_assistant_servers(mcp_servers: Any) -> list[str]:
    """Names of configured MCP servers that are Home Assistant's own MCP server."""
    if not isinstance(mcp_servers, dict):
        return []
    found = []
    for name, cfg in mcp_servers.items():
        url = str(cfg.get("url") or "") if isinstance(cfg, dict) else ""
        if re.search(r"/api/mcp/?$", url) or _sanitize(name).lower() in _HA_SERVER_NAMES:
            found.append(str(name))
    return found


def _mcp_tool(tool_name: str, servers: list[str]) -> str | None:
    """The MCP tool's own name when ``tool_name`` is one of these servers' tools
    (Hermes names them ``mcp__<server>__<tool>``, older releases ``mcp_<server>_<tool>``)."""
    for server in servers:
        for prefix in (f"mcp__{_sanitize(server)}__", f"mcp_{_sanitize(server)}_"):
            if tool_name.startswith(prefix) and len(tool_name) > len(prefix):
                return tool_name[len(prefix):]
    return None


def _target(args: dict) -> str:
    data = args.get("data")
    if isinstance(data, str):
        try:
            data = json.loads(data)
        except ValueError:
            data = None
    parts = []
    for key in ("entity_id", "name", "area", "floor", "device_class"):
        value = args.get(key) if args.get(key) not in (None, "") else (data or {}).get(key) if isinstance(data, dict) else None
        if isinstance(value, list):
            value = ", ".join(str(item) for item in value)
        if value not in (None, ""):
            parts.append(_clean(value, 80))
    return ", ".join(dict.fromkeys(parts))


def home_assistant_action(tool_name: str, args: Any, servers: list[str]) -> dict | None:
    """What a Home Assistant tool call would change, or None when it only reads (or is not
    a Home Assistant tool). ``value`` is what trust rules match: ``<domain>.<service>``
    (``light.turn_on``) or the MCP tool's name (``HassTurnOn``)."""
    name = str(tool_name or "")
    args = args if isinstance(args, dict) else {}
    if name in PLUGIN_READS:
        return None
    if name == PLUGIN_ACTION or name.startswith("ha_"):
        domain, service = _clean(args.get("domain"), 60), _clean(args.get("service"), 60)
        value = f"{domain}.{service}" if domain and service else name
    else:
        tool = _mcp_tool(name, servers)
        if tool is None:
            return None
        bare = tool.split("__")[-1]
        if any(fnmatch.fnmatchcase(tool, glob) or fnmatch.fnmatchcase(bare, glob) for glob in MCP_READ_GLOBS):
            return None
        domain = _clean(args.get("domain"), 60)
        service = _clean(args.get("service") or args.get("action"), 60)
        if isinstance(args.get("domain"), list):
            domain = ""
        value = f"{domain}.{service}" if domain and service and "." not in service else service if "." in service else bare
    target = _target(args)
    text = f"Home Assistant: {value}{f' on {target}' if target else ''}"
    return {"kind": "tool", "value": value, "text": text[:300]}
