"""Private disposable files/inert Docker: no host, service or database mutation."""
import copy
import itertools
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[2] / 'scripts'
sys.path.insert(0, str(SCRIPTS / 'hosted-deploy'))
sys.path.insert(0, str(SCRIPTS))
import legacy_recovery_boundary as boundary
from legacy_recovery_profile import canonical_mounts, profile_hash
import test_hosted_caddy_legacy_handoff as legacy_fixture


class RecoveryMountTests(unittest.TestCase):
    def test_reordered_full_mounts_match_but_every_changed_field_refuses(self):
        mounts = [{'Type': 'bind', 'Destination': '/etc/Caddyfile', 'Source': '/fixture/Caddyfile', 'RW': False},
                  {'Type': 'volume', 'Destination': '/data', 'Source': '/fixture/data', 'Name': 'old-data', 'RW': True},
                  {'Type': 'volume', 'Destination': '/config', 'Source': '/fixture/config', 'Name': 'old-config', 'RW': True}]
        for order in itertools.permutations(mounts):
            self.assertEqual(canonical_mounts(list(order)), canonical_mounts(mounts))
        for index, mount in enumerate(mounts):
            for key in mount:
                changed = copy.deepcopy(mounts)
                changed[index][key] = not mount[key] if isinstance(mount[key], bool) else mount[key] + '-changed'
                try:
                    actual = canonical_mounts(changed)
                except ValueError:
                    continue  # Invalid mount types are refused, never normalized away.
                self.assertNotEqual(actual, canonical_mounts(mounts))
        self.assertNotEqual(canonical_mounts(mounts[:-1]), canonical_mounts(mounts))
        with self.assertRaisesRegex(ValueError, 'duplicate'):
            canonical_mounts(mounts + [mounts[0]])
        with self.assertRaisesRegex(ValueError, 'duplicate'):
            canonical_mounts([mounts[0], mounts[0], mounts[2]])
        a = {'Id': 'a', 'Image': 'i', 'Config': {}, 'HostConfig': {}, 'Mounts': mounts}
        self.assertEqual(profile_hash(a), profile_hash({**a, 'Mounts': list(reversed(mounts))}))


class RecoveryBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.fixture = legacy_fixture.HandoffTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.root, self.value = self.fixture.root, self.fixture.value
        self.fixture.pg.update(Config={}, HostConfig={})
        (self.root / 'server').mkdir()
        (self.root / 'server' / 'version').write_text('qualified-old-source')
        for name in boundary.FILES:
            path = self.root / name
            path.write_bytes(('old-' + name).encode())
            path.chmod(0o600 if name in ('.env', '.env.production') else 0o644)
        self.pending = {'kind': 'update', 'token': self.value['token'], 'phase': 'prepared', 'control': None,
                        'source': boundary.bundle_identity(self.root / 'server'),
                        'previous': str(self.root / ('server.prev-' + '1' * 32)),
                        'receipt': str(self.root / '.caddy-recovery' / ('proxy-' + '2' * 32)),
                        'receipt_sha256': '3' * 64}
        self.state_patch = patch.object(boundary, 'read_state', return_value={'pending': self.pending})
        self.state_patch.start()
        self.addCleanup(self.state_patch.stop)
        self.original_verify = boundary.handoff.verify_completed
        self.verify_patch = patch.object(boundary.handoff, 'verify_completed', side_effect=lambda r, v, run:
                                         self.original_verify(r, v, run, verify_fence=lambda *_: self.fixture.fence))
        self.verify_patch.start()
        self.addCleanup(self.verify_patch.stop)
        self.schema = b'CREATE TABLE fixture();\n'
        self.globals = b'fixture-globals'
        self.ledger = self.fixture.source_rows[0]['hashes']

    def run_docker(self, command, timeout, maximum):
        if command[1:3] == ['exec', legacy_fixture.PG]:
            self.fixture.calls.append(command)
            if 'pg_dumpall' in command[-1]:
                return self.globals
            if 'pg_dump ' in command[-1]:
                return self.schema
            return json.dumps(self.ledger).encode()
        return self.fixture.docker_run(command, timeout, maximum)

    def arm(self):
        return boundary.arm(self.root, self.value, self.run_docker)

    def complete_stop(self):
        boundary.handoff.handoff(self.root, self.value, self.run_docker,
                                verify_fence=lambda *_: self.fixture.fence)

    def test_arm_snapshots_original_files_and_canonical_profiles_without_mutating_services(self):
        armed = self.arm()
        directory = boundary.window_path(self.root, self.value['token'])
        record, digest = boundary.read_window(self.root, self.value['token'])
        self.assertEqual(record, armed)
        self.assertEqual(digest, boundary.handoff.digest((directory / 'armed.json').read_bytes()))
        for name in boundary.FILES:
            self.assertEqual((directory / name).read_bytes(), (self.root / name).read_bytes())
            self.assertEqual((directory / name).stat().st_mode & 0o777, 0o600)
        self.assertFalse(any(command[1] in ('start', 'stop', 'run', 'create') for command in self.fixture.calls))
        boundary.refuse_forward_write(self.root, self.value['token'])

    def listing(self):
        return sorted((str(path), path.stat().st_mtime_ns) for path in self.root.rglob('*'))

    def test_check_runs_before_any_transition_and_writes_nothing(self):
        before = self.listing()
        with patch.object(boundary, 'read_state', side_effect=AssertionError('no transition exists yet')):
            self.assertIsNone(boundary.check(self.root, dict(self.value, token=''), self.run_docker))
        self.assertEqual(self.listing(), before)
        self.assertFalse(any(command[1] in ('start', 'stop', 'run', 'create') for command in self.fixture.calls))
        self.assertEqual([boundary.valid_token(action, token) for action, token in (
            ('check', ''), ('check', self.value['token']), ('arm', self.value['token']), ('arm', ''), ('write-intent', ''))],
            [True, False, True, False, False])
        # What the check accepts, arming accepts.
        self.arm()

    def test_check_refuses_what_arming_would_refuse_and_leaves_nothing_behind(self):
        value = dict(self.value, token='')

        def public():
            (self.root / '.env').chmod(0o644)

        def linked():
            (self.root / '.env').unlink()
            (self.root / '.env').symlink_to(self.root / '.env.production')

        for name, change, error, message in (
                ('public environment', public, ValueError, 'already be private'),
                ('symlink', linked, OSError, ''),
                ('missing required file', (self.root / 'Caddyfile').unlink, ValueError, 'required legacy configuration is absent')):
            saved = {item: ((self.root / item).read_bytes(), (self.root / item).stat().st_mode & 0o777) for item in boundary.FILES}
            with self.subTest(name):
                change()
                with self.assertRaisesRegex(error, message):
                    boundary.check(self.root, value, self.run_docker)
                self.assertFalse((self.root / boundary.DIRECTORY).exists())
            for item, (raw, mode) in saved.items():
                (self.root / item).unlink(missing_ok=True)
                (self.root / item).write_bytes(raw)
                (self.root / item).chmod(mode)
        (self.root / 'bootstrap-admin.sh').unlink()
        boundary.check(self.root, value, self.run_docker)
        for field, changed in (('globals', b'changed-roles'), ('ledger', ['f' * 64] * 62)):
            with self.subTest(field=field), patch.object(self, field, changed):
                with self.assertRaisesRegex(ValueError, 'differ from the qualified checkpoint'):
                    boundary.check(self.root, value, self.run_docker)
        with patch.object(self, 'ledger', ['f' * 64] * 61):
            with self.assertRaisesRegex(ValueError, 'exact 62-entry'):
                boundary.check(self.root, value, self.run_docker)
        self.assertFalse((self.root / boundary.DIRECTORY).exists())

    def test_write_intent_is_exclusive_and_permanently_refuses_automatic_prewrite_recovery(self):
        self.arm()
        self.complete_stop()
        before = (self.root / '.legacy-handoff' / 'receipt.json').read_bytes()
        boundary.issue_forward_write(self.root, self.value, self.run_docker)
        with self.assertRaisesRegex(ValueError, 'restoration is required'):
            boundary.refuse_forward_write(self.root, self.value['token'])
        with self.assertRaisesRegex(ValueError, 'restoration is required'):
            boundary.issue_forward_write(self.root, self.value, self.run_docker)
        self.assertEqual(before, (self.root / '.legacy-handoff' / 'receipt.json').read_bytes())

    def test_unknown_or_changed_database_refuses_before_write_intent(self):
        self.arm()
        self.complete_stop()
        for field, changed in (('schema', b'changed-schema'), ('globals', b'changed-roles'), ('ledger', ['f' * 64] * 62)):
            with self.subTest(field=field), patch.object(self, field, changed):
                with self.assertRaisesRegex(ValueError, 'database changed'):
                    boundary.issue_forward_write(self.root, self.value, self.run_docker)
        self.assertFalse((boundary.window_path(self.root, self.value['token']) / 'forward-write-issued.json').exists())

    def test_no_armed_window_or_incomplete_stop_never_infers_safe_boundary(self):
        with self.assertRaises(FileNotFoundError):
            boundary.issue_forward_write(self.root, self.value, self.run_docker)
        self.arm()
        with self.assertRaises(FileNotFoundError):
            boundary.issue_forward_write(self.root, self.value, self.run_docker)

    def test_admitted_hardened_proxy_path_can_arm_before_rendering(self):
        # begin_update has already admitted an unchanged hardened proxy, but
        # has not rendered/staged source or created any verification control.
        self.pending['phase'] = 'admitted'
        armed = self.arm()
        self.assertEqual(armed['source'], self.pending['source'])
        self.assertFalse(any(command[1] in ('start', 'stop') for command in self.fixture.calls))

    def test_rendered_staged_or_changed_source_refuses_to_arm(self):
        for change in ({'phase': 'staged'}, {'control': {'phase': 'probed'}}, {'token': '0' * 32}):
            with self.subTest(change=change), patch.dict(self.pending, change):
                with self.assertRaisesRegex(ValueError, 'before rendering'):
                    self.arm()
        (self.root / 'server' / 'version').write_text('different-source')
        with self.assertRaisesRegex(ValueError, 'before rendering'):
            self.arm()

    def test_no_second_arm_and_tampered_snapshot_refuses(self):
        self.arm()
        with self.assertRaises(FileExistsError):
            self.arm()
        (boundary.window_path(self.root, self.value['token']) / '.env').write_text('changed')
        with self.assertRaisesRegex(ValueError, 'snapshot changed'):
            boundary.read_window(self.root, self.value['token'])

    def test_recovery_window_does_not_survive_a_changed_helper_implementation(self):
        self.arm()
        original = boundary.bundle_identity

        def different(path):
            result = original(path)
            return {**result, 'sha256': '0' * 64} if path == boundary.IMPLEMENTATION else result

        with patch.object(boundary, 'bundle_identity', side_effect=different):
            with self.assertRaisesRegex(ValueError, 'binding differs'):
                boundary.read_window(self.root, self.value['token'])

    def test_public_env_or_symlink_is_not_copied_as_a_qualified_baseline(self):
        (self.root / '.env').chmod(0o644)
        with self.assertRaisesRegex(ValueError, 'already be private'):
            self.arm()
        self.assertFalse((boundary.window_path(self.root, self.value['token']) / 'armed.json').exists())

    def test_symlink_configuration_is_not_followed(self):
        (self.root / '.env').unlink()
        (self.root / '.env').symlink_to(self.root / '.env.production')
        with self.assertRaises(OSError):
            self.arm()
        self.assertFalse((boundary.window_path(self.root, self.value['token']) / 'armed.json').exists())

    def test_changed_configuration_during_capture_refuses_without_stopping_app(self):
        original = boundary.capture_files

        def mutate(root, directory):
            result = original(root, directory)
            (root / 'compose.yml').write_text('changed-during-capture')
            return result

        with patch.object(boundary, 'capture_files', side_effect=mutate):
            with self.assertRaisesRegex(ValueError, 'changed before arming'):
                self.arm()
        self.assertFalse(any(command[1] in ('start', 'stop') for command in self.fixture.calls))


if __name__ == '__main__':
    unittest.main()
