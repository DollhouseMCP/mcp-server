"""Atomic local transition-state controls; no Docker or host actions."""
import json
from pathlib import Path
import sys
import tempfile
import unittest

SCRIPTS = Path(__file__).resolve().parents[2] / 'scripts'
sys.path.insert(0, str(SCRIPTS / 'hosted-deploy'))
sys.path.insert(0, str(SCRIPTS))
import caddy_transition_state as state
import test_hosted_caddy_hardened_profile as fixtures


def pending(root, kind='update'):
    source = {'sha256': 'a' * 64, 'entries': 2, 'bytes': 3}
    _, _, admission, _ = fixtures.hardened()
    return {'kind': kind, 'token': 'b' * 32,
            'image': admission['reference'],
            'volumes': ['fixture_data', 'fixture_config'],
            'previous': str(root / ('server.prev-' + 'd' * 32)) if kind != 'fresh' else None,
            'receipt': str(root / '.caddy-recovery' / ('proxy-' + 'e' * 32)) if kind != 'fresh' else None,
            'receipt_sha256': 'f' * 64 if kind != 'fresh' else None,
            'source': source if kind != 'fresh' else None, 'staged_source': None,
            'phase': 'admitted', 'admission': admission}


class TransitionStateTests(unittest.TestCase):
    def test_pending_preserves_completed_until_verified_finish(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            first = pending(root)
            state.begin(root, first)
            self.assertIsNone(state.read_state(root)['completed'])
            with self.assertRaises(ValueError):
                state.begin(root, pending(root))
            state.mark_staged(root, first['token'], {'sha256': '1' * 64, 'entries': 1, 'bytes': 1})
            completed = state.finish(root, first['token'])['completed']
            self.assertEqual(completed['previous'], first['previous'])
            second = pending(root)
            second['token'] = '2' * 32
            second['previous'] = str(root / ('server.prev-' + '3' * 32))
            state.begin(root, second)
            self.assertEqual(state.read_state(root)['completed'], completed)
            self.assertEqual((root / '.caddy-state/state.json').stat().st_mode & 0o777, 0o600)

    def test_missing_or_ambiguous_state_fails_closed(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            state.begin(root, pending(root, 'fresh'))
            with self.assertRaises(ValueError):
                state.finish(root, 'b' * 32)
            (root / '.caddy-state/.orphan.pending').write_text('fixture')
            with self.assertRaises(ValueError):
                state.read_state(root)

    def test_admission_required_before_stage_and_bound_to_qualified_content(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            value = pending(root, 'fresh')
            admission = value['admission']
            value['phase'] = 'prepared'
            value['admission'] = None
            state.begin(root, value)
            identity = {'sha256': '1' * 64, 'entries': 1, 'bytes': 1}
            with self.assertRaises(ValueError):
                state.mark_staged(root, value['token'], identity)
            wrong = dict(admission, config_digest='sha256:' + '0' * 64)
            with self.assertRaises(ValueError):
                state.bind_admission(root, value['token'], wrong)
            state.bind_admission(root, value['token'], admission)
            state.bind_admission(root, value['token'], admission)
            state.mark_staged(root, value['token'], identity)
            self.assertEqual(state.read_state(root)['pending']['phase'], 'staged')

    def test_outside_path_and_bool_integer_refuse(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            value = pending(root)
            value['previous'] = '/tmp/server.prev-' + 'd' * 32
            with self.assertRaises(ValueError):
                state.begin(root, value)
            value = pending(root)
            value['source']['entries'] = True
            with self.assertRaises(ValueError):
                state.begin(root, value)


if __name__ == '__main__':
    unittest.main()
