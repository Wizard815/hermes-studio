"""Checks bridge_turn_guards: Studio's Hermes chats get Hermes's intent-ack re-prompt unless the
profile chose for itself. Usage: python3 hermes-bridge-turn-guards.py. Prints a line when verified."""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "packages/server/src/modules/hermes/services/bridge/python"))
from bridge_turn_guards import apply_turn_guards  # noqa: E402


class Agent:
    """What AIAgent sets from config (agent_init: ``agent.intent_ack_continuation``, default auto)."""
    def __init__(self, value="auto"):
        self._intent_ack_continuation = value


# No setting in the profile: on for Studio's chats.
for cfg in ({}, None, {"agent": {}}, {"agent": {"max_turns": 60}}, {"agent": None}):
    agent = Agent()
    assert apply_turn_guards(agent, cfg) is True, cfg
    assert agent._intent_ack_continuation is True, cfg

# The profile's own choice wins, whatever it is.
for value in (False, "off", "auto", True, ["hy4", "qwen"]):
    agent = Agent(value)
    assert apply_turn_guards(agent, {"agent": {"intent_ack_continuation": value}}) is False, value
    assert agent._intent_ack_continuation == value, value

# A Hermes without the guard is left alone.
class OldAgent:
    pass
old = OldAgent()
assert apply_turn_guards(old, {}) is False
assert not hasattr(old, "_intent_ack_continuation")

print("Hermes bridge turn guards verified")
