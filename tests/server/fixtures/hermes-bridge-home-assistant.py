"""Home Assistant actions in Studio's Hermes chats go through Hermes's approval gate."""
import sys
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / 'packages/server/src/modules/hermes/services/bridge/python'))
import bridge_pool
from bridge_home_assistant import home_assistant_action, home_assistant_servers
from bridge_pool import AgentPool

CONFIG = {'mcp_servers': {
    'home-assistant': {'url': 'http://ha.local:8123/api/mcp', 'headers': {}},
    'notes': {'command': 'node'},
}}


class ClassifyTests(unittest.TestCase):
    servers = home_assistant_servers(CONFIG['mcp_servers'])

    def test_finds_the_home_assistant_mcp_server(self):
        self.assertEqual(self.servers, ['home-assistant'])

    def test_plugin_reads_go_ahead(self):
        for tool in ('ha_list_entities', 'ha_get_state', 'ha_list_services'):
            self.assertIsNone(home_assistant_action(tool, {'entity_id': 'light.kitchen'}, self.servers))

    def test_plugin_service_call_asks_with_domain_and_service(self):
        action = home_assistant_action('ha_call_service', {'domain': 'light', 'service': 'turn_on', 'entity_id': 'light.bed_light'}, self.servers)
        self.assertEqual(action['value'], 'light.turn_on')
        self.assertEqual(action['kind'], 'tool')
        self.assertEqual(action['text'], 'Home Assistant: light.turn_on on light.bed_light')

    def test_mcp_read_tools_go_ahead(self):
        for tool in ('mcp__home_assistant__GetLiveContext', 'mcp__home_assistant__homeassistant__get_history', 'mcp_home_assistant_GetDateTime'):
            self.assertIsNone(home_assistant_action(tool, {}, self.servers), tool)

    def test_mcp_action_tools_ask(self):
        action = home_assistant_action('mcp__home_assistant__HassTurnOn', {'name': 'Kitchen light', 'domain': ['light']}, self.servers)
        self.assertEqual(action['value'], 'HassTurnOn')
        self.assertIn('Kitchen light', action['text'])
        call = home_assistant_action('mcp__home_assistant__homeassistant__call_action', {'domain': 'switch', 'action': 'turn_off'}, self.servers)
        self.assertEqual(call['value'], 'switch.turn_off')

    def test_other_tools_are_left_alone(self):
        self.assertIsNone(home_assistant_action('terminal', {'command': 'ls'}, self.servers))
        self.assertIsNone(home_assistant_action('mcp__notes__write', {}, self.servers))


class HookTests(unittest.TestCase):
    def setUp(self):
        self.pool = AgentPool()
        self.events = []
        patcher = patch.object(bridge_pool, '_load_cfg', lambda: CONFIG)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.pool._append_event = lambda session_id, event: self.events.append((session_id, event))

    def test_hook_escalates_service_calls_and_lets_reads_through(self):
        self.assertIsNone(self.pool._home_assistant_pre_tool_call(tool_name='ha_get_state', args={'entity_id': 'light.a'}, session_id='s1'))
        answer = self.pool._home_assistant_pre_tool_call(
            tool_name='ha_call_service', args={'domain': 'light', 'service': 'turn_on', 'entity_id': 'light.bed_light'}, session_id='s1')
        self.assertEqual(answer, {'action': 'approve', 'message': 'Home Assistant: light.turn_on on light.bed_light',
                                  'rule_key': 'homeassistant:light.turn_on'})

    def test_the_approval_event_names_the_service_for_trust_rules(self):
        self.pool._home_assistant_pre_tool_call(
            tool_name='ha_call_service', args={'domain': 'light', 'service': 'turn_on', 'entity_id': 'light.bed_light'}, session_id='s1')
        callback = self.pool._approval_callback('s1')
        answer = {}
        worker = threading.Thread(target=lambda: answer.update(choice=callback(
            '<ha_call_service> (plugin approval rule)', 'Home Assistant: light.turn_on on light.bed_light')))
        worker.start()
        deadline = time.monotonic() + 5
        while not self.pool._approval_requests and time.monotonic() < deadline:
            time.sleep(0.01)
        requested = self.events[0][1]
        self.assertEqual(requested['event'], 'approval.requested')
        self.assertEqual(requested['command'], 'Home Assistant: light.turn_on on light.bed_light')
        self.assertEqual(requested['trust_action'], {'kind': 'tool', 'value': 'light.turn_on'})
        next(iter(self.pool._approval_requests.values())).put('once')
        worker.join(5)
        self.assertEqual(answer['choice'], 'once')

    def test_ordinary_approvals_are_unchanged(self):
        fields = self.pool._approval_event_fields('s1', 'rm -rf old', 'recursive delete')
        self.assertEqual(fields, {'command': 'rm -rf old', 'description': 'recursive delete'})


if __name__ == '__main__':
    result = unittest.main(exit=False, verbosity=0).result
    if not result.wasSuccessful():
        sys.exit(1)
    print('Hermes bridge Home Assistant approvals verified')
