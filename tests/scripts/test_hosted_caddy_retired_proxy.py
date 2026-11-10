"""Private disposable retirement records/inert inspect, never real Docker."""
import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts' / 'hosted-deploy'))
import caddy_retired_proxy as retired
import legacy_handoff as handoff
from legacy_recovery_profile import profile

ID, SERVING = 'a' * 64, 'b' * 64


class RetiredProxyTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name).resolve()
        self.host = {'hostname': 'fixture', 'machine_id_sha256': 'c' * 64}
        binding = patch.object(handoff, 'host_identity', return_value=self.host)
        binding.start()
        self.addCleanup(binding.stop)
        self.old = {'Id': ID, 'Name': '/site-caddy-aborted-' + 'd' * 16, 'Image': 'sha256:' + 'e' * 64,
                    'Config': {'Labels': {'com.docker.compose.project': 'site', 'com.docker.compose.service': 'caddy'}},
                    'HostConfig': {}, 'Mounts': [{'Type': 'bind', 'Destination': '/a', 'Source': '/fixture/a'},
                                               {'Type': 'volume', 'Destination': '/b', 'Name': 'fixture-b'}],
                    'RestartCount': 0, 'State': {'Running': False, 'Restarting': False, 'OOMKilled': False,
                                               'ExitCode': 0, 'StartedAt': 'before', 'FinishedAt': 'after'}}
        self.serving = copy.deepcopy(self.old)
        self.serving.update(Id=SERVING, Name='/site-caddy')
        self.serving['State'].update(Running=True)
        self.containers = {ID: self.old, SERVING: self.serving}
        self.operation = self.root / '.legacy-recovery' / ('reconciled-' + 'f' * 32)
        self.operation.mkdir(parents=True, mode=0o700)
        self.operation.parent.chmod(0o700)
        self.proof = self.operation / 'retirement-authority.json'
        self.record = {'schema': 'qualified-proxy-retirement-v1', 'host': self.host, 'instance': 'site',
                       'retired': {'id': ID, 'name': self.old['Name'][1:], 'profile': profile(self.old),
                                   'boot': retired.lifecycle(self.old, False)}}
        self.write_proof()

    def write_proof(self):
        self.proof.write_bytes(handoff.encoded(self.record))
        self.proof.chmod(0o600)

    def run_docker(self, argv, timeout, maximum):
        self.assertEqual(argv[1:3], ['container', 'inspect'])
        return json.dumps([self.containers[argv[-1]]]).encode()

    def register(self):
        retired.register(self.root, 'site', ID, self.old['Name'][1:], self.proof, self.run_docker)

    def test_only_exact_stopped_retained_profile_is_recognized(self):
        self.register()
        self.old['Mounts'].reverse()
        self.assertEqual(retired.inventory(self.root, 'site', self.run_docker), {ID})
        self.assertEqual(self.old['Config']['Labels']['com.docker.compose.service'], 'caddy')
        self.assertFalse(self.old['State']['Running'])
        path = self.root / retired.DIRECTORY / ('proxy-' + ID + '.json')
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        with self.assertRaises(FileExistsError):
            self.register()

    def test_changed_boot_profile_mount_or_name_is_not_hidden(self):
        self.register()
        original = copy.deepcopy(self.old)
        for key, value in (('Name', '/site-caddy'), ('Image', 'changed'), ('RestartCount', 1),
                           ('Mounts', []), ('HostConfig', {'Privileged': True})):
            self.old[key] = value
            with self.subTest(key=key), self.assertRaises(ValueError):
                retired.inventory(self.root, 'site', self.run_docker)
            self.old[key] = original[key]
        self.old['State']['Running'] = True
        with self.assertRaises(ValueError):
            retired.inventory(self.root, 'site', self.run_docker)

    def test_unknown_or_public_authority_refuses_before_registration(self):
        self.proof.chmod(0o644)
        with self.assertRaises(ValueError):
            self.register()
        self.assertFalse((self.root / retired.DIRECTORY).exists())

    def test_authority_drift_and_extra_unknown_inventory_refuse(self):
        self.register()
        raw = self.proof.read_bytes()
        self.proof.write_bytes(raw + b' ')
        with self.assertRaisesRegex(ValueError, 'digest changed'):
            retired.inventory(self.root, 'site', self.run_docker)
        self.proof.write_bytes(raw)
        (self.root / retired.DIRECTORY / 'unknown.json').write_text('{}')
        with self.assertRaisesRegex(ValueError, 'unknown entry'):
            retired.inventory(self.root, 'site', self.run_docker)

    def test_serving_path_is_only_the_qualified_old_private_bind_with_equal_root_bytes(self):
        path = self.root / '.caddy-recovery' / ('proxy-' + '1' * 32) / 'Caddyfile'
        path.parent.mkdir(parents=True, mode=0o700)
        path.parent.parent.chmod(0o700)
        path.write_bytes(b'fixture legacy Caddyfile')
        path.chmod(0o600)
        (self.root / 'Caddyfile').write_bytes(path.read_bytes())
        (self.root / 'Caddyfile').chmod(0o644)
        serving = {'id': SERVING, 'profile': profile(self.serving), 'boot': retired.lifecycle(self.serving, True),
                   'caddyfile': str(path),
                   'caddyfile_sha256': handoff.digest(path.read_bytes())}
        self.record['serving'] = serving
        self.write_proof()
        self.register()
        value = {'authority': {'path': str(self.proof), 'sha256': handoff.digest(self.proof.read_bytes())}, 'serving': serving}
        record_path = self.root / retired.DIRECTORY / 'serving.json'
        record_path.write_bytes(handoff.encoded(value))
        record_path.chmod(0o600)
        self.assertEqual(retired.startup_path(self.root, 'site', SERVING, self.run_docker), path)
        self.assertEqual(retired.inventory(self.root, 'site', self.run_docker), {ID})
        self.assertEqual(retired.startup_path(self.root, 'site', '9' * 64, self.run_docker), self.root / 'Caddyfile')
        (self.root / 'Caddyfile').write_bytes(b'changed root bytes')
        with self.assertRaisesRegex(ValueError, 'startup bytes differ'):
            retired.startup_path(self.root, 'site', SERVING, self.run_docker)


if __name__ == '__main__':
    unittest.main()
