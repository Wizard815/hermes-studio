import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

function runPython(script: string): Record<string, unknown> {
  try {
    return JSON.parse(execFileSync('python3', ['-c', script], {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: 'pipe',
    }))
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message?: string }
    throw new Error([
      err.message || 'Agent Bridge clarify payload test failed',
      err.stdout ? `stdout:\n${err.stdout}` : '',
      err.stderr ? `stderr:\n${err.stderr}` : '',
    ].filter(Boolean).join('\n\n'))
  }
}

// Shared prelude: stub bridge_runtime, load bridge_pool.py, install a fake
// _append_event that records events AND immediately answers the clarify so the
// callback's response_queue.get(timeout=300) does not block the test.
const PRELUDE = String.raw`
import contextlib
import importlib.util
import json
import sys
import tempfile
import types
from pathlib import Path

bridge_runtime = types.ModuleType("bridge_runtime")
bridge_runtime.APPROVAL_TIMEOUT_MS = 1000
bridge_runtime.APPROVAL_TIMEOUT_SECONDS = 1
bridge_runtime._approval_pattern_keys = lambda *_a, **_k: []
bridge_runtime._base_hermes_home = lambda: Path(tempfile.gettempdir())
bridge_runtime._bridge_platform = lambda: "agent-bridge"
bridge_runtime._cfg_max_turns = lambda *_a, **_k: 20
bridge_runtime._discover_bridge_mcp_tools = lambda *_a, **_k: []
bridge_runtime._ensure_agent_imports = lambda: None
bridge_runtime._hermes_home = lambda *_a, **_k: Path(tempfile.gettempdir())
bridge_runtime._install_execute_code_approval_memory_patch = lambda *_a, **_k: None
bridge_runtime._jsonable = lambda value: value
bridge_runtime._load_cfg = lambda *_a, **_k: {}
bridge_runtime._load_enabled_toolsets = lambda *_a, **_k: []
bridge_runtime._load_fallback_model = lambda cfg: None
bridge_runtime._load_reasoning_config = lambda *_a, **_k: {}
bridge_runtime._load_service_tier = lambda *_a, **_k: None
bridge_runtime._mcp_tool_names_from_names = lambda *_a, **_k: []
bridge_runtime._persist_execute_code_approval_choice = lambda *_a, **_k: None
bridge_runtime._profile_home = lambda *_a, **_k: Path(tempfile.gettempdir())
bridge_runtime._refresh_approval_allowlist = lambda *_a, **_k: None
bridge_runtime._refresh_worker_profile_env = lambda *_a, **_k: None
bridge_runtime._resolve_model = lambda *_a, **_k: "primary-model"
bridge_runtime._resolve_runtime = lambda *_a, **_k: {"provider": "primary"}
bridge_runtime._suppress_bridge_platform_hint = lambda: None
bridge_runtime._title_user_message = lambda value: value
bridge_runtime._tool_names_from_definitions = lambda *_a, **_k: []

@contextlib.contextmanager
def _profile_env(_profile):
    yield
bridge_runtime._profile_env = _profile_env
sys.modules["bridge_runtime"] = bridge_runtime

spec = importlib.util.spec_from_file_location(
    "bridge_pool",
    "packages/server/src/modules/hermes/services/bridge/python/bridge_pool.py",
)
bridge_pool = importlib.util.module_from_spec(spec)
sys.modules["bridge_pool"] = bridge_pool
spec.loader.exec_module(bridge_pool)

run_agent = types.ModuleType("run_agent")
class AIAgent:
    def __init__(self, **kwargs):
        self.kwargs = kwargs
        self.tools = []
run_agent.AIAgent = AIAgent
sys.modules["run_agent"] = run_agent

pool = bridge_pool.AgentPool()
events = []

def fake_append_event(session_id, event):
    events.append(event)
    if event.get("event") == "clarify.requested":
        q = pool._clarify_requests.get(event["clarify_id"])
        if q is not None:
            try:
                q.put_nowait("commands")
            except Exception:
                pass

pool._append_event = fake_append_event
`

describe('Agent Bridge clarify payload', () => {
  // clarify_tool.py calls the bridge callback as callback(normalized) -- ONE
  // argument, the normalized question list. Passing that list into a
  // (question: str, choices) signature stringified it, so the UI received a
  // Python repr of the whole payload as `question` and `choices: None` (no
  // buttons). See bridge_pool._clarify_callback.
  it('unwraps the normalized question list into a question string plus choices', () => {
    const result = runPython(PRELUDE + String.raw`
callback = pool._clarify_callback("session-1")
normalized = [{
    "qid": "q0",
    "question": "How do you want to deploy the Upstream-Keep systemd service?",
    "choices": ["I'll run the commands myself", "You DO have sudo"],
    "choices_offered": ["I'll run the commands myself", "You DO have sudo"],
    "multi_select": False,
}]
reply = callback(normalized)
event = events[-1]
print(json.dumps({
    "reply": reply,
    "question": event.get("question"),
    "choices": event.get("choices"),
    "multi_select": event.get("multi_select"),
    "questions_is_list": isinstance(event.get("questions"), list),
}))
`)

    expect(result.reply).toBe('commands')
    expect(result.question).toBe('How do you want to deploy the Upstream-Keep systemd service?')
    expect(result.choices).toEqual(["I'll run the commands myself", 'You DO have sudo'])
    expect(result.multi_select).toBe(false)
    expect(result.questions_is_list).toBe(true)
    // The regression itself: the payload must never arrive as a list repr.
    expect(String(result.question).startsWith('[')).toBe(false)
  })

  it('still accepts the legacy (question, choices) call form', () => {
    const result = runPython(PRELUDE + String.raw`
callback = pool._clarify_callback("session-1")
reply = callback("Pick a branch", ["main", "release"])
event = events[-1]
print(json.dumps({
    "reply": reply,
    "question": event.get("question"),
    "choices": event.get("choices"),
}))
`)

    expect(result.reply).toBe('commands')
    expect(result.question).toBe('Pick a branch')
    expect(result.choices).toEqual(['main', 'release'])
  })

  it('emits no choices when the question is open-ended', () => {
    const result = runPython(PRELUDE + String.raw`
callback = pool._clarify_callback("session-1")
normalized = [{"qid": "q0", "question": "Describe the failure", "multi_select": False}]
reply = callback(normalized)
event = events[-1]
print(json.dumps({
    "reply": reply,
    "question": event.get("question"),
    "choices": event.get("choices"),
    "multi_select": event.get("multi_select"),
}))
`)

    expect(result.question).toBe('Describe the failure')
    expect(result.choices).toBeNull()
    expect(result.multi_select).toBe(false)
  })
})
