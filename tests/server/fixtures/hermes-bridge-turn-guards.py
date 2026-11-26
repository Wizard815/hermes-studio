"""Checks bridge_turn_guards: Studio's Hermes chats get Hermes's intent-ack re-prompt unless the
profile chose for itself. Usage: python3 hermes-bridge-turn-guards.py. Prints a line when verified."""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "packages/server/src/modules/hermes/services/bridge/python"))
import types  # noqa: E402
from bridge_turn_guards import announces_next_action, apply_turn_guards, install_stall_tail_detector  # noqa: E402


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

# Replies hy4-flash ended Studio Hermes turns on (OpenRouter E2E rounds 3-4): re-prompted.
for stall in (
    "No session goals to track. The phone tool is deferred; locating it now.",
    "Now let me discover the `ekko_studio_use_agent_work` tool.",
    "I'll start by writing the file and discovering the needed Studio tools in parallel.\n\nNow let me discover the `ekko_studio_use_agent_work` tool.",
    "I'll find the Studio phone tool and read the screen.",
    "Found the tool. Let me confirm its schema and then call it.",
    "Calling the phone tool now.",
):
    assert announces_next_action(stall), stall
# Answers stay answers.
for answer in (
    "The phone screen shows two buttons:\n\n- **Save**\n- **Send**",
    "Done. I saved it in your wiki.",
    "Let me know if you need anything else.",
    "I'll be here if you need anything.",
    "The build is running now.",
    "It is snowing now.",
    "Hello!",
    "",
    "Now let me explain. " + "The result is long. " * 30,
):
    assert not announces_next_action(answer), answer

# Installed over Hermes's own detector, once; Hermes's matches still count.
helpers = types.ModuleType("agent.agent_runtime_helpers")
helpers.trailing_continue_intent = lambda text: "let me now" in (text or "").lower()
package = types.ModuleType("agent")
package.agent_runtime_helpers = helpers
sys.modules["agent"], sys.modules["agent.agent_runtime_helpers"] = package, helpers
try:
    assert install_stall_tail_detector() is True
    assert install_stall_tail_detector() is True
    detect = helpers.trailing_continue_intent
    assert detect("OK, let me now fix it")
    assert detect("Now let me discover the tool.")
    assert not detect("The phone shows Save and Send.")
    assert detect._studio_original("OK, let me now fix it")
finally:
    sys.modules.pop("agent", None)
    sys.modules.pop("agent.agent_runtime_helpers", None)

print("Hermes bridge turn guards verified")
