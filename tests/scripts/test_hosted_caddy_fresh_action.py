"""Inert first-install volume seeding using a fake local Docker adapter."""
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[2] / 'scripts'
sys.path.insert(0, str(SCRIPTS / 'hosted-deploy'))
sys.path.insert(0, str(SCRIPTS))
import caddy_fresh_action
import caddy_fresh_recheck
import test_hosted_caddy_volume_migration as fixtures


class FreshActionTests(unittest.TestCase):
    def setUp(self):
        self.fake = fixtures.VolumeMigrationTests('test_exact_caps_readonly_and_recheck')
        self.fake.setUp()
        self.addCleanup(self.fake.doCleanups)
        self.root = self.fake.root
        self.ref = 'registry.example.test/team/caddy@sha256:' + 'a' * 64
        self.caddy_id = 'sha256:' + '7' * 64
        self.seed_id = '8' * 64
        self.seed = None
        self.existing = False
        self.calls = []
        self.fake.helper = SCRIPTS / 'hosted-deploy/caddy_volume_copy.mjs'
        self.request = {'deploy_dir': str(self.root), 'instance': 'site',
                        'data_volume': 'new_data', 'config_volume': 'new_config', 'image': self.ref}

    def qualify(self, reference):
        return {'reference': reference, 'store_id': self.caddy_id}

    def run_docker(self, argv, timeout, limit):
        self.calls.append(argv)
        if argv[1:2] == ['ps'] and any(value.startswith('label=com.docker.compose.project=') for value in argv):
            return b''
        if argv[1:3] == ['volume', 'ls']:
            return b'new_data\n' if self.existing else b''
        if argv[1:3] == ['volume', 'create']:
            token = argv[4].split('=', 1)[1]
            self.fake.volumes[argv[-1]]['Labels'] = {'org.dollhousemcp.caddy-fresh-token': token}
            return (argv[-1] + '\n').encode()
        if argv[1:2] == ['create'] and argv[argv.index('--name') + 1].startswith('dollhouse-caddy-seed-'):
            token = argv[argv.index('--name') + 1].removeprefix('dollhouse-caddy-seed-')
            names = ['new_data', 'new_config']
            self.fake.names = names + names
            self.seed = {'Id': self.seed_id, 'Name': '/dollhouse-caddy-seed-' + token, 'Image': self.caddy_id,
                         'Config': {'User': '1001:1001', 'Labels': {'org.dollhousemcp.caddy-fresh-token': token}},
                         'HostConfig': {'NetworkMode': 'none', 'ReadonlyRootfs': True, 'CapDrop': ['ALL'],
                                        'SecurityOpt': ['no-new-privileges:true'], 'Privileged': False,
                                        'AutoRemove': False, 'RestartPolicy': {'Name': 'no'}},
                         'State': {'Running': False},
                         'Mounts': [{'Type': 'volume', 'Name': name, 'Destination': dest, 'RW': True}
                                    for name, dest in zip(names, ('/data', '/config'))]}
            return (self.seed_id + '\n').encode()
        if argv[1:3] == ['container', 'inspect'] and argv[3] == self.seed_id:
            return json.dumps([self.seed]).encode()
        return self.fake.run_docker(argv, timeout, limit)

    def test_creates_only_fresh_volumes_and_never_starts_seed(self):
        with patch.dict('os.environ', {'DOCKER_HOST': ''}):
            path = caddy_fresh_action.prepare(self.request, self.run_docker, self.qualify)
        record = json.loads(path.read_bytes())
        self.assertEqual(record['layout']['schema'], 'caddy-fresh-volumes-v1')
        self.assertEqual([item['name'] for item in record['volumes']], ['new_data', 'new_config'])
        self.assertFalse(any(call[1] == 'start' and self.seed_id in call for call in self.calls))
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        with patch.dict('os.environ', {'DOCKER_HOST': ''}):
            self.assertEqual(caddy_fresh_recheck.verify(self.request, self.run_docker, self.qualify), path)
        self.existing = True
        self.calls.clear()
        with patch.dict('os.environ', {'DOCKER_HOST': ''}):
            reused = caddy_fresh_action.prepare(self.request, self.run_docker, self.qualify)
        self.assertEqual(reused, path)
        self.assertFalse(any(call[1:3] == ['volume', 'create'] for call in self.calls))

    def test_existing_volume_refuses_before_create(self):
        self.existing = True
        with patch.dict('os.environ', {'DOCKER_HOST': ''}), self.assertRaises(ValueError):
            caddy_fresh_action.prepare(self.request, self.run_docker, self.qualify)
        self.assertFalse(any(call[1:3] == ['volume', 'create'] for call in self.calls))


if __name__ == '__main__':
    unittest.main()
