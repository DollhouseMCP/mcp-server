"""Inert Docker adapter exercises the real preparation and receipt code."""
import json
import os
from pathlib import Path
import unittest
from unittest.mock import patch

import test_hosted_caddy_clone_action as fixtures
import caddy_offline_prepare as offline


class OfflinePrepareTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.CloneActionTests('test_receipt_binds_source_and_retains_originals')
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.fake = self.fixture.fake
        self.fake.proxy['State'].update(Running=True, Restarting=False, OOMKilled=False,
                                        ExitCode=0, StartedAt='2026-11-09T00:00:00Z')
        self.fake.proxy['RestartCount'] = 0
        self.request = dict(self.fixture.request, image='registry.example.test/team/caddy@sha256:' + 'a' * 64)
        self.calls = []
        self.stop_error = None
        self.stop_help = b'--signal string\n--timeout int\n'
        self.bad_exit = False

    def run_docker(self, argv, timeout, limit):
        self.calls.append(argv)
        if argv == ['docker', 'stop', '--help']:
            return self.stop_help
        if argv[:2] == ['docker', 'stop'] and argv[-1] == self.fake.proxy['Id']:
            if self.stop_error:
                raise self.stop_error
            self.fake.proxy['State']['Running'] = False
            if self.bad_exit:
                self.fake.proxy['State']['ExitCode'] = 137
            return (argv[-1] + '\n').encode()
        if argv == ['docker', 'ps', '--no-trunc', '--quiet']:
            ids = [self.fake.proxy['Id']] if self.fake.proxy['State']['Running'] else []
            if self.fake.writer:
                ids.append('c' * 64)
            return ('\n'.join(ids) + ('\n' if ids else '')).encode()
        return self.fixture.run_docker(argv, timeout, limit)

    def prepare(self):
        with patch.dict('os.environ', {'DOCKER_HOST': ''}):
            return offline.prepare(self.request, self.run_docker, lambda reference: {'reference': reference})

    def test_real_clone_receipt_and_paused_ingress(self):
        result = self.prepare()
        self.assertEqual(result['ingress'], 'closed')
        self.assertEqual(result['recovery_bundle'], 'not-yet-staged')
        self.assertFalse(Path(result['previous_bundle']).exists())
        self.assertFalse((self.fake.root / offline.STOP_FENCE).exists())
        record = json.loads((Path(result['receipt']) / 'receipt.json').read_bytes())
        self.assertEqual(record['clone']['volumes'][0]['name'], 'site_data')
        self.assertEqual((self.fake.root / 'server' / 'app').read_text(), 'fixture')
        self.assertEqual((self.fake.root / 'Caddyfile').read_text(), 'fixture caddyfile')
        stop = ['docker', 'stop', '--signal', 'SIGTERM', '--timeout', '-1', self.fake.proxy['Id']]
        self.assertLess(self.calls.index(stop), next(i for i, item in enumerate(self.calls) if item[1:3] == ['volume', 'create']))
        self.assertFalse(any(item[:2] == ['docker', 'start'] and item[-1] == self.fake.proxy['Id'] for item in self.calls))

    def test_unsupported_stop_signal_refuses_before_stop(self):
        self.fake.proxy['Config']['StopSignal'] = 'SIGKILL'
        with self.assertRaisesRegex(ValueError, 'stop signal'):
            self.prepare()
        self.assertFalse(any(item[:2] == ['docker', 'stop'] and '--help' not in item for item in self.calls))

    def test_other_writer_refuses_before_stop(self):
        self.fake.writer = True
        with self.assertRaisesRegex(ValueError, 'write'):
            self.prepare()
        self.assertFalse(any(item[:2] == ['docker', 'stop'] and '--help' not in item for item in self.calls))

    def test_unsupported_docker_stop_refuses_before_stop(self):
        self.stop_help = b'--timeout int\n'
        with self.assertRaisesRegex(ValueError, 'required signal'):
            self.prepare()
        self.assertFalse((self.fake.root / offline.STOP_FENCE).exists())

    def test_unclean_stop_retains_fence_without_clone(self):
        self.bad_exit = True
        with self.assertRaisesRegex(ValueError, 'cleanly'):
            self.prepare()
        self.assertTrue((self.fake.root / offline.STOP_FENCE).exists())
        self.assertFalse(any(item[1:3] == ['volume', 'create'] for item in self.calls))

    def test_failed_clone_keeps_originals_and_partial_destinations(self):
        self.fake.start_error = ValueError('fixture copy failed')
        with self.assertRaisesRegex(ValueError, 'fixture copy failed'):
            self.prepare()
        self.assertFalse(self.fake.proxy['State']['Running'])
        self.assertFalse((self.fake.root / offline.STOP_FENCE).exists())
        self.assertTrue(any(item[1:3] == ['volume', 'create'] for item in self.calls))
        self.assertFalse(any(item[1:3] == ['volume', 'rm'] for item in self.calls))
        self.assertFalse(any(item[:2] == ['docker', 'start'] and item[-1] == self.fake.proxy['Id'] for item in self.calls))
        self.assertEqual((self.fake.root / 'server' / 'app').read_text(), 'fixture')

    def test_unknown_stop_retains_fence_and_refuses_later_lock(self):
        self.stop_error = TimeoutError('fixture stop outcome unknown')
        with self.assertRaises(TimeoutError):
            self.prepare()
        fence = self.fake.root / offline.STOP_FENCE
        record = json.loads(fence.read_bytes())
        self.assertEqual(record['proxy_id'], self.fake.proxy['Id'])
        self.assertEqual(record['signal'], 'SIGTERM')
        self.assertEqual(fence.stat().st_mode & 0o777, 0o600)
        with self.assertRaisesRegex(ValueError, 'unknown outcome'):
            self.prepare()
        self.assertTrue(self.fake.proxy['State']['Running'])
        self.assertEqual(sum(item[:2] == ['docker', 'stop'] and '--help' not in item for item in self.calls), 1)
        self.assertFalse(any(item[1:3] == ['volume', 'create'] for item in self.calls))

    def test_inherited_lock_also_refuses_existing_fence(self):
        lock = offline.acquire_lock(self.fake.root)
        try:
            (self.fake.root / offline.STOP_FENCE).write_text('unknown')
            with patch.dict('os.environ', {'HOSTED_CADDY_LOCK_FD': str(lock)}):
                with self.assertRaisesRegex(ValueError, 'unknown outcome'):
                    offline.acquire_lock(self.fake.root)
        finally:
            os.close(lock)


if __name__ == '__main__':
    unittest.main()
