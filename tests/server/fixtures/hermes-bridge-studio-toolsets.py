"""Studio tools called by their own name in a Hermes chat reach their toolset."""
import json
import sys
import types
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / 'packages/server/src/modules/hermes/services/bridge/python'))
from bridge_studio_toolsets import install_studio_toolset_routing, route_studio_toolset_call, toolset_target

USE = 'mcp__ekko_studio_use__ekko_studio_use_toolset'
BROWSER = 'mcp__ekko_studio_browser__ekko_studio_browser_toolset'


class Call:
    def __init__(self, name, arguments):
        self.function = types.SimpleNamespace(name=name, arguments=arguments)


class Agent:
    def __init__(self, names):
        self.valid_tool_names = set(names)
        self.log_prefix = ''
        self.printed = []

    def _vprint(self, text, **_):
        self.printed.append(text)


class RoutingTests(unittest.TestCase):
    def test_bare_catalog_name_becomes_toolset_call(self):
        agent = Agent([USE, 'terminal'])
        board_args = {'action': 'create', 'arguments': {'title': 'Garden plan', 'agent': 'Hermes'}}
        call = Call('ekko_studio_use_orb_board', json.dumps(board_args))
        self.assertTrue(route_studio_toolset_call(agent, call))
        self.assertEqual(call.function.name, USE)
        self.assertEqual(json.loads(call.function.arguments), {'action': 'call', 'tool': 'ekko_studio_use_orb_board', 'arguments': board_args})

    def test_prefixed_legacy_and_dict_arguments(self):
        agent = Agent([USE, BROWSER])
        call = Call('mcp__ekko_studio_use__ekko_studio_use_phone', {'action': 'screen'})
        self.assertTrue(route_studio_toolset_call(agent, call))
        self.assertEqual(json.loads(call.function.arguments)['tool'], 'ekko_studio_use_phone')
        self.assertEqual(toolset_target('hermes_studio_use_orb_read', agent.valid_tool_names), (USE, 'ekko_studio_use_orb_read'))
        self.assertEqual(toolset_target('ekko_studio_browser_tab_list', agent.valid_tool_names), (BROWSER, 'ekko_studio_browser_tab_list'))

    def test_toolset_without_prefix_keeps_its_arguments(self):
        agent = Agent([USE])
        call = Call('ekko_studio_use_toolset', '{"action": "list", "query": "orb"}')
        self.assertTrue(route_studio_toolset_call(agent, call))
        self.assertEqual((call.function.name, json.loads(call.function.arguments)), (USE, {'action': 'list', 'query': 'orb'}))

    def test_left_alone(self):
        self.assertIsNone(toolset_target('ekko_studio_use_orb_board', {'terminal'}))  # toolset not in this chat
        self.assertIsNone(toolset_target('web_search', {USE}))
        self.assertIsNone(toolset_target(USE, {USE}))  # already valid
        call = Call('ekko_studio_use_orb_board', '{not json')
        self.assertFalse(route_studio_toolset_call(Agent([USE]), call))
        self.assertEqual(call.function.name, 'ekko_studio_use_orb_board')

    def test_install_extends_hermes_deferred_routing_once(self):
        validation = types.ModuleType('agent.turn_tool_validation')
        seen = []

        def deferred(agent, tc):
            seen.append(tc.function.name)
            return tc.function.name == 'deferred_tool'

        validation._route_deferred_call = deferred
        package = types.ModuleType('agent')
        package.turn_tool_validation = validation
        sys.modules['agent'], sys.modules['agent.turn_tool_validation'] = package, validation
        try:
            self.assertTrue(install_studio_toolset_routing())
            self.assertTrue(install_studio_toolset_routing())
            routed = validation._route_deferred_call
            self.assertIs(routed._studio_original, deferred)
            agent = Agent([USE])
            self.assertTrue(routed(agent, Call('deferred_tool', '{}')))
            call = Call('ekko_studio_use_orb_board', '{}')
            self.assertTrue(routed(agent, call))
            self.assertEqual(call.function.name, USE)
            self.assertFalse(routed(agent, Call('nonexistent_tool', '{}')))
        finally:
            sys.modules.pop('agent', None)
            sys.modules.pop('agent.turn_tool_validation', None)


if __name__ == '__main__':
    result = unittest.main(exit=False, verbosity=0).result
    if result.wasSuccessful():
        print('Hermes bridge Studio toolsets verified')
    sys.exit(0 if result.wasSuccessful() else 1)
