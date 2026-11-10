"""Disposable in-memory Docker/backup fixtures only; never qualifies a live handoff."""
import copy
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[2] / 'scripts'
sys.path.insert(0, str(SCRIPTS / 'hosted-deploy'))
sys.path.insert(0, str(SCRIPTS))
import legacy_handoff as handoff

APP, PG = 'a' * 64, 'b' * 64
HOST = {'hostname': 'fixture-host', 'machine_id_sha256': 'c' * 64}


class HandoffTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.check = self.root / 'checkpoint'
        self.check.mkdir(mode=0o700)
        (self.root / 'portfolio').mkdir()
        self.image = {'Id': handoff.LEGACY_IMAGE, 'Os': 'linux', 'Architecture': 'amd64',
                      'Config': {'Cmd': ['node', 'fixture.js']}, 'RootFS': {'Layers': ['sha256:' + 'd' * 64]}}
        self.app = {'Id': APP, 'Name': '/site', 'Image': handoff.LEGACY_IMAGE, 'RestartCount': 0,
                    'Config': {'Cmd': ['node', 'fixture.js'], 'Labels': {'com.docker.compose.project': 'site', 'com.docker.compose.service': 'dollhousemcp'}},
                    'HostConfig': {'Privileged': False, 'NetworkMode': 'site_default'},
                    'State': {'Running': True, 'Restarting': False, 'OOMKilled': False, 'Health': {'Status': 'healthy'}, 'StartedAt': '2026-01-01T00:00:00Z'},
                    'Mounts': [{'Type': 'bind', 'RW': True, 'Source': str(self.root / 'portfolio'), 'Destination': '/home/dollhouse/.dollhouse'}]}
        self.pg = {'Id': PG, 'Image': 'sha256:' + 'e' * 64, 'RestartCount': 0,
                   'State': {'Running': True, 'Restarting': False, 'OOMKilled': False, 'Health': {'Status': 'healthy'}, 'StartedAt': '2026-01-01T00:00:00Z'}, 'Mounts': []}
        self.calls = []
        self.stop_error = False
        self.exit_code = 0
        self.mutate_boot = False
        self.other = []
        self.value = {'deploy_dir': str(self.root), 'instance': 'site', 'data_volume': 'data', 'config_volume': 'config',
                      'token': 'f' * 32, 'checkpoint_dir': str(self.check), 'app_id': APP, 'postgres_id': PG}
        self.fence = {'token': 'f' * 32, 'proxy': {'id': '1' * 64}, 'source': {'sha256': '2' * 64}}
        self.source_rows = [{'kind': 'ledger', 'hashes': [f'{n:064x}' for n in range(62)]},
                            {'kind': 'table', 'schema': 'public', 'table': 'fixture', 'count': 3}]
        self.request = {'schema': 1, 'kind': 'legacy-offline-checkpoint',
                        'app': {'id': APP, 'image_id': handoff.LEGACY_IMAGE, 'started_at': '2026-01-01T00:00:00Z', 'restart_count': 0},
                        'snapshot': handoff.MISSING_SNAPSHOT, 'accepted_boundary': handoff.BOUNDARY}
        self.rebuild()
        self.addCleanup(patch.stopall)
        patch.object(handoff, 'host_identity', return_value=HOST).start()
        patch.object(handoff, 'IMAGE_CONFIG_SHA', handoff.digest(handoff.encoded({k: self.image['Config'].get(k) for k in handoff.IMAGE_FIELDS}))).start()
        patch.object(handoff, 'IMAGE_LAYERS_SHA', handoff.digest(handoff.encoded(self.image['RootFS']['Layers']))).start()

    def write(self, name, value):
        raw = handoff.encoded(value) if isinstance(value, dict) else value
        p = self.check / name
        p.write_bytes(raw)
        p.chmod(0o600)
        return {'sha256': handoff.digest(raw), 'bytes': len(raw)}

    def rebuild(self, restored=None):
        raw = b'\n'.join(handoff.encoded(row) for row in self.source_rows) + b'\n'
        restored_raw = raw if restored is None else b'\n'.join(handoff.encoded(row) for row in restored) + b'\n'
        artifacts = {name: self.write(name, data) for name, data in [('database.dump', b'fixture-dump'), ('globals.sql', b'fixture-globals'), ('observation.jsonl', raw)]}
        manifest = {'schema': 1, 'kind': 'exported-snapshot-database-backup', 'source_host': HOST,
                    'snapshot_holder_commit': 'confirmed', 'artifacts': artifacts,
                    'source_database': {'health': 'healthy', 'id': PG, 'image_id': 'sha256:' + 'e' * 64, 'started_at': '2026-01-01T00:00:00Z', 'restart_count': 0, 'mounts': []}}
        manifest_meta = self.write('manifest.json', manifest)
        vm = {'schema': 1, 'kind': 'vm-offhost-copy', 'source_manifest_sha256': manifest_meta['sha256'],
              'machine_id_sha256': '9' * 64, 'destination': '/fixture-backup', 'artifacts': {**artifacts, 'manifest.json': manifest_meta}}
        vm_meta = self.write('vm-receipt.json', vm)
        restored_meta = self.write('restored-observation.jsonl', restored_raw)
        proof = {'container_id': '4' * 64, 'volume': 'disposable-pgdata', 'network': 'none', 'schema': 1, 'kind': 'database-restore-proof', 'status': 'passed', 'row_counts_equal': True, 'migration_hashes_equal': True,
                 'source_host': HOST, 'source_dump_sha256': artifacts['database.dump']['sha256'], 'source_manifest_sha256': manifest_meta['sha256'],
                 'vm_receipt_sha256': vm_meta['sha256'], 'source_observation_sha256': artifacts['observation.jsonl']['sha256'],
                 'restored_observation_sha256': restored_meta['sha256'], 'ledger_count': 62, 'table_count': 1}
        proof_meta = self.write('restore-proof.json', proof)
        self.request.update(dump_sha256=artifacts['database.dump']['sha256'], manifest_sha256=manifest_meta['sha256'],
                            vm_receipt_sha256=vm_meta['sha256'], restore_proof_sha256=proof_meta['sha256'])
        self.write('checkpoint.json', self.request)

    def docker_run(self, command, timeout, maximum):
        self.calls.append(command)
        args = command[1:]
        if args[0] == 'ps':
            if '--filter' in args:
                return ((PG if 'label=com.docker.compose.service=postgres' in args else APP) + '\n').encode()
            return ('\n'.join([PG] + ([APP] if self.app['State']['Running'] else []) + [v['Id'] for v in self.other]) + '\n').encode()
        if args[1] == 'inspect':
            item = self.image if args[0] == 'image' else ({APP: self.app, PG: self.pg, **{v['Id']: v for v in self.other}}[args[2]])
            return json.dumps([item]).encode()
        if args[0] == 'stop':
            self.assertEqual(args, ['stop', '--signal', 'SIGTERM', '--timeout', '-1', APP])
            self.app['State'].update(Running=False, ExitCode=self.exit_code, FinishedAt='2026-01-02T00:00:00Z')
            if self.mutate_boot:
                self.app['RestartCount'] += 1
            if self.stop_error:
                raise ValueError('UNKNOWN fixture client outcome')
            return APP.encode()
        raise AssertionError(command)

    def stop(self, fence=None):
        return handoff.handoff(self.root, self.value, self.docker_run, fence or (lambda *_: self.fence))

    def test_single_clean_stop_and_completion_rechecks(self):
        result = self.stop()
        self.assertEqual(result['snapshot'], handoff.MISSING_SNAPSHOT)
        self.assertEqual(result['app']['id'], APP)
        self.assertEqual(result['accepted_boundary'], handoff.BOUNDARY)
        self.assertTrue((self.root / handoff.STATE / 'issued.json').is_file())
        self.assertTrue((self.root / handoff.STATE / 'receipt.json').is_file())
        handoff.verify_completed(self.root, self.value, self.docker_run, lambda *_: self.fence)
        with self.assertRaises(ValueError):
            self.stop()
        self.assertEqual(sum(c[1] == 'stop' for c in self.calls), 1)

    def test_timeout_even_if_later_stopped_never_infers_success(self):
        self.stop_error = True
        with self.assertRaisesRegex(ValueError, 'UNKNOWN'):
            self.stop()
        self.assertFalse((self.root / handoff.STATE / 'receipt.json').exists())
        self.stop_error = False
        with self.assertRaisesRegex(ValueError, 'no retry'):
            self.stop()
        self.assertEqual(sum(c[1] == 'stop' for c in self.calls), 1)

    def test_failed_preflight_never_signals(self):
        for field, value in [('Image', 'sha256:' + '0' * 64), ('RestartCount', 1)]:
            with self.subTest(field=field):
                original = self.app[field]; self.app[field] = value
                with self.assertRaises(ValueError): self.stop()
                self.app[field] = original
        self.assertFalse(any(c[1] == 'stop' for c in self.calls))

    def test_stopped_legacy_is_not_an_ack(self):
        self.app['State'].update(Running=False, ExitCode=0, FinishedAt='2026-01-02T00:00:00Z')
        with self.assertRaises(ValueError): self.stop()
        self.assertFalse(any(c[1] == 'stop' for c in self.calls))

    def test_nonzero_or_changed_boot_retains_issued_only(self):
        self.exit_code = 143
        with self.assertRaises(ValueError): self.stop()
        self.assertFalse((self.root / handoff.STATE / 'receipt.json').exists())

    def test_fence_refusal_precedes_signal(self):
        def refuse(*_): raise ValueError('fence not confirmed')
        with self.assertRaisesRegex(ValueError, 'fence'): self.stop(refuse)
        self.assertFalse(any(c[1] == 'stop' for c in self.calls))

    def test_changed_fence_after_stop_leaves_incomplete_receipt(self):
        calls = iter([self.fence, dict(self.fence, token='0' * 32)])
        with self.assertRaises(ValueError): self.stop(lambda *_: next(calls))
        self.assertFalse((self.root / handoff.STATE / 'receipt.json').exists())

    def test_equal_count_with_wrong_migration_hash_is_refused(self):
        rows = copy.deepcopy(self.source_rows); rows[0]['hashes'][0] = 'f' * 64
        self.rebuild(rows)
        with self.assertRaisesRegex(ValueError, 'hashes or row counts'): self.stop()
        self.assertFalse(any(c[1] == 'stop' for c in self.calls))

    def test_wrong_table_count_is_refused_even_when_proof_says_true(self):
        rows = copy.deepcopy(self.source_rows); rows[1]['count'] = 4
        self.rebuild(rows)
        with self.assertRaises(ValueError): self.stop()

    def test_tampered_dump_or_unprotected_input_is_refused(self):
        (self.check / 'database.dump').write_bytes(b'changed')
        with self.assertRaises(ValueError): self.stop()
        self.rebuild(); (self.check / 'database.dump').chmod(0o644)
        with self.assertRaises(ValueError): self.stop()
        self.assertFalse(any(c[1] == 'stop' for c in self.calls))

    def test_snapshot_absence_is_only_the_exact_owner_selected_literal(self):
        for value in (None, '', {}, 'not taken', 'snapshot: not taken (no credential)', {'id': '', 'status': 'taken'}):
            with self.subTest(value=value):
                self.request['snapshot'] = value; self.rebuild()
                with self.assertRaises(ValueError): self.stop()
        self.request['snapshot'] = {'id': '12345', 'status': 'taken'}; self.rebuild()
        self.assertEqual(self.stop()['snapshot']['id'], '12345')

    def test_wrong_host_or_database_refuses(self):
        with patch.object(handoff, 'host_identity', return_value=dict(HOST, hostname='other')):
            with self.assertRaises(ValueError): self.stop()
        self.pg['State']['StartedAt'] = '2026-01-03T00:00:00Z'
        with self.assertRaises(ValueError): self.stop()
        self.assertFalse(any(c[1] == 'stop' for c in self.calls))

    def test_other_portfolio_writer_or_wrong_mount_refuses(self):
        other = {'Id': '8' * 64, 'Mounts': [{'Type': 'bind', 'Source': str(self.root), 'RW': True}]}
        self.other = [other]
        with self.assertRaises(ValueError): self.stop()
        self.other = []; self.app['Mounts'][0]['Destination'] = '/wrong'
        with self.assertRaises(ValueError): self.stop()

    def test_contradictory_restore_target_is_refused_before_signal(self):
        for field, value in [('network', 'host'), ('network', 'bridge'), ('network', None),
                             ('container_id', PG), ('container_id', APP), ('container_id', 'bad'),
                             ('volume', None), ('volume', '/source/pgdata')]:
            with self.subTest(field=field, value=value):
                self.rebuild()
                proof = json.loads((self.check / 'restore-proof.json').read_text())
                proof[field] = value
                self.request['restore_proof_sha256'] = self.write('restore-proof.json', proof)['sha256']
                self.write('checkpoint.json', self.request)
                with self.assertRaisesRegex(ValueError, 'disposable target'): self.stop()
        self.assertFalse(any(c[1] == 'stop' for c in self.calls))
        proof['network'] = 'none'; proof['container_id'] = '4' * 64; proof['volume'] = 'source-data'
        with self.assertRaises(ValueError):
            handoff.validate_restore_target(proof, {'id': PG, 'mounts': [{'Name': 'source-data'}]}, APP)

    def test_changed_boot_during_stop_leaves_only_issued(self):
        self.mutate_boot = True
        with self.assertRaises(ValueError): self.stop()
        self.assertFalse((self.root / handoff.STATE / 'receipt.json').exists())

    def test_changed_qualified_image_fields_refuses(self):
        self.image['RootFS']['Layers'] = ['sha256:' + '0' * 64]
        with self.assertRaises(ValueError): self.stop()
        self.assertFalse(any(c[1] == 'stop' for c in self.calls))

    def test_post_stop_revival_or_proof_drift_refuses_forward_verification(self):
        self.stop()
        self.app['State']['Running'] = True
        with self.assertRaises(ValueError): handoff.verify_completed(self.root, self.value, self.docker_run, lambda *_: self.fence)
        self.app['State']['Running'] = False
        (self.check / 'restore-proof.json').write_bytes(b'{}')
        with self.assertRaises(ValueError): handoff.verify_completed(self.root, self.value, self.docker_run, lambda *_: self.fence)


if __name__ == '__main__':
    unittest.main()
