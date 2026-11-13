"""Inert checks for bounded, exact-owned native fixture cleanup."""
import importlib.util
import json
import contextlib
import io
from pathlib import Path
import time
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[2] / 'scripts/ci/caddy-volume-copy-native.py'
spec = importlib.util.spec_from_file_location('native_copy_fixture', SCRIPT)
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)


class NativeCopyCleanupTests(unittest.TestCase):
    def setUp(self):
        self.names = ['old-data', 'old-config', 'new-data', 'new-config']
        self.token = 'a' * 32
        self.name = 'dollhouse-caddy-copy-' + self.token
        self.identifier = 'b' * 64
        self.image = 'sha256:' + 'c' * 64
        self.runner = native.FixtureRunner(self.image, self.names)
        self.runner.active[self.name] = {'token': self.token, 'id': self.identifier, 'mode': None}
        self.present = True
        self.commands = []
        self.image_actual = self.image
        self.wrong_mount = False

    def process(self, command, timeout, maximum, **_kwargs):
        self.commands.append(command)
        if command[:2] == ['docker', 'ps']:
            out = (self.identifier + '\n').encode() if self.present else b''
        elif command[:3] == ['docker', 'container', 'inspect']:
            out = json.dumps([{'Id': self.identifier, 'Name': '/' + self.name, 'Image': self.image_actual,
                               'Config': {'Image': native.HELPER_IMAGE, 'User': '0:0',
                                          'Cmd': ['node', '/caddy-volume-copy.mjs'],
                                          'Labels': {'org.dollhousemcp.caddy-clone-token': self.token}},
                               'HostConfig': {'CapAdd': ['CAP_CHOWN'], 'CapDrop': ['ALL']},
                               'Mounts': [{'Type': 'volume', 'Name': name, 'Destination': target, 'RW': (index >= 2) or self.wrong_mount}
                                          for index, (name, target) in enumerate(zip(self.names, ('/source/data', '/source/config', '/target/data', '/target/config')))] +
                                         [{'Type': 'bind', 'Source': str(native.ROOT / 'scripts/hosted-deploy/caddy_volume_copy.mjs'),
                                           'Destination': '/caddy-volume-copy.mjs', 'RW': False}]}]).encode()
        elif command[:2] == ['docker', 'rm']:
            self.present = False
            out = (self.identifier + '\n').encode()
        else:
            self.fail('unexpected fixture command')
        return 0, out, b'', None

    def test_cleanup_reserve_after_work_deadline_and_capability_diagnostic(self):
        self.runner.work_end = time.monotonic() - 1
        with patch.object(native.scanner, 'bounded_process', side_effect=self.process):
            with self.assertRaises(TimeoutError):
                self.runner.run(['docker', 'create'], 15, 65536)
            self.runner.cleanup(self.name)
        self.assertFalse(self.present)
        self.assertFalse(self.runner.active)
        self.assertEqual(self.runner.capabilities[0]['CapAdd'], ['CAP_CHOWN'])
        self.assertEqual(self.runner.capabilities[0]['CapDrop'], ['ALL'])

    def test_unverified_image_is_never_removed(self):
        self.image_actual = 'sha256:' + 'd' * 64
        with patch.object(native.scanner, 'bounded_process', side_effect=self.process):
            with self.assertRaisesRegex(ValueError, 'unverified'):
                self.runner.cleanup(self.name)
        self.assertTrue(self.present)
        self.assertFalse(any(command[:2] == ['docker', 'rm'] for command in self.commands))

    def test_lost_create_ack_resolves_only_exact_owned_name(self):
        self.runner.active[self.name]['id'] = None
        with patch.object(native.scanner, 'bounded_process', side_effect=self.process):
            self.runner.cleanup(self.name)
        self.assertFalse(self.present)
        self.assertEqual([command[-1] for command in self.commands if command[:2] == ['docker', 'rm']], [self.identifier])

    def test_source_refusal_requires_known_reason_and_completed_cleanup(self):
        error = ValueError('Unsafe Caddy volume directory')
        with patch.object(native, 'invoke', side_effect=error), self.assertRaises(ValueError):
            native.exercise_source_refusal(self.runner, native.ROOT / 'scripts/hosted-deploy/caddy_volume_copy.mjs')
        self.runner.active.clear()
        with patch.object(native, 'invoke', side_effect=ValueError('unrelated failure')), self.assertRaises(ValueError):
            native.exercise_source_refusal(self.runner, native.ROOT / 'scripts/hosted-deploy/caddy_volume_copy.mjs')
        out = io.StringIO()
        with patch.object(native, 'invoke', side_effect=error), contextlib.redirect_stdout(out):
            native.exercise_source_refusal(self.runner, native.ROOT / 'scripts/hosted-deploy/caddy_volume_copy.mjs')
        self.assertEqual(json.loads(out.getvalue()), {'unsafeSourceRefused': True, 'ownedCleanupConfirmed': True})

    def test_changed_mount_is_never_removed(self):
        self.wrong_mount = True
        with patch.object(native.scanner, 'bounded_process', side_effect=self.process):
            with self.assertRaisesRegex(ValueError, 'mounts changed'):
                self.runner.cleanup(self.name)
        self.assertTrue(self.present)
        self.assertFalse(any(command[:2] == ['docker', 'rm'] for command in self.commands))

    def test_nonempty_refusal_never_hides_unknown_cleanup(self):
        error = ValueError('Caddy destination volume is not empty')
        with self.assertRaisesRegex(RuntimeError, 'cleanup remains UNKNOWN'):
            native.require_nonempty_refusal(error, self.runner)
        self.runner.active.clear()
        native.require_nonempty_refusal(error, self.runner)


if __name__ == '__main__':
    unittest.main()
