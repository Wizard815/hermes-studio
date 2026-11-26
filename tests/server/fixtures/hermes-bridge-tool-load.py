"""The bridge tells Studio how many tools a Hermes chat really has (docs/hermes-tool-load.md)."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / 'packages/server/src/modules/hermes/services/bridge/python'))
from bridge_runtime import _tool_load_info, _tool_search_setting


def tool(name, description=''):
    return {'type': 'function', 'function': {'name': name, 'description': description, 'parameters': {'type': 'object'}}}


class ToolLoadTests(unittest.TestCase):
    def test_counts_tools_hidden_by_tool_search(self):
        tools = [tool('terminal'), tool('read_file'),
                 tool('tool_search', 'Search 247 additional tools that are loaded on demand. Send one keyword query.'),
                 tool('tool_describe'), tool('tool_call')]
        info = _tool_load_info(tools, {'tools': {'tool_search': {'enabled': 'auto'}}})
        self.assertEqual(info, {'tool_search': 'auto', 'tool_search_active': True, 'deferred_tool_count': 247, 'total_tool_count': 249})

    def test_without_tool_search_every_tool_is_visible(self):
        tools = [tool(f'mcp_rea_{i}') for i in range(209)]
        info = _tool_load_info(tools, {'tools': {'tool_search': {'enabled': 'off'}}})
        self.assertEqual(info, {'tool_search': 'off', 'tool_search_active': False, 'deferred_tool_count': 0, 'total_tool_count': 209})

    def test_reads_the_setting_like_hermes(self):
        self.assertEqual(_tool_search_setting({}), 'auto')
        self.assertEqual(_tool_search_setting({'tools': {'tool_search': False}}), 'off')
        self.assertEqual(_tool_search_setting({'tools': {'tool_search': {'enabled': False}}}), 'off')
        self.assertEqual(_tool_search_setting({'tools': {'tool_search': {'enabled': 'yes'}}}), 'on')
        self.assertEqual(_tool_search_setting({'tools': {'tool_search': {'enabled': 'nonsense'}}}), 'auto')


class SwitchTests(unittest.TestCase):
    """The switch in Studio changes config.yaml; an idle chat rebuilds and re-pins its tools."""

    def test_an_idle_chat_notices_the_switch_and_repins(self):
        import types
        import bridge_pool
        from bridge_pool import AgentPool

        pool = AgentPool()
        setting = {'value': 'off'}
        original_load = bridge_pool._load_cfg
        bridge_pool._load_cfg = lambda *_a, **_k: {'tools': {'tool_search': {'enabled': setting['value']}}}
        pinned = []
        fake_module = types.ModuleType('tools.mcp_tool_agent')
        fake_module.persist_agent_tool_names = lambda agent: pinned.append(agent)
        sys.modules.setdefault('tools', types.ModuleType('tools'))
        original_module = sys.modules.get('tools.mcp_tool_agent')
        sys.modules['tools.mcp_tool_agent'] = fake_module
        try:
            session = types.SimpleNamespace(config={'profile': 'default', 'tool_search': 'auto'})
            self.assertTrue(pool._tool_search_changed(session))
            session.config['tool_search'] = 'off'
            self.assertFalse(pool._tool_search_changed(session))
            agent = object()
            pool._repin_session_tools(agent)
            self.assertEqual(pinned, [agent])
        finally:
            bridge_pool._load_cfg = original_load
            if original_module is None:
                sys.modules.pop('tools.mcp_tool_agent', None)
            else:
                sys.modules['tools.mcp_tool_agent'] = original_module


if __name__ == '__main__':
    result = unittest.main(exit=False, verbosity=0).result
    if result.wasSuccessful():
        print('Hermes bridge tool load verified')
    sys.exit(0 if result.wasSuccessful() else 1)
