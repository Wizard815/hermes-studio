"""A slow MCP server must not hold a new chat: the bridge waits a bounded time for discovery."""
import sys
import threading
import time
import unittest
from pathlib import Path
from types import ModuleType
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / 'packages/server/src/modules/hermes/services/bridge/python'))
import bridge_runtime


def fake_hermes(connect_seconds: float, blocking_calls: list):
    """Synthetic Hermes MCP modules: discovery connects one fast and one slow server."""
    state = {'thread': None, 'names': []}

    def discover():
        state['names'].append('mcp_fast_hello')
        time.sleep(connect_seconds)  # the slow server (npx that cannot download)
        state['names'].append('mcp_rea_inspect')

    startup = ModuleType('hermes_cli.mcp_startup')

    def start_background_mcp_discovery(*, logger, thread_name):
        if state['thread'] is None or not state['thread'].is_alive():
            state['thread'] = threading.Thread(target=discover, name=thread_name, daemon=True)
            state['thread'].start()

    def join_mcp_discovery(timeout=None):
        state['thread'].join(timeout)
        return not state['thread'].is_alive()

    startup.start_background_mcp_discovery = start_background_mcp_discovery
    startup.join_mcp_discovery = join_mcp_discovery
    cli = ModuleType('hermes_cli'); cli.__path__ = []
    registration = ModuleType('tools.mcp_tool_registration')
    registration._existing_tool_names = lambda: list(state['names'])
    discovery = ModuleType('tools.mcp_tool_discovery')
    discovery.mcp_servers_awaiting_connect = lambda: ['rea'] if len(state['names']) < 2 else []

    def discover_mcp_tools():
        blocking_calls.append(1)
        time.sleep(connect_seconds)
        return ['mcp_fast_hello', 'mcp_rea_inspect']

    discovery.discover_mcp_tools = discover_mcp_tools
    tools = ModuleType('tools'); tools.__path__ = []
    return {
        'hermes_cli': cli, 'hermes_cli.mcp_startup': startup, 'tools': tools,
        'tools.mcp_tool_registration': registration, 'tools.mcp_tool_discovery': discovery,
    }


class BoundedMcpDiscoveryTests(unittest.TestCase):
    def run_discovery(self, env: dict, connect_seconds: float):
        blocking: list = []
        with patch.dict(sys.modules, fake_hermes(connect_seconds, blocking)), \
                patch.dict('os.environ', env), \
                patch.object(bridge_runtime, '_ensure_agent_imports', lambda: None):
            started = time.monotonic()
            names = bridge_runtime._discover_bridge_mcp_tools()
            return names, time.monotonic() - started, blocking

    def test_new_chat_waits_at_most_the_bound(self):
        names, took, blocking = self.run_discovery({'HERMES_AGENT_BRIDGE_MCP_WAIT_SECONDS': '0.3'}, connect_seconds=3)
        self.assertLess(took, 1.5)
        self.assertEqual(names, ['mcp_fast_hello'])
        self.assertEqual(blocking, [])

    def test_fast_servers_are_all_there(self):
        names, took, _ = self.run_discovery({'HERMES_AGENT_BRIDGE_MCP_WAIT_SECONDS': '2'}, connect_seconds=0.05)
        self.assertLess(took, 1.5)
        self.assertEqual(names, ['mcp_fast_hello', 'mcp_rea_inspect'])

    def test_zero_waits_for_every_server(self):
        names, took, blocking = self.run_discovery({'HERMES_AGENT_BRIDGE_MCP_WAIT_SECONDS': '0'}, connect_seconds=0.2)
        self.assertEqual(blocking, [1])
        self.assertEqual(names, ['mcp_fast_hello', 'mcp_rea_inspect'])

    def test_default_bound_is_ten_seconds(self):
        with patch.dict('os.environ', {}, clear=False):
            import os
            os.environ.pop('HERMES_AGENT_BRIDGE_MCP_WAIT_SECONDS', None)
            self.assertEqual(bridge_runtime._mcp_discovery_wait_seconds(), 10.0)


if __name__ == '__main__':
    result = unittest.main(exit=False, verbosity=0).result
    if not result.wasSuccessful():
        sys.exit(1)
    print('Hermes bridge bounded MCP discovery verified')
