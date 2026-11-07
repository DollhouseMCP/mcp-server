"""Synthetic unchanged hardened-proxy update and rollback admission."""
import hashlib
import json
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[2] / 'scripts'
sys.path.insert(0, str(SCRIPTS / 'hosted-deploy'))
sys.path.insert(0, str(SCRIPTS))
import caddy_unchanged_action
import caddy_recover_action
import test_hosted_caddy_hardened_profile as fixtures


class UnchangedActionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        (self.root / 'server').mkdir()
        (self.root / 'server' / 'app').write_text('fixture')
        (self.root / 'Caddyfile').write_text('unchanged')
        self.container, self.image, self.admission, self.ports = fixtures.hardened()
        self.container['State'] = {'Running': True}
        self.container['Mounts'][0]['Source'] = str(self.root / 'Caddyfile')
        self.volumes = {}
        for name in ('site_data', 'site_config'):
            path = self.root / name
            path.mkdir()
            self.volumes[name] = {'Name': name, 'Driver': 'local', 'Scope': 'local',
                                  'Mountpoint': str(path), 'CreatedAt': 'fixture'}
        self.calls = []
        self.request = {'deploy_dir': str(self.root), 'instance': 'site', 'data_volume': 'site_data',
                        'config_volume': 'site_config', 'image': self.admission['reference'],
                        'expected_caddy_sha256': hashlib.sha256(b'unchanged').hexdigest(),
                        'proxy_mode': 'caddy-http', 'bind_address': '0.0.0.0', 'http_port': '80', 'https_port': '443'}

    def qualify(self, ref):
        self.assertEqual(ref, self.admission['reference'])
        return self.admission

    def run_docker(self, argv, timeout, limit):
        self.calls.append(argv)
        if argv[1:3] == ['context', 'inspect']:
            value = [{'Endpoints': {'docker': {'Host': 'unix:///var/run/docker.sock'}}}]
        elif argv[1:3] == ['image', 'inspect']:
            value = [self.image]
        elif argv[1:3] == ['container', 'inspect']:
            value = [self.container]
        elif argv[1:3] == ['volume', 'inspect']:
            value = [self.volumes[argv[3]]]
        elif argv[1:2] == ['ps']:
            return (self.container['Id'] + '\n').encode()
        else:
            self.fail('unexpected Docker command')
        return json.dumps(value).encode()

    def test_unchanged_proxy_kept_and_receipt_binds_rollback(self):
        with patch.dict('os.environ', {'DOCKER_HOST': ''}):
            previous = caddy_unchanged_action.prepare(self.request, self.run_docker, self.qualify)
            (self.root / 'server').rename(previous)
            caddy_unchanged_action.verify_noop(self.root, 'site', previous, self.run_docker, self.qualify)
            recovery = {'deploy_dir': str(self.root), 'instance': 'site', 'data_volume': 'site_data',
                        'config_volume': 'site_config', 'image': self.admission['reference'], 'previous': str(previous)}
            self.assertEqual(caddy_recover_action.recover(recovery, self.run_docker, self.qualify), {'outcome': 'unchanged'})
        self.assertFalse(any(call[1] in ('stop', 'rename', 'start', 'create') for call in self.calls))
        self.assertTrue(self.container['State']['Running'])

    def test_changed_config_refuses_before_receipt(self):
        self.request['expected_caddy_sha256'] = 'a' * 64
        with self.assertRaises(ValueError):
            caddy_unchanged_action.prepare(self.request, self.run_docker, self.qualify)
        self.assertFalse((self.root / '.caddy-hardened-recovery').exists())

    def test_ambiguous_receipt_refuses_rollback(self):
        with patch.dict('os.environ', {'DOCKER_HOST': ''}):
            previous = caddy_unchanged_action.prepare(self.request, self.run_docker, self.qualify)
            (self.root / 'server').rename(previous)
            root = self.root / '.caddy-hardened-recovery'
            original = next(root.iterdir())
            shutil.copytree(original, root / ('proxy-' + 'f' * 32))
            with self.assertRaises(ValueError):
                caddy_unchanged_action.verify_noop(self.root, 'site', previous, self.run_docker, self.qualify)

    def test_missing_or_changed_proxy_refuses_rollback(self):
        with patch.dict('os.environ', {'DOCKER_HOST': ''}):
            previous = caddy_unchanged_action.prepare(self.request, self.run_docker, self.qualify)
            (self.root / 'server').rename(previous)
            self.container['HostConfig']['CapAdd'] = ['SYS_ADMIN']
            with self.assertRaises(ValueError):
                caddy_unchanged_action.verify_noop(self.root, 'site', previous, self.run_docker, self.qualify)
            shutil.rmtree(self.root / '.caddy-hardened-recovery')
            with self.assertRaises(FileNotFoundError):
                caddy_unchanged_action.verify_noop(self.root, 'site', previous, self.run_docker, self.qualify)


if __name__ == '__main__':
    unittest.main()
