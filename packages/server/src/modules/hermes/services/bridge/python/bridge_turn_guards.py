"""Hermes's "said it would act, then stopped" re-prompt, on for Studio's Hermes chats.

Small models often end a turn on an announcement and no tool call: "I'll find the Studio
phone tool and read the screen." Hermes returns that as the answer and the chat stops.
Hermes has a bounded re-prompt for it (``agent.intent_ack_continuation``: at most two
"[System: Continue now. Execute the required tool calls...]" nudges per turn, only before
the turn's first tool result, only for a short reply that promises an action). Its
default, ``auto``, keeps it to Codex-style providers, so Studio's chats never got it.

Studio's chats always offer tools, so the bridge turns it on for them. A profile that sets
``agent.intent_ack_continuation`` itself (true, false, or model names) keeps its choice.
A false positive costs one extra model call; the answer is kept.
"""
from __future__ import annotations

from typing import Any

SETTING = "intent_ack_continuation"


def apply_turn_guards(agent: Any, cfg: dict[str, Any] | None) -> bool:
    """Turn the intent-ack re-prompt on unless the profile's config says otherwise.

    Returns whether the bridge changed the agent.
    """
    section = (cfg or {}).get("agent")
    if isinstance(section, dict) and SETTING in section:
        return False
    if not hasattr(agent, "_intent_ack_continuation"):
        # An older Hermes without the guard: nothing to turn on.
        return False
    agent._intent_ack_continuation = True
    return True
