"""Native replacement command guards with inert Docker records, not a daemon."""
import copy
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[2] / 'scripts'
sys.path.insert(0, str(SCRIPTS / 'hosted-deploy'))
sys.path.insert(0, str(SCRIPTS))
import caddy_native_replacement as native
from caddy_active_config import snapshot_files
from caddy_retired_proxy import inventory
from caddy_service_guard import unique_proxy
import legacy_handoff as handoff
from legacy_recovery_guards import lifecycle
from legacy_recovery_profile import profile
import test_hosted_caddy_recovery_preflight as fixtures


class NativeReplacementTests(unittest.TestCase):
    def setUp(self):
        self.fx = fixtures.RecoveryPreflightTests()
        self.fx.setUp()
        self.addCleanup(self.fx.doCleanups)
        self.root = self.fx.root
        self.old = copy.deepcopy(self.fx.fx.fake.proxy)
        self.old['State'] = {'Running': False, 'OOMKilled': False, 'Restarting': False, 'ExitCode': 0,
                             'StartedAt': '2026-01-01T00:00:00Z', 'FinishedAt': '2026-01-01T00:01:00Z'}
        self.old['RestartCount'] = 0
        self.candidate = copy.deepcopy(self.fx.current)
        self.candidate['Id'] = 'e' * 64
        self.candidate['NetworkSettings']['Networks']['site_default']['Aliases'] = ['caddy', 'site-caddy']
        self.candidate['State'] = {'Running': False, 'OOMKilled': False, 'Restarting': False, 'ExitCode': 0,
                                   'StartedAt': '0001-01-01T00:00:00Z'}
        self.candidate['RestartCount'] = 0
        self.candidate['HostConfig']['PortBindings'] = copy.deepcopy(self.old['HostConfig']['PortBindings'])
        self.candidate['NetworkSettings']['Ports'] = copy.deepcopy(self.candidate['HostConfig']['PortBindings'])
        self.token = 'f' * 32
        self.candidate['Config']['Labels']['org.dollhousemcp.proxy-recovery-token'] = self.token
        self.created = False
        self.lose_start = False
        self.calls = []
        self.control = {'phase': 'prepared', **snapshot_files(self.root, self.token, b'normal', b'verification')}
        startup = self.root / 'Caddyfile'
        startup.write_bytes(b'verification')
        startup.chmod(0o644)
        original = json.loads((self.fx.receipt / 'receipt.json').read_bytes())
        self.expected = {'instance': 'site', 'token': self.token, 'image': self.fx.current_image,
                         'admission': self.fx.admission, 'reference': self.fx.reference, 'startup': startup,
                         'names': ['new_data', 'new_config'], 'volumes': original['clone']['volumes'][2:],
                         'ports': original['profile']['ports'], 'original_id': self.old['Id'],
                         'original_profile': profile(self.old), 'boot': lifecycle(self.old, False),
                         'clone_receipt': str(self.fx.receipt), 'clone_receipt_sha256': '8' * 64,
                         'logging': original['profile']['logging']}
        self.pending = {'token': self.token, 'kind': 'update', 'image': self.fx.reference,
                        'volumes': self.expected['names'], 'control': self.control,
                        'previous': str(self.fx.previous), 'receipt': str(self.fx.receipt),
                        'receipt_sha256': self.expected['clone_receipt_sha256'], 'admission': self.fx.admission}
        self.value = {'instance': 'site', 'token': self.token, 'image': self.fx.reference,
                      'data_volume': 'new_data', 'config_volume': 'new_config', 'admission': self.fx.admission}
        for module, name, result in ((handoff, 'host_identity', {'hostname': 'fixture', 'machine_id_sha256': '6' * 64}),
                                     (native, 'pending_control', ({'pending': self.pending}, self.pending, self.control)),
                                     (native, 'inspect_volumes', self.expected['volumes']),
                                     (native, 'recovery_kind', ('legacy', original, self.fx.receipt)),
                                     (native, 'verify_prepared', None)):
            binding = patch.object(module, name, return_value=result)
            binding.start()
            self.addCleanup(binding.stop)

    def run_docker(self, argv, timeout, maximum):
        self.calls.append(argv)
        rows = [self.old, self.candidate] if self.created else [self.old]
        if argv[1] == 'ps':
            if any(item.startswith('name=^/') for item in argv):
                rows = [row for row in rows if row['Name'] == '/site-caddy']
            elif '--quiet' in argv:
                rows = [row for row in rows if row['State']['Running']]
            return '\n'.join(row['Id'] for row in rows).encode()
        if argv[1:3] == ['image', 'inspect']:
            self.assertEqual(argv[-1], self.fx.admission['store_id'])
            return json.dumps([self.fx.current_image]).encode()
        if argv[1:3] == ['container', 'inspect']:
            return json.dumps([next(row for row in rows if row['Id'] == argv[-1])]).encode()
        if argv[1] == 'rename':
            self.assertEqual(argv[2], self.old['Id'])
            self.old['Name'] = '/' + argv[3]
            return b''
        if argv[1] == 'create':
            self.created = True
            return (self.candidate['Id'] + '\n').encode()
        if argv[1] == 'start':
            self.assertEqual(argv[-1], self.candidate['Id'])
            self.candidate['State'].update(Running=True, StartedAt='2026-01-01T00:02:00Z')
            if self.lose_start:
                raise TimeoutError('fixture lost native start acknowledgement')
            return (self.candidate['Id'] + '\n').encode()
        if argv[1] == 'stop':
            self.assertEqual(argv, ['docker', 'stop', '--signal', 'SIGTERM', '--timeout', '-1', self.candidate['Id']])
            self.candidate['State'].update(Running=False, FinishedAt='2026-01-01T00:03:00Z')
            return (self.candidate['Id'] + '\n').encode()
        raise AssertionError(argv)

    def replace(self):
        return native.replace(self.root, self.value, self.pending, self.control, self.run_docker, self.fx.qualify)

    def test_checked_replacement_retains_old_identity_and_never_calls_compose_or_pull(self):
        self.assertEqual(self.replace(), 'native')
        self.assertFalse(self.old['State']['Running'])
        self.assertTrue(self.candidate['State']['Running'])
        self.assertEqual(inventory(self.root, 'site', self.run_docker), {self.old['Id']})
        self.assertEqual(unique_proxy(self.run_docker, 'site', root=self.root), self.candidate['Id'])
        create = next(argv for argv in self.calls if argv[1] == 'create')
        self.assertEqual(create[2:4], ['--pull', 'never'])
        self.assertEqual(create[-1], self.fx.reference)
        self.assertFalse(any(argv[1] in ('compose', 'pull', 'build', 'rm') for argv in self.calls))
        self.assertEqual(sum(argv[1] == 'start' for argv in self.calls), 1)

    def test_changed_admission_refuses_before_retaining_or_creating(self):
        self.value['admission'] = {}
        with self.assertRaisesRegex(ValueError, 'admission changed'):
            self.replace()
        self.assertFalse(any(argv[1] in ('rename', 'create', 'start', 'stop') for argv in self.calls))
        self.assertEqual(self.old['Name'], '/site-caddy')

    def test_unknown_start_is_fenced_once_but_not_promoted(self):
        self.lose_start = True
        with self.assertRaises(TimeoutError):
            self.replace()
        self.assertFalse(self.candidate['State']['Running'])
        self.assertEqual(sum(argv[1] == 'start' for argv in self.calls), 1)
        self.assertEqual(sum(argv[1] == 'stop' for argv in self.calls), 1)
        proof = self.root / native.DIRECTORY / ('replace-' + self.token)
        self.assertFalse((proof / 'started.json').exists())
        native.verify_failed_start_fence(self.root, self.token, self.candidate)
        self.candidate['Mounts'].reverse()
        native.verify_failed_start_fence(self.root, self.token, self.candidate)
        self.candidate['HostConfig']['ReadonlyRootfs'] = False
        with self.assertRaisesRegex(ValueError, 'offline fence is UNKNOWN'):
            native.verify_failed_start_fence(self.root, self.token, self.candidate)

    def test_compose_route_is_only_for_unambiguous_stopped_original_without_retirement(self):
        self.assertEqual(native.start(self.root, self.value, self.run_docker, self.fx.qualify), 'compose')
        self.old['State']['Running'] = True
        with self.assertRaisesRegex(ValueError, 'original proxy stopped'):
            native.start(self.root, self.value, self.run_docker, self.fx.qualify)
        self.old['State']['Running'] = False
        self.created = True
        with self.assertRaisesRegex(ValueError, 'ambiguous'):
            native.start(self.root, self.value, self.run_docker, self.fx.qualify)
        self.assertFalse(any(argv[1] in ('start', 'stop', 'rename', 'create') for argv in self.calls))


if __name__ == '__main__':
    unittest.main()
