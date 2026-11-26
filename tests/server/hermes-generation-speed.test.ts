import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { hermesGenerationSeconds } from '../../packages/server/src/modules/studio/services/usage/bridge-model-usage'

function runPython(script: string): any {
  return JSON.parse(execFileSync('python3', ['-c', script], { cwd: process.cwd(), encoding: 'utf8', stdio: 'pipe' }))
}

// Same stubs as agent-bridge-clarify-payload.test.ts: the real bridge_pool.py, no Hermes.
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
bridge_runtime._load_disabled_toolsets = lambda *_a, **_k: []
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
bridge_runtime._tool_load_info = lambda *_a, **_k: {}
bridge_runtime._tool_search_setting = lambda *_a, **_k: "auto"

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

class _FakeAgent:
    _interrupt_requested = False

class _FakeSession:
    def __init__(self):
        self.agent = _FakeAgent()
        self.current_run_id = "run-1"

pool._sessions["session-1"] = _FakeSession()
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

describe('Hermes model speed from the first streamed output', () => {
  it('the bridge notes the first text or reasoning of each request and reports it with usage', () => {
    const out = runPython(PRELUDE + String.raw`
import time
clock = [1000.0]
time.time = lambda: clock[0]
reasoning = pool._text_event_callback("session-1", "reasoning.delta")
stream = pool._stream_delta_callback("session-1")
clock[0] = 1020.0; reasoning("")          # empty: not output
clock[0] = 1021.0; reasoning("thinking")  # first output of request 1
clock[0] = 1030.0; stream("text")         # later output: clock already running
pool._post_api_request_usage_hook(session_id="session-1", api_request_id="r1", usage={"output_tokens": 10}, api_duration=65.0, started_at=1000.0, ended_at=1065.0)
pool._post_api_request_usage_hook(session_id="session-1", api_request_id="r2", usage={"output_tokens": 1}, api_duration=2.0, started_at=1070.0, ended_at=1072.0)
stream(None)                              # a turn boundary is not output
print(json.dumps([e.get("first_output_at") for e in events if e.get("event") == "model.usage"] + [pool._first_output_at.get("session-1")]))
`)
    expect(out).toEqual([1021, null, null])
  })

  it('Studio times Hermes from that first output, as llama.cpp does', () => {
    // 20 s of prompt processing, then 44 s generating.
    expect(hermesGenerationSeconds({ api_duration: 64, started_at: 1000, first_output_at: 1020, ended_at: 1064 })).toBe(44)
  })

  it('falls back to the whole request when the first output is missing, stale or too short', () => {
    expect(hermesGenerationSeconds({ api_duration: 64, started_at: 1000, ended_at: 1064 })).toBe(64)
    expect(hermesGenerationSeconds({ api_duration: 64, started_at: 1000, first_output_at: 990, ended_at: 1064 })).toBe(64)
    expect(hermesGenerationSeconds({ api_duration: 5, started_at: 1000, first_output_at: 1004.9, ended_at: 1005 })).toBe(5)
    expect(hermesGenerationSeconds({ api_duration: 5, first_output_at: 900, ended_at: 1005 })).toBe(5)
    expect(hermesGenerationSeconds({})).toBeUndefined()
  })
})
