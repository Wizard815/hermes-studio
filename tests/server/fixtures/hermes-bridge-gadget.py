"""Gadget tools in Studio's Hermes chats reach devices through the gateway's desk folder."""
import json
import shutil
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / 'packages/server/src/modules/hermes/services/bridge/python'))
from bridge_gadget import needs_desk, offer_gadget_tools, studio_gadget_result
from bridge_pool import AgentPool

DEVICE = 'hg-0123456789abcdef'
HUB_ERROR = json.dumps({'success': False, 'error': 'gadget hub is not running in this process'})


class FakeGateway(threading.Thread):
    """What the Gadget plugin's gateway does with desk requests."""
    def __init__(self, data_dir: Path):
        super().__init__(daemon=True)
        self.data_dir, self.seen, self.stop = data_dir, [], False

    def run(self):
        inbox, done = self.data_dir / 'desk' / 'inbox', self.data_dir / 'desk' / 'done'
        while not self.stop:
            for path in list(inbox.glob('*.json')) if inbox.exists() else []:
                req = json.loads(path.read_text())
                self.seen.append(req)
                outcome = {'ok': True, 'held': False} if req['kind'] == 'card' else {'ok': True, 'result': {'face': req['args'].get('expression')}}
                done.mkdir(parents=True, exist_ok=True)
                (done / path.name).write_text(json.dumps(outcome))
                path.unlink()
            time.sleep(0.02)


class GadgetTests(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp(prefix='gadget-'))
        (self.dir / 'devices.json').write_text(json.dumps({'devices': {DEVICE: {'name': 'Kitchen DASH', 'board': 'esp32-s3'}}}))
        self.gateway = FakeGateway(self.dir)

    def tearDown(self):
        self.gateway.stop = True
        if self.gateway.is_alive():
            self.gateway.join(1)
        shutil.rmtree(self.dir, ignore_errors=True)

    def running(self):
        (self.dir / 'status.json').write_text(json.dumps({'running': True, 'updated_at': time.time(), 'devices': {DEVICE: {'online': True, 'name': 'Kitchen DASH'}}}))
        self.gateway.start()

    def test_only_hub_errors_are_rerouted(self):
        self.assertTrue(needs_desk('gadget_display', HUB_ERROR))
        self.assertFalse(needs_desk('gadget_display', json.dumps({'success': True})))
        self.assertFalse(needs_desk('terminal', HUB_ERROR))

    def test_display_shows_a_card_through_the_gateway(self):
        self.running()
        out = json.loads(studio_gadget_result('gadget_display', {'title': 'Dinner', 'text': 'Pasta at 7', 'items': ['salt', 'basil'], 'seconds': 30}, self.dir))
        self.assertEqual(out['success'], True)
        self.assertEqual(out['device'], 'Kitchen DASH')
        self.assertIn('as text', out['note'])
        self.assertEqual(self.gateway.seen[0], {**self.gateway.seen[0], 'device': DEVICE, 'kind': 'card', 'title': 'Dinner', 'text': 'Pasta at 7\n- salt\n- basil', 'seconds': 30})

    def test_action_by_device_name(self):
        self.running()
        out = json.loads(studio_gadget_result('gadget_action', {'device': 'kitchen dash', 'action': 'face.set', 'args': {'expression': 'happy'}}, self.dir))
        self.assertEqual(out, {'success': True, 'device': 'Kitchen DASH', 'action': 'face.set', 'result': {'face': 'happy'}})

    def test_devices_lists_connected_and_says_what_works(self):
        self.running()
        out = json.loads(studio_gadget_result('gadget_devices', {}, self.dir))
        self.assertEqual([d['name'] for d in out['connected']], ['Kitchen DASH'])
        self.assertIn('gadget_display', out['note'])

    def test_gateway_down_says_what_to_do(self):
        out = json.loads(studio_gadget_result('gadget_display', {'text': 'hi'}, self.dir))
        self.assertFalse(out['success'])
        self.assertIn('Restart gateway', out['error'])

    def test_tools_that_need_the_gateway_chat_say_so(self):
        self.running()
        out = json.loads(studio_gadget_result('gadget_ask', {'question': 'Tea?', 'options': ['yes', 'no']}, self.dir))
        self.assertIn('only works in chats the Hermes gateway runs', out['error'])

    def test_tools_are_offered_while_the_gateway_runs(self):
        class Entry:
            def __init__(self, name):
                self.name, self.check_fn = name, (lambda: False)

        class Registry:
            def __init__(self):
                self.entries = [Entry('gadget_display'), Entry('gadget_action'), Entry('terminal')]

            def get_all_entries(self):
                return list(self.entries)

        reg = Registry()
        self.assertEqual(offer_gadget_tools(reg, self.dir), 2)
        self.assertEqual(offer_gadget_tools(reg, self.dir), 0)  # wrapped once
        display, _, terminal = reg.entries
        self.assertFalse(display.check_fn())  # gateway not running yet
        self.assertFalse(terminal.check_fn())  # other tools untouched
        self.running()
        self.assertTrue(display.check_fn())

    def test_the_bridge_hook_replaces_the_hub_error(self):
        self.running()
        import bridge_gadget
        original = bridge_gadget.gadget_data_dir
        bridge_gadget.gadget_data_dir = lambda: self.dir
        try:
            pool = AgentPool()
            replaced = pool._gadget_tool_result(tool_name='gadget_display', args={'text': 'hello'}, result=HUB_ERROR)
            self.assertEqual(json.loads(replaced)['success'], True)
            self.assertIsNone(pool._gadget_tool_result(tool_name='gadget_display', args={}, result='{"success": true}'))
        finally:
            bridge_gadget.gadget_data_dir = original


if __name__ == '__main__':
    result = unittest.main(exit=False, verbosity=0).result
    if not result.wasSuccessful():
        sys.exit(1)
    print('Hermes bridge Gadget tools verified')
