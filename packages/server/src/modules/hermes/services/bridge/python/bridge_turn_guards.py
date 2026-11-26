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

The same model also stops AFTER a tool result: "The phone tool is deferred; locating it
now." or "Now let me discover the agent work tool." Hermes's stall guard
(``trailing_continue_intent``, on by default, same two-nudge cap) only knows "let me now",
"I'll now", "now I'll" and "next, I". The bridge widens it to a short reply whose last
sentence is a plan to act ("Now let me find...", "I'll call...") or a "-ing ... now"
clause ("...; locating it now.", "Calling the phone tool now."). "Let me know..." and
statements such as "The build is running now." stay answers.
"""
from __future__ import annotations

import re
from typing import Any

SETTING = "intent_ack_continuation"
STALL_FLAG = "_studio_stall_tail"
# Hermes's own limit for the stall guard: a longer reply is a substantive answer.
_MAX_CHARS = 400
_VERBS = (
    r"(?:find|locate|discover|call|run|read|open|check|search|look|load|use|tap|create|write|try|fetch|get|list|"
    r"describe|update|mark|set|save|send|start|do|make|execute|invoke|retry|confirm|inspect|query|add)"
)
_LAST_SENTENCE = re.compile(r"[^.!?\n]*[.!?:\u2026]*\s*$")
_PLAN = re.compile(
    r"^\s*(?:(?:now|next|then|first|ok(?:ay)?)[,:]?\s+)?"
    r"(?:let me|i['\u2019]ll|i will|i['\u2019]m going to|i am going to)\s+(?:now\s+|first\s+|just\s+|quickly\s+)?"
    + _VERBS + r"\b",
    re.IGNORECASE,
)
_ING_NOW = re.compile(
    r"(?:^|[;:\u2014\u2013]\s*)\w+ing\b(?:\s+(?:it|them|that|this|the\s+\w+(?:\s+\w+)?))?\s+now\s*[.!\u2026]*\s*$",
    re.IGNORECASE,
)
_LET_ME_KNOW = re.compile(r"^\s*let me know\b", re.IGNORECASE)


def announces_next_action(text: Any) -> bool:
    """Whether a short reply ENDS on an announced next step instead of an answer."""
    t = str(text or "").strip()
    if not t or len(t) > _MAX_CHARS:
        return False
    match = _LAST_SENTENCE.search(t)
    last = (match.group(0) if match else t).strip()
    if not last or _LET_ME_KNOW.match(last):
        return False
    return bool(_PLAN.search(last) or _ING_NOW.search(last))


def install_stall_tail_detector() -> bool:
    """Widen Hermes's stall guard with ``announces_next_action`` (once per process)."""
    try:
        import agent.agent_runtime_helpers as helpers
    except Exception:
        return False
    original = getattr(helpers, "trailing_continue_intent", None)
    if not callable(original):
        return False
    if getattr(original, STALL_FLAG, False):
        return True

    def trailing_continue_intent(text: str) -> bool:
        return bool(original(text)) or announces_next_action(text)

    setattr(trailing_continue_intent, STALL_FLAG, True)
    setattr(trailing_continue_intent, "_studio_original", original)
    helpers.trailing_continue_intent = trailing_continue_intent
    return True


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
