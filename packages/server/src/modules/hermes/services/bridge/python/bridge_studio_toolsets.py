"""Studio tools called by their own name in Studio's Hermes chats.

Studio's ``use`` and ``browser`` MCP servers show Hermes one tool each
(``ekko_studio_use_toolset`` / ``ekko_studio_browser_toolset``) and keep the real
tools (``ekko_studio_use_orb_board``, ``ekko_studio_use_phone``...) behind its
``list`` / ``describe`` / ``call`` actions. Docs, prompts and Orb name the real
tools, and small models call them directly. Hermes answers an unknown tool name
with an error, and after three in a row ends the run ("Model generated invalid tool
call"), so those models never reach the tool.

Hermes already rewrites a call to a tool that tool search hides into its
``tool_call`` bridge (``agent.turn_tool_validation._route_deferred_call``). The bridge
adds the same for Studio's toolsets: a call to a catalog tool by its name becomes the
toolset's ``action=call`` with the model's arguments. A name the catalog does not
have gets the toolset's own "Unknown tool, call list first" answer instead of a
strike. Nothing changes when the toolset tool is not in the chat.
"""
from __future__ import annotations

import json
from typing import Any

# (catalog tool prefix, MCP server name as Hermes spells it in tool names)
TOOLSETS = (
    ("ekko_studio_use_", "ekko_studio_use"),
    ("ekko_studio_browser_", "ekko_studio_browser"),
)
PATCH_FLAG = "_studio_toolset_routing"


def _bare_name(name: str) -> str:
    bare = name.strip()
    for _, server in TOOLSETS:
        prefix = f"mcp__{server}__"
        if bare.startswith(prefix):
            bare = bare[len(prefix):]
            break
    if bare.startswith("hermes_studio_"):
        bare = "ekko_studio_" + bare[len("hermes_studio_"):]
    return bare


def toolset_target(name: Any, valid_names: Any) -> tuple[str, str | None] | None:
    """The toolset tool to call for ``name``, and the catalog tool inside it.

    The catalog tool is None when ``name`` is the toolset itself spelled without its
    MCP prefix. None when ``name`` is not a Studio toolset tool or the toolset is not
    in this chat."""
    if not isinstance(name, str) or not name.strip():
        return None
    valid = set(valid_names or ())
    if name in valid:
        return None
    bare = _bare_name(name)
    for tool_prefix, server in TOOLSETS:
        toolset = f"{server}_toolset"
        qualified = f"mcp__{server}__{toolset}"
        if qualified not in valid:
            continue
        if bare == toolset:
            return qualified, None
        if bare.startswith(tool_prefix):
            return qualified, bare
    return None


def route_studio_toolset_call(agent: Any, tc: Any) -> bool:
    """Rewrite ``tc`` in place into a call of its Studio toolset. True when rewritten."""
    target = toolset_target(getattr(tc.function, "name", None), getattr(agent, "valid_tool_names", None))
    if not target:
        return False
    args: Any = tc.function.arguments or "{}"
    if isinstance(args, str):
        try:
            args = json.loads(args.strip() or "{}")
        except json.JSONDecodeError:
            return False
    if not isinstance(args, dict):
        return False
    toolset, tool = target
    original = tc.function.name
    tc.function.name = toolset
    tc.function.arguments = json.dumps(
        args if tool is None else {"action": "call", "tool": tool, "arguments": args},
        ensure_ascii=False,
    )
    try:
        agent._vprint(f"{getattr(agent, 'log_prefix', '')}🔧 Routed Studio tool '{original}' through '{toolset}'",
                      force=True, diagnostic=True)
    except Exception:
        pass
    return True


def install_studio_toolset_routing() -> bool:
    """Extend Hermes's deferred-tool routing with Studio's toolsets (once per process)."""
    try:
        import agent.turn_tool_validation as validation
    except Exception:
        return False
    original = getattr(validation, "_route_deferred_call", None)
    if not callable(original):
        return False
    if getattr(original, PATCH_FLAG, False):
        return True

    def routed(agent: Any, tc: Any) -> bool:
        if original(agent, tc):
            return True
        try:
            return route_studio_toolset_call(agent, tc)
        except Exception:
            return False

    setattr(routed, PATCH_FLAG, True)
    setattr(routed, "_studio_original", original)
    validation._route_deferred_call = routed
    return True
