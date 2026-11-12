"""Private state and consumption records only; no host, Docker or service is touched."""
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts' / 'hosted-deploy'))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from caddy_transition_state import begin, read_state
import legacy_control_resolution as resolution
import legacy_handoff as handoff
import legacy_update_return as returning
import test_hosted_caddy_control_resolution as fixture

IMAGE = 'registry.example/caddy@sha256:' + 'a' * 64
SECOND, THIRD = '3' * 32, '6' * 32


class ReturnTests(unittest.TestCase):
    """A reconciled failed transition, then the real beginning of an update that consumes the reconciliation."""

    def setUp(self):
        base = fixture.ControlResolutionTests('test_qualified_disposition_does_not_clear_original_failed_controls')
        base.setUp()
        self.addCleanup(base.doCleanups)
        self.root, self.token, self.operation, self.previous = base.root, base.token, base.operation, base.previous
        self.source, self.record, self.put = base.source, base.record, base.put
        # The update has only begun: the previous source is reserved, not staged.
        (self.previous / 'version').unlink()
        self.previous.rmdir()
        (self.root / '.legacy-recovery').chmod(0o700)
        self.state = {'schema': 'caddy-transition-v1', 'completed': None, 'pending': self.transition(self.token, ['old-data', 'old-config'])}
        # Not the encoding write_state would produce: the return must restore bytes, never re-encode a value.
        self.raw = json.dumps(self.state, indent=1).encode() + b'\n'
        self.put(self.root / '.caddy-state' / 'state.json', self.raw)
        self.record.update(failed_state=self.state, failed_state_sha256=handoff.digest(self.raw))
        self.write_record = base.write_record
        self.write_record()
        self.value = {'deploy_dir': str(self.root), 'instance': 'site', 'data_volume': 'new-data', 'config_volume': 'new-config'}
        self.begin(SECOND)

    def transition(self, token, volumes):
        return {'kind': 'update', 'token': token, 'image': IMAGE, 'volumes': volumes, 'previous': str(self.previous),
                'receipt': str(self.root / '.caddy-recovery' / ('proxy-' + '5' * 32)), 'receipt_sha256': '4' * 64,
                'source': self.source, 'staged_source': None, 'phase': 'prepared', 'admission': None, 'control': None}

    def begin(self, token):
        begin(self.root, self.transition(token, ['new-data', 'new-config']))
        self.begun = resolution.raw_state(self.root)

    def consume(self, token, suffix):
        return self.operation / ('consume-' + token + suffix)

    def returned(self):
        return returning.return_update(self.root, self.value)

    def refused(self, message, error=ValueError):
        """A refusal changes nothing: the state stays, and no return record is written."""
        before = sorted(path.name for path in self.operation.iterdir())
        with self.assertRaisesRegex(error, message):
            self.returned()
        self.assertEqual(resolution.raw_state(self.root), self.begun)
        self.assertEqual(sorted(path.name for path in self.operation.iterdir()), before)

    def test_the_begun_update_blocks_everything_until_it_is_returned(self):
        state = read_state(self.root)
        self.assertEqual(resolution.unresolved_pending(self.root, state)['token'], SECOND)
        result = self.returned()
        self.assertEqual((result['outcome'], result['returned_token'], result['resolved_token']), ('RETURNED', SECOND, self.token))
        # Byte for byte the preserved state, and the reconciliation resolves it again.
        self.assertEqual(resolution.raw_state(self.root), self.raw)
        self.assertEqual(result['restored_state_sha256'], handoff.digest(self.raw))
        state = read_state(self.root)
        self.assertIsNone(resolution.unresolved_pending(self.root, state))
        self.assertEqual(resolution.lookup(self.root, state)[0], self.record)
        self.assertEqual(sorted(path.name for path in self.operation.iterdir() if path.name.startswith('consume-')),
                         sorted('consume-' + SECOND + suffix for suffix in resolution.CONSUMPTION + resolution.RETURN))
        self.assertEqual(self.consume(SECOND, '-removed-state.json').read_bytes(), self.begun)
        self.assertEqual(self.consume(SECOND, '-return-issued.json').read_bytes(), Path(result['receipt']).read_bytes())
        self.assertEqual({path.stat().st_mode & 0o777 for path in self.operation.iterdir()}, {0o600})
        self.assertEqual(sorted(path.name for path in (self.root / '.caddy-state').iterdir()), ['state.json'])

    def test_a_second_attempt_consumes_the_reconciliation_again_and_can_itself_be_returned(self):
        self.returned()
        self.begin(THIRD)
        self.assertEqual(read_state(self.root)['pending']['token'], THIRD)
        self.assertTrue(self.consume(THIRD, '-completed.json').exists())
        result = self.returned()
        self.assertEqual(result['returned_token'], THIRD)
        self.assertEqual(resolution.raw_state(self.root), self.raw)
        self.assertIsNotNone(resolution.lookup(self.root, read_state(self.root)))

    def test_only_an_update_in_its_first_phase_is_unused(self):
        pending = self.transition(SECOND, ['new-data', 'new-config'])
        self.assertEqual(returning.unused(pending, self.value), SECOND)
        for name, change in (('admitted', {'phase': 'admitted', 'admission': {'reference': IMAGE}}),
                             ('staged', {'phase': 'staged', 'staged_source': self.source}),
                             ('under verification', {'control': {'phase': 'prepared'}}),
                             ('a rollback', {'kind': 'rollback'}), ('a first install', {'kind': 'fresh'})):
            with self.subTest(name):
                with self.assertRaisesRegex(ValueError, 'not an update in its first phase'):
                    returning.unused({**pending, **change}, self.value)
        with self.assertRaisesRegex(ValueError, 'not an update in its first phase'):
            returning.unused(None, self.value)
        with self.assertRaisesRegex(ValueError, 'names other volumes'):
            returning.unused(pending, dict(self.value, data_volume='other-data'))
        # The same refusal through the action, with the state as the tooling would have written it.
        with patch.object(returning, 'read_state', return_value={'pending': {**pending, 'control': {'phase': 'prepared'}}}):
            self.refused('not an update in its first phase')

    def test_an_armed_baseline_or_a_forward_write_refuses(self):
        window = self.root / '.legacy-recovery' / ('window-' + SECOND)
        window.mkdir(mode=0o700)
        for name in ('armed.json', 'forward-write-issued.json'):
            with self.subTest(name):
                self.put(window / name, b'{}')
                self.refused('recovery baseline is armed')
                (window / name).unlink()
        # A window folder that arming created and never completed is not a baseline.
        self.put(window / 'compose.yml', b'partial capture')
        self.assertEqual(self.returned()['outcome'], 'RETURNED')

    def test_a_legacy_stop_intent_refuses(self):
        (self.root / '.legacy-handoff' / ('window-' + SECOND)).mkdir()
        self.refused('legacy stop was issued')

    def test_a_staged_previous_source_refuses(self):
        self.previous.mkdir()
        self.refused('previous source was staged')

    def test_a_changed_source_or_configuration_file_refuses(self):
        (self.root / 'server' / 'version').write_text('rendered')
        self.refused('serving source differs')
        (self.root / 'server' / 'version').write_text('qualified-original')
        original = (self.root / 'compose.yml').read_bytes()
        (self.root / 'compose.yml').write_bytes(b'rendered')
        self.refused('reconciled configuration changed')
        (self.root / 'compose.yml').write_bytes(original)
        (self.root / 'bootstrap-admin.sh').unlink()
        self.refused('reconciled configuration disappeared')

    def test_an_incomplete_consumption_record_refuses(self):
        for suffix in resolution.CONSUMPTION:
            with self.subTest(suffix):
                raw = self.consume(SECOND, suffix).read_bytes()
                self.consume(SECOND, suffix).unlink()
                self.refused('consumption records are incomplete')
                self.put(self.consume(SECOND, suffix), raw)
        (self.root / '.legacy-recovery' / ('lineage-' + SECOND + '.json')).unlink()
        self.refused('consumed no reconciliation')

    def test_a_broken_hash_chain_refuses(self):
        def rewrite(suffix, change):
            path = self.consume(SECOND, suffix)
            value = json.loads(path.read_bytes())
            change(value)
            self.put(path, handoff.encoded(value))

        cases = (
            ('issued record changed', '-issued.json', lambda value: value.update(old_token='9' * 32), 'digest changed'),
            ('completed differs from issued', '-completed.json', lambda value: value.update(old_token='9' * 32), 'digest changed'),
        )
        for name, suffix, change, message in cases:
            with self.subTest(name):
                raw = self.consume(SECOND, suffix).read_bytes()
                rewrite(suffix, change)
                self.refused(message)
                self.put(self.consume(SECOND, suffix), raw)
        with self.subTest('preserved state changed'):
            raw = self.consume(SECOND, '-failed-state.json').read_bytes()
            self.put(self.consume(SECOND, '-failed-state.json'), raw + b' ')
            self.refused('do not bind this transition and the reconciled state')
            self.put(self.consume(SECOND, '-failed-state.json'), raw)
        with self.subTest('lineage names another consumption'):
            lineage = self.root / '.legacy-recovery' / ('lineage-' + SECOND + '.json')
            self.put(lineage, handoff.encoded({'old_token': self.token, 'consumption_sha256': 'f' * 64}))
            self.refused('digest changed')
        with self.subTest('reconciliation record changed'):
            self.record['instance'] = 'other'
            self.write_record()
            self.put(lineage, handoff.encoded({'old_token': self.token, 'consumption_sha256': handoff.digest(
                self.consume(SECOND, '-issued.json').read_bytes())}))
            self.refused('qualified retirement authority differs')

    def test_a_second_return_refuses(self):
        self.returned()
        self.begun = self.raw
        # The restored transition is not the one that was returned, and it consumed nothing itself.
        self.refused('names other volumes')
        new = self.value
        self.value = dict(new, data_volume='old-data', config_volume='old-config')
        self.refused('consumed no reconciliation')
        self.value = new
        # Even with the returned transition put back by hand, its return was issued once.
        self.put(self.root / '.caddy-state' / 'state.json', self.consume(SECOND, '-removed-state.json').read_bytes())
        self.begun = resolution.raw_state(self.root)
        self.refused('a return was already issued')

    def test_a_restore_that_does_not_match_the_preserved_state_is_unknown_and_stays_refused(self):
        def wrong(root, raw):
            self.put(root / '.caddy-state' / 'state.json', raw + b' ')

        with patch.object(returning, 'restore_state', side_effect=wrong):
            with self.assertRaisesRegex(ValueError, 'the return is UNKNOWN'):
                self.returned()
        self.assertFalse(self.consume(SECOND, '-return-completed.json').exists())
        self.put(self.root / '.caddy-state' / 'state.json', self.raw)
        with self.assertRaisesRegex(ValueError, 'already issued or is UNKNOWN'):
            resolution.lookup(self.root, read_state(self.root))

    # The gate ------------------------------------------------------------------------------------------------------

    def gate(self):
        return resolution.lookup(self.root, read_state(self.root))

    def test_the_gate_accepts_only_a_whole_verified_return(self):
        self.returned()
        self.assertIsNotNone(self.gate())
        for suffix in resolution.CONSUMPTION + resolution.RETURN:
            with self.subTest(missing=suffix):
                raw = self.consume(SECOND, suffix).read_bytes()
                self.consume(SECOND, suffix).unlink()
                with self.assertRaisesRegex(ValueError, 'already issued or is UNKNOWN'):
                    self.gate()
                self.put(self.consume(SECOND, suffix), raw)
        for suffix in resolution.CONSUMPTION + resolution.RETURN:
            with self.subTest(changed=suffix):
                raw = self.consume(SECOND, suffix).read_bytes()
                self.put(self.consume(SECOND, suffix), raw.replace(b'}', b' }', 1) if raw.count(b'}') else raw + b' ')
                with self.assertRaisesRegex(ValueError, 'already issued or is UNKNOWN'):
                    self.gate()
                self.put(self.consume(SECOND, suffix), raw)
        self.assertIsNotNone(self.gate())

    def test_the_gate_refuses_a_return_record_with_no_matching_consumption(self):
        self.returned()
        other = '7' * 32
        for suffix in resolution.RETURN:
            self.put(self.consume(other, suffix), self.consume(SECOND, suffix).read_bytes())
        with self.assertRaisesRegex(ValueError, 'already issued or is UNKNOWN'):
            self.gate()
        for suffix in resolution.CONSUMPTION:
            # Even with consumption files copied in, the records bind another token.
            self.put(self.consume(other, suffix), self.consume(SECOND, suffix).read_bytes())
        with self.assertRaisesRegex(ValueError, 'already issued or is UNKNOWN'):
            self.gate()
        for path in self.operation.glob('consume-' + other + '*'):
            path.unlink()
        self.assertIsNotNone(self.gate())
        self.put(self.operation / 'consume-unknown', b'{}')
        with self.assertRaisesRegex(ValueError, 'already issued or is UNKNOWN'):
            self.gate()

    def test_a_return_that_names_another_reconciliation_or_state_is_refused_by_the_gate(self):
        self.returned()
        for field, value in (('resolution_sha256', 'f' * 64), ('old_token', '9' * 32), ('token', '8' * 32),
                             ('consumption_sha256', 'f' * 64), ('removed_state_sha256', 'f' * 64),
                             ('restored_state_sha256', 'f' * 64), ('schema', 'other'), ('host', {'hostname': 'other'})):
            with self.subTest(field):
                saved = {suffix: self.consume(SECOND, suffix).read_bytes() for suffix in ('-return-issued.json', '-return-completed.json')}
                changed = handoff.encoded({**json.loads(saved['-return-issued.json']), field: value})
                for suffix in saved:
                    self.put(self.consume(SECOND, suffix), changed)
                with self.assertRaisesRegex(ValueError, 'already issued or is UNKNOWN'):
                    self.gate()
                for suffix, raw in saved.items():
                    self.put(self.consume(SECOND, suffix), raw)
        self.assertIsNotNone(self.gate())

    def test_a_consumption_without_a_return_is_still_single_use(self):
        # The old state put back by hand, without a return, resolves nothing.
        self.put(self.root / '.caddy-state' / 'state.json', self.raw)
        with self.assertRaisesRegex(ValueError, 'already issued or is UNKNOWN'):
            self.gate()
        with self.assertRaisesRegex(ValueError, 'already issued or is UNKNOWN'):
            begin(self.root, self.transition(THIRD, ['new-data', 'new-config']))


if __name__ == '__main__':
    unittest.main()
