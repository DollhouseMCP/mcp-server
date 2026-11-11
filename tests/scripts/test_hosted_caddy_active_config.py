"""Inert checks for private Caddy control primitives; no Docker or setns."""
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[2] / 'scripts'
sys.path.insert(0, str(SCRIPTS / 'hosted-deploy'))
sys.path.insert(0, str(SCRIPTS))
import caddy_active_config as control


class ActiveConfigTests(unittest.TestCase):
    def test_full_canonical_json_and_duplicate_refusal(self):
        self.assertEqual(control.canonical(b'{"b":[1,2],"a":{"x":true}}'), b'{"a":{"x":true},"b":[1,2]}')
        for value in (b'{"a":1,"a":2}', b'{"a":NaN}', b'[]', b'{'):
            with self.subTest(value=value), self.assertRaises((ValueError, TypeError)):
                control.canonical(value)

    def test_in_place_write_retains_inode_and_refuses_changed_file(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            target = root / 'Caddyfile'
            target.write_bytes(b'normal')
            target.chmod(0o644)
            inode = target.stat().st_ino
            control.write_startup_file(root, b'normal', b'fenced')
            self.assertEqual(target.stat().st_ino, inode)
            self.assertEqual(target.read_bytes(), b'fenced')
            with self.assertRaisesRegex(ValueError, 'content changed'):
                control.write_startup_file(root, b'normal', b'new')
            self.assertEqual(target.read_bytes(), b'fenced')

    def test_symlink_and_hardlink_refuse_before_write(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / 'source'
            source.write_bytes(b'normal')
            target = root / 'Caddyfile'
            target.symlink_to(source)
            with self.assertRaises(OSError):
                control.write_startup_file(root, b'normal', b'new')
            target.unlink()
            os.link(source, target)
            with self.assertRaisesRegex(ValueError, 'unsafe'):
                control.write_startup_file(root, b'normal', b'new')
            self.assertEqual(source.read_bytes(), b'normal')

    def test_private_snapshots_bind_exact_bytes_and_reject_reuse_or_change(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            token = 'a' * 32
            hashes = control.snapshot_files(root, token, b'normal', b'fenced')
            self.assertEqual(control.read_snapshots(root, token, hashes), (b'normal', b'fenced'))
            with self.assertRaises(FileExistsError):
                control.snapshot_files(root, token, b'normal', b'fenced')
            snapshot = root / '.caddy-verification' / ('control-' + token) / 'normal'
            snapshot.write_bytes(b'changed')
            with self.assertRaisesRegex(ValueError, 'snapshot changed'):
                control.read_snapshots(root, token, hashes)

    def test_only_fixed_admin_endpoints_are_accepted(self):
        session = control.ActiveConfig.__new__(control.ActiveConfig)
        for pair in (('GET', '/load'), ('POST', '/config/'), ('GET', '/config/?x=1')):
            with self.subTest(pair=pair), self.assertRaisesRegex(ValueError, 'unsupported'):
                session.request(*pair)

    def test_deadline_keeps_separate_reap_reserve_and_reports_unknown_child(self):
        child = unittest.mock.Mock()
        child.returncode = None
        child.poll.return_value = None
        with patch.object(control.subprocess, 'Popen', return_value=child), \
                patch.object(control.time, 'monotonic', return_value=100), \
                patch.object(control.scanner, 'capture_process', return_value='deadline') as capture, \
                patch.object(control.scanner, 'terminate_process', return_value=False) as terminate, \
                patch.object(control.scanner, 'close_child_pipes'):
            with self.assertRaisesRegex(ValueError, 'UNKNOWN') as caught:
                control.bounded_input(['/fixed/tool'], timeout=15)
        self.assertEqual(capture.call_args.args[1], 112)
        self.assertEqual(terminate.call_args.args[1], 115)
        self.assertTrue(any('cleanup is UNKNOWN' in note for note in caught.exception.__notes__))

    def test_load_requires_matching_entire_active_configuration(self):
        session = control.ActiveConfig.__new__(control.ActiveConfig)
        with patch.object(session, 'request') as request, patch.object(session, 'read', return_value=b'{"a":1}'):
            session.load(b'{"a":1}')
            request.assert_called_once_with('POST', '/load', b'{"a":1}')
        with patch.object(session, 'request'), patch.object(session, 'read', return_value=b'{"a":2}'):
            with self.assertRaisesRegex(ValueError, 'differs'):
                session.load(b'{"a":1}')

    def test_failed_load_preserves_original_error_when_boot_recheck_fails(self):
        session = control.ActiveConfig.__new__(control.ActiveConfig)
        session.fd = 7
        with patch.object(session, 'recheck', side_effect=[None, ValueError('changed boot')]), \
                patch.object(control, 'bounded_input', side_effect=ValueError('load acknowledgement lost')):
            with self.assertRaisesRegex(ValueError, 'acknowledgement lost') as caught:
                session.request('POST', '/load', b'{}')
        self.assertTrue(any('UNKNOWN' in note for note in caught.exception.__notes__))

    def test_adapt_names_a_real_input_path_for_every_supported_caddy(self):
        # Inert argv check only. scripts/ci/caddy-release-native.py runs this
        # same call against the real legacy and qualified Caddy binaries.
        session = control.ActiveConfig.__new__(control.ActiveConfig)
        session.identity = {'id': 'a' * 64, 'pid': 123, 'started_at': 'start', 'restart_count': 0}
        session.namespace = (1, 2)
        with patch.object(session, 'recheck'), \
                patch.object(control, 'bounded_input', return_value=b'{"b":1,"a":2}') as bounded:
            self.assertEqual(session.adapt(b'fixture.local {\n}\n'), b'{"a":2,"b":1}')
        command, payload = bounded.call_args.args
        self.assertEqual(command, ['/usr/bin/docker', 'exec', '--interactive', 'a' * 64, '/usr/bin/caddy',
                                   'adapt', '--config', '/dev/stdin', '--adapter', 'caddyfile'])
        self.assertEqual(payload, b'fixture.local {\n}\n')

    def test_adapt_refuses_output_that_depends_on_the_input_path(self):
        # Observed on real Caddy 2.8.4 and 2.11.9: file_server hides its own configuration file.
        session = control.ActiveConfig.__new__(control.ActiveConfig)
        session.identity = {'id': 'a' * 64, 'pid': 123, 'started_at': 'start', 'restart_count': 0}
        dependent = b'{"apps":{"http":{"servers":{"srv0":{"routes":[{"handle":[{"handler":"file_server","hide":["/dev/stdin"]}]}]}}}}}'
        with patch.object(session, 'recheck'), patch.object(control, 'bounded_input', return_value=dependent):
            with self.assertRaisesRegex(ValueError, 'depends on its input path'):
                session.adapt(b':80 {\n\tfile_server\n}\n')

    def test_changed_namespace_refuses_control(self):
        session = control.ActiveConfig.__new__(control.ActiveConfig)
        session.identity = {'id': 'a' * 64, 'pid': 123, 'started_at': 'start', 'restart_count': 0}
        session.run, session.fd, session.namespace = object(), 7, (1, 2)
        with patch.object(control, 'boot', return_value=session.identity), \
                patch.object(control.os, 'fstat', return_value=unittest.mock.Mock(st_dev=1, st_ino=2)), \
                patch.object(control.os, 'stat', return_value=unittest.mock.Mock(st_dev=1, st_ino=3)):
            with self.assertRaisesRegex(ValueError, 'namespace changed'):
                session.recheck()


if __name__ == '__main__':
    unittest.main()
