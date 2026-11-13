"""Synthetic changed hardened image/config clone and proxy-only restoration."""
import copy
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[2] / 'scripts'
sys.path.insert(0, str(SCRIPTS / 'hosted-deploy'))
sys.path.insert(0, str(SCRIPTS))
import caddy_clone_action
import caddy_prepared_action
import caddy_prestart_action
import caddy_recover_action
import test_hosted_caddy_hardened_profile as hardened_fixture
import test_hosted_caddy_volume_migration as docker_fixture


class HardenedMigrationTests(unittest.TestCase):
    def setUp(self):
        self.fake = docker_fixture.VolumeMigrationTests('test_exact_caps_readonly_and_recheck')
        self.fake.setUp()
        self.addCleanup(self.fake.doCleanups)
        self.root = self.fake.root
        (self.root / 'server').mkdir()
        (self.root / 'server' / 'app').write_text('previous')
        (self.root / 'Caddyfile').write_text('old config')
        self.old, self.image, self.old_admission, _ = hardened_fixture.hardened()
        self.old['State'] = {'Running': False}
        self.old['Mounts'][0]['Source'] = str(self.root / 'Caddyfile')
        self.fake.proxy = self.old
        self.fake.image = self.image
        self.fake.helper = SCRIPTS / 'hosted-deploy/caddy_volume_copy.mjs'
        self.request = {'deploy_dir': str(self.root), 'instance': 'site', 'data_volume': 'new_data', 'config_volume': 'new_config'}
        self.old_ref = self.old_admission['reference']
        self.new_ref = 'registry.example.test/team/caddy@sha256:' + 'b' * 64
        self.current = None
        self.restored = None
        self.restored_id = 'e' * 64
        self.calls = []

    def admit(self, reference):
        if reference not in (self.old_ref, self.new_ref):
            raise ValueError('unknown fixture image')
        return {'reference': reference, 'store_id': self.image['Id']}

    def run_docker(self, argv, timeout, limit):
        self.calls.append(argv)
        if self.current and argv[1:2] == ['ps'] and any(value.startswith('label=com.docker.compose.project=') for value in argv):
            return (self.current['Id'] + '\n').encode()
        if argv[1:3] == ['volume', 'ls']:
            return b'site_data\nsite_config\n'
        if argv[1:3] == ['volume', 'create']:
            self.fake.token = argv[4].split('=', 1)[1]
            self.fake.volumes[argv[-1]]['Labels'] = {'org.dollhousemcp.caddy-clone-token': self.fake.token}
            return (argv[-1] + '\n').encode()
        if argv[1:3] == ['container', 'inspect'] and argv[3] == 'site-caddy':
            return json.dumps([self.current or self.old]).encode()
        if self.current and argv[1:3] == ['container', 'inspect'] and argv[3] == self.current['Id']:
            return json.dumps([self.current]).encode()
        if self.restored and argv[1:3] == ['container', 'inspect'] and argv[3] == self.restored_id:
            return json.dumps([self.restored]).encode()
        if self.current and argv[1:2] == ['ps'] and '--filter' in argv:
            if self.restored and self.restored['Name'] == '/site-caddy':
                return (self.restored_id + '\n').encode()
            return (self.current['Id'] + '\n').encode() if self.current['Name'] == '/site-caddy' else b''
        if self.current and argv[1:2] == ['stop'] and self.current['Id'] in argv:
            self.current['State']['Running'] = False
            return b'stopped\n'
        if self.current and argv[1:2] == ['rename']:
            self.current['Name'] = '/' + argv[-1]
            return b''
        if self.current and argv[1:2] == ['create'] and argv[argv.index('--name') + 1] == 'site-caddy':
            token = next(item.split('=', 1)[1] for item in argv if item.startswith('org.dollhousemcp.proxy-recovery-token='))
            self.restored = copy.deepcopy(self.old)
            self.restored['Id'] = self.restored_id
            self.restored['Config']['Labels']['org.dollhousemcp.proxy-recovery-token'] = token
            mount = next(item for item in argv if item.startswith('type=bind,src=') and ',dst=/etc/caddy/Caddyfile' in item)
            self.restored['Mounts'][0]['Source'] = mount.split('src=', 1)[1].split(',dst=', 1)[0]
            return (self.restored_id + '\n').encode()
        if self.current and argv[1:2] == ['start'] and self.restored_id in argv:
            self.restored['State']['Running'] = True
            return b'started\n'
        return self.fake.run_docker(argv, timeout, limit)

    def test_changed_hardened_proxy_clone_and_recovery(self):
        with patch.dict('os.environ', {'DOCKER_HOST': ''}):
            receipt = caddy_clone_action.clone(self.request, self.run_docker, self.admit)
            previous, _ = caddy_prepared_action.verify(self.request, self.run_docker, self.admit)
            record = json.loads((receipt / 'receipt.json').read_bytes())
            self.assertEqual(record['profile']['kind'], 'hardened')
            (self.root / 'server').rename(previous)
            (self.root / 'Caddyfile').write_text('new config')
            self.assertTrue(caddy_prestart_action.verify(dict(self.request, previous=str(previous), image=self.new_ref),
                                                         self.run_docker, self.admit))
            self.current = copy.deepcopy(self.old)
            self.current['Id'] = 'd' * 64
            self.current['State']['Running'] = True
            self.current['Config']['Image'] = self.new_ref
            self.current['Mounts'][1]['Name'] = 'new_data'
            self.current['Mounts'][2]['Name'] = 'new_config'
            result = caddy_recover_action.recover_locked(self.root, 'site', previous, self.new_ref, self.run_docker, self.admit)
        self.assertEqual(result['restored_id'], self.restored_id)
        self.assertTrue(self.restored['State']['Running'])
        self.assertEqual(Path(self.restored['Mounts'][0]['Source']).read_text(), 'old config')
        self.assertEqual((receipt / 'Caddyfile').stat().st_mode & 0o777, 0o600)
        self.assertEqual(Path(self.restored['Mounts'][0]['Source']).stat().st_mode & 0o777, 0o644)
        self.assertEqual([item['Name'] for item in self.restored['Mounts'][1:]], ['site_data', 'site_config'])


if __name__ == '__main__':
    unittest.main()
