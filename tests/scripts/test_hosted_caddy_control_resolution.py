"""Private disposition/consumption records only; no host/Docker qualification."""
import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts' / 'hosted-deploy'))
import legacy_control_resolution as resolution
import legacy_handoff as handoff


class ControlResolutionTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name).resolve()
        self.host = {'hostname': 'fixture', 'machine_id_sha256': 'c' * 64}
        binding = patch.object(handoff, 'host_identity', return_value=self.host)
        binding.start()
        self.addCleanup(binding.stop)
        self.token = '1' * 32
        self.operation = resolution.operation_path(self.root, self.token)
        self.operation.mkdir(parents=True, mode=0o700)
        self.operation.parent.chmod(0o700)
        for name in ('.caddy-state', '.legacy-handoff', 'server'):
            (self.root / name).mkdir(mode=0o700)
        (self.root / 'server' / 'version').write_text('qualified-original')
        self.source = resolution.bundle_identity(self.root / 'server')
        self.previous = self.root / ('server.prev-' + '2' * 32)
        self.previous.mkdir()
        (self.previous / 'version').write_text('qualified-original')
        files = {}
        for name in resolution.FILES:
            p = self.root / name
            p.write_bytes(('original-' + name).encode())
            p.chmod(0o600 if name in ('.env', '.env.production', 'compose.yml') else 0o644)
            raw, mode = resolution.read_configuration(self.root, name)
            files[name] = {'sha256': handoff.digest(raw), 'mode': mode, 'bytes': len(raw)}
        self.state = {'pending': {'token': self.token, 'kind': 'update', 'control': {'phase': 'probed'}}, 'completed': None}
        self.raw = handoff.encoded(self.state)
        self.put(self.root / '.caddy-state' / 'state.json', self.raw)
        hashes = {}
        for name in ('issued.json', 'receipt.json'):
            p = self.root / '.legacy-handoff' / name
            self.put(p, b'fixture-completed-handoff')
            hashes[name] = handoff.digest(p.read_bytes())
        hashes['stop-acknowledged.json'] = None  # The accepted older manual recovery predates this receipt.
        authority = {'schema': 'qualified-proxy-retirement-v1', 'host': self.host, 'instance': 'site'}
        self.put(self.operation / 'retirement-authority.json', handoff.encoded(authority))
        self.record = {'schema': 'legacy-controls-reconciled-v1', 'token': self.token, 'host': self.host,
                       'instance': 'site', 'implementation': resolution.bundle_identity(resolution.IMPLEMENTATION),
                       'source': self.source, 'files': files, 'handoff': hashes, 'handoff_directory': '.legacy-handoff',
                       'failed_state': self.state, 'failed_state_sha256': handoff.digest(self.raw),
                       'retirement_authority_sha256': handoff.digest(handoff.encoded(authority))}
        self.write_record()
        self.next = {'kind': 'update', 'token': '3' * 32, 'image': 'fixture-image', 'volumes': ['new-data', 'new-config'],
                     'previous': str(self.previous), 'receipt': 'fixture-receipt', 'receipt_sha256': '4' * 64,
                     'source': self.source}

    def put(self, path, raw):
        path.write_bytes(raw)
        path.chmod(0o600)

    def write_record(self):
        self.put(self.operation / 'RECONCILED.json', handoff.encoded(self.record))

    def test_qualified_disposition_does_not_clear_original_failed_controls(self):
        self.assertIsNotNone(resolution.lookup(self.root, self.state))
        self.assertIsNone(resolution.unresolved_pending(self.root, self.state))
        self.assertEqual(resolution.raw_state(self.root), self.raw)
        self.assertEqual(self.state['pending']['control']['phase'], 'probed')

    def test_consumption_retains_raw_state_and_binds_new_transition_and_handoff_lineage(self):
        issued = resolution.issue_consumption(self.root, self.state, self.next)
        with self.assertRaisesRegex(ValueError, 'already issued or is UNKNOWN'):
            resolution.issue_consumption(self.root, self.state, self.next)
        new_state = {**self.state, 'pending': self.next}
        self.put(self.root / '.caddy-state' / 'state.json', handoff.encoded(new_state))
        resolution.complete_consumption(issued, self.root)
        result = resolution.consumed(self.root, new_state, self.next['token'])
        self.assertEqual(result, self.record)
        self.assertEqual((self.operation / ('consume-' + self.next['token'] + '-failed-state.json')).read_bytes(), self.raw)
        self.assertEqual((self.root / '.legacy-handoff' / 'issued.json').read_bytes(), b'fixture-completed-handoff')
        self.assertEqual((self.root / '.legacy-handoff' / 'receipt.json').read_bytes(), b'fixture-completed-handoff')

    def test_issued_but_unacknowledged_consumption_never_becomes_success_from_current_state(self):
        resolution.issue_consumption(self.root, self.state, self.next)
        new_state = {**self.state, 'pending': self.next}
        self.put(self.root / '.caddy-state' / 'state.json', handoff.encoded(new_state))
        with self.assertRaises(FileNotFoundError):
            resolution.consumed(self.root, new_state, self.next['token'])

    def test_changed_root_files_source_state_or_historical_handoff_refuses(self):
        original = (self.root / 'Caddyfile').read_bytes()
        (self.root / 'Caddyfile').write_text('changed')
        with self.assertRaisesRegex(ValueError, 'configuration changed'):
            resolution.lookup(self.root, self.state)
        (self.root / 'Caddyfile').write_bytes(original)
        (self.root / 'server' / 'version').write_text('other-source')
        with self.assertRaisesRegex(ValueError, 'source or failed controls changed'):
            resolution.lookup(self.root, self.state)
        (self.root / 'server' / 'version').write_text('qualified-original')
        self.put(self.root / '.caddy-state' / 'state.json', self.raw + b' ')
        with self.assertRaisesRegex(ValueError, 'source or failed controls changed'):
            resolution.lookup(self.root, self.state)
        self.put(self.root / '.caddy-state' / 'state.json', self.raw)
        self.put(self.root / '.legacy-handoff' / 'receipt.json', b'changed')
        with self.assertRaisesRegex(ValueError, 'historical handoff evidence changed'):
            resolution.lookup(self.root, self.state)

    def test_new_source_or_changed_next_core_cannot_consume_old_disposition(self):
        different = {**self.next, 'source': {**self.source, 'sha256': '9' * 64}}
        with self.assertRaisesRegex(ValueError, 'qualified legacy source'):
            resolution.issue_consumption(self.root, self.state, different)
        issued = resolution.issue_consumption(self.root, self.state, self.next)
        state = {'pending': copy.deepcopy(self.next)}
        resolution.complete_consumption(issued, self.root)
        state['pending']['volumes'] = ['other-data', 'other-config']
        with self.assertRaisesRegex(ValueError, 'lineage differs'):
            resolution.consumed(self.root, state, self.next['token'])


if __name__ == '__main__':
    unittest.main()
