"""Bounded Docker failures retain their original metadata before cleanup."""
import contextlib
import io
import json
import unittest
from unittest.mock import patch

from test_hosted_caddy_clone_action import caddy_clone_action as clone


class DockerDiagnosticTests(unittest.TestCase):
    def test_failure_metadata_is_emitted_without_secret_argv(self):
        stderr = io.StringIO()
        with patch.object(clone.scanner, 'bounded_process', return_value=(1, b'', b'Unsafe directory\n', None)), \
                patch.object(clone.time, 'monotonic', side_effect=[10.0, 10.25]), \
                contextlib.redirect_stderr(stderr), self.assertRaisesRegex(ValueError, 'bounded Docker'):
            clone.docker_run(['docker', 'start', '--attach', 'fixture-sensitive-argv'], 180, 65536)
        record = json.loads(stderr.getvalue())
        self.assertEqual(record['exit_code'], 1)
        self.assertEqual(record['stderr'], 'Unsafe directory\n')
        self.assertEqual(record['elapsed_seconds'], 0.25)
        self.assertEqual(record['timeout_seconds'], 180)
        self.assertNotIn('fixture-sensitive-argv', stderr.getvalue())

    def test_unknown_outcome_stays_unknown(self):
        stderr = io.StringIO()
        with patch.object(clone.scanner, 'bounded_process', return_value=(None, b'', b'partial', 'deadline exceeded')), \
                contextlib.redirect_stderr(stderr), self.assertRaisesRegex(ValueError, 'UNKNOWN'):
            clone.docker_run(['docker', 'start', 'fixture'], 1, 65536)
        record = json.loads(stderr.getvalue())
        self.assertIsNone(record['exit_code'])
        self.assertEqual(record['error'], 'deadline exceeded')
        self.assertEqual(record['stderr'], 'partial')


if __name__ == '__main__':
    unittest.main()
