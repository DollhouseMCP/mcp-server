"""Synthetic stopped-proxy clone action with no Docker or network."""
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[2] / 'scripts'
sys.path.insert(0, str(SCRIPTS / 'hosted-deploy'))
sys.path.insert(0, str(SCRIPTS))
import caddy_bundle_identity
import caddy_clone_action
import caddy_recovery_receipt
import caddy_prepared_action
import caddy_prestart_action
import caddy_transition_action
import caddy_pending_proxy_action
import caddy_transition_state
import copy
import json
import test_hosted_caddy_volume_migration as fixtures
import test_hosted_caddy_hardened_profile as hardened_fixture


class CloneActionTests(unittest.TestCase):
    def setUp(self):
        self.fake = fixtures.VolumeMigrationTests('test_exact_caps_readonly_and_recheck')
        self.fake.setUp()
        self.addCleanup(self.fake.doCleanups)
        self.root = self.fake.root
        (self.root / 'server').mkdir()
        (self.root / 'server' / 'app').write_text('fixture')
        (self.root / 'Caddyfile').write_text('fixture caddyfile')
        self.fake.proxy['Mounts'][0]['Source'] = str(self.root / 'Caddyfile')
        self.fake.helper = SCRIPTS / 'hosted-deploy/caddy_volume_copy.mjs'
        self.request = {'deploy_dir': str(self.root), 'instance': 'site',
                        'data_volume': 'new_data', 'config_volume': 'new_config'}

    def run_docker(self, argv, timeout, limit):
        if argv[1:3] == ['volume', 'ls']:
            return b'site_data\nsite_config\n'
        if argv[1:3] == ['volume', 'create']:
            self.fake.token = argv[4].split('=', 1)[1]
            self.fake.volumes[argv[-1]]['Labels'] = {'org.dollhousemcp.caddy-clone-token': self.fake.token}
            return (argv[-1] + '\n').encode()
        if argv[1:3] == ['container', 'inspect'] and argv[3] == 'site-caddy':
            return self.fake.run_docker(['docker', 'container', 'inspect', self.fake.proxy['Id']], timeout, limit)
        return self.fake.run_docker(argv, timeout, limit)

    def test_receipt_binds_source_and_retains_originals(self):
        with patch.dict('os.environ', {'DOCKER_HOST': ''}):
            path = caddy_clone_action.clone(self.request, self.run_docker)
        raw = (path / 'receipt.json').read_bytes()
        import json
        record = json.loads(raw)
        expected = caddy_bundle_identity.bundle_identity(self.root / 'server')
        loaded = caddy_recovery_receipt.read_receipt(path, Path(record['bundle']), expected)
        self.assertEqual(loaded['clone']['volumes'][0]['name'], 'site_data')
        with patch.dict('os.environ', {'DOCKER_HOST': ''}):
            previous, selected = caddy_prepared_action.verify(self.request, self.run_docker)
        self.assertEqual(previous, Path(record['bundle']))
        self.assertEqual(selected, path)
        self.assertEqual((self.root / 'server' / 'app').read_text(), 'fixture')
        self.assertEqual((self.root / 'Caddyfile').read_text(), 'fixture caddyfile')

    def test_changed_source_refuses_before_helper_start(self):
        with patch.dict('os.environ', {'DOCKER_HOST': ''}):
            caddy_clone_action.clone(self.request, self.run_docker)
            (self.root / 'server' / 'app').write_text('changed')
            self.fake.calls.clear()
            with self.assertRaises(ValueError):
                caddy_prepared_action.verify(self.request, self.run_docker)
        self.assertFalse(any(call[1] == 'create' for call in self.fake.calls))

    def test_prestart_rechecks_owned_proxy_and_cloned_volumes(self):
        with patch.dict('os.environ', {'DOCKER_HOST': ''}):
            caddy_clone_action.clone(self.request, self.run_docker)
            previous, _ = caddy_prepared_action.verify(self.request, self.run_docker)
            (self.root / 'server').rename(previous)
            (self.root / 'Caddyfile').write_text('new config')
            request = dict(self.request, previous=str(previous), image='fixture')
            self.assertTrue(caddy_prestart_action.verify(request, self.run_docker))
            self.fake.writer = True
            with self.assertRaises(ValueError):
                caddy_prestart_action.verify(request, self.run_docker)

    def test_pending_before_source_move_can_start_exact_original_proxy(self):
        def run(argv, timeout, limit):
            if argv[1:2] == ['start'] and self.fake.proxy['Id'] in argv:
                self.fake.proxy['State']['Running'] = True
                return b'started\n'
            return self.run_docker(argv, timeout, limit)
        with patch.dict('os.environ', {'DOCKER_HOST': ''}):
            caddy_clone_action.clone(self.request, run)
            previous, _ = caddy_prepared_action.verify(self.request, run)
            transition = dict(self.request, previous=str(previous), token='',
                              image='registry.example.test/team/caddy@sha256:' + 'a' * 64)
            caddy_transition_action.begin_update(transition, self.root)
            self.assertEqual(caddy_transition_action.selected_proxy(self.root), '@current')
            result = caddy_pending_proxy_action.restore_current(self.root, 'site', run)
        self.assertEqual(result['container_id'], self.fake.proxy['Id'])
        self.assertTrue(self.fake.proxy['State']['Running'])

    def test_pending_changed_render_then_acquisition_failure_recovers_snapshot(self):
        candidate = {'value': None}
        new_id = 'e' * 64
        def run(argv, timeout, limit):
            if argv[1:2] == ['ps'] and any(value.startswith('name=^/') for value in argv):
                if candidate['value']:
                    return (new_id + '\n').encode()
                if self.fake.proxy['Name'] == '/site-caddy':
                    return (self.fake.proxy['Id'] + '\n').encode()
                return b''
            if argv[1:2] == ['rename']:
                self.fake.proxy['Name'] = '/' + argv[-1]
                return b''
            if argv[1:2] == ['create'] and argv[argv.index('--name') + 1] == 'site-caddy':
                token = next(item.split('=', 1)[1] for item in argv if item.startswith('org.dollhousemcp.proxy-recovery-token='))
                candidate['value'] = copy.deepcopy(self.fake.proxy)
                candidate['value']['Id'] = new_id
                candidate['value']['Name'] = '/site-caddy'
                candidate['value']['Config']['Labels']['org.dollhousemcp.proxy-recovery-token'] = token
                mount = next(item for item in argv if item.startswith('type=bind,src=') and ',dst=/etc/caddy/Caddyfile' in item)
                candidate['value']['Mounts'][0]['Source'] = mount.split('src=', 1)[1].split(',dst=', 1)[0]
                return (new_id + '\n').encode()
            if argv[1:3] == ['container', 'inspect'] and argv[3] == new_id:
                return json.dumps([candidate['value']]).encode()
            if argv[1:2] == ['start'] and new_id in argv:
                candidate['value']['State']['Running'] = True
                return b'started\n'
            return self.run_docker(argv, timeout, limit)
        with patch.dict('os.environ', {'DOCKER_HOST': ''}):
            caddy_clone_action.clone(self.request, run)
            previous, receipt = caddy_prepared_action.verify(self.request, run)
            transition = dict(self.request, previous=str(previous), token='',
                              image='registry.example.test/team/caddy@sha256:' + 'a' * 64)
            caddy_transition_action.begin_update(transition, self.root)
            replacement = self.root / 'new-caddyfile'
            replacement.write_text('changed config')
            replacement.replace(self.root / 'Caddyfile')
            acquisition_error = TimeoutError('fixture image acquisition failed')
            with self.assertRaises(TimeoutError):
                raise acquisition_error
            result = caddy_pending_proxy_action.restore_current(self.root, 'site', run)
        self.assertEqual(result['outcome'], 'recreated-original')
        self.assertEqual(Path(candidate['value']['Mounts'][0]['Source']).read_text(), 'fixture caddyfile')
        self.assertEqual((receipt / 'Caddyfile').stat().st_mode & 0o777, 0o600)
        self.assertEqual((self.root / 'Caddyfile').read_text(), 'changed config')
        self.assertFalse(self.fake.proxy['State']['Running'])
        evidence = list((self.root / '.caddy-transactions').glob('success-*.json'))
        self.assertEqual(len(evidence), 1)
        self.assertEqual(json.loads(evidence[0].read_bytes())['preserved_original_id'], self.fake.proxy['Id'])
        self.assertEqual(evidence[0].stat().st_mode & 0o777, 0o600)

    def test_staged_failure_recovers_only_exact_original_proxy(self):
        def run(argv, timeout, limit):
            if argv[1:2] == ['start'] and self.fake.proxy['Id'] in argv:
                self.fake.proxy['State']['Running'] = True
                return b'started\n'
            return self.run_docker(argv, timeout, limit)
        _, _, admission, _ = hardened_fixture.hardened()
        with patch.dict('os.environ', {'DOCKER_HOST': ''}):
            caddy_clone_action.clone(self.request, run)
            previous, _ = caddy_prepared_action.verify(self.request, run)
            transition = dict(self.request, previous=str(previous), token='', image=admission['reference'])
            token = caddy_transition_action.begin_update(transition, self.root)
            caddy_transition_state.bind_admission(self.root, token, admission)
            (self.root / 'server').rename(previous)
            (self.root / 'server').mkdir()
            (self.root / 'server' / 'app').write_text('next source')
            caddy_transition_state.mark_staged(self.root, token, caddy_bundle_identity.bundle_identity(self.root / 'server'))
            self.assertEqual(caddy_transition_action.selected_proxy(self.root), '@current')
            with patch.object(caddy_pending_proxy_action, 'unique_proxy', return_value='f' * 64), \
                    patch.object(caddy_pending_proxy_action, 'recover_locked', side_effect=ValueError('wrong replacement')) as replacement, \
                    self.assertRaises(ValueError):
                caddy_pending_proxy_action.recover_pending(self.root, 'site', admission['reference'], run)
            replacement.assert_called_once()
            for failed_phase in ('build', 'readiness', 'migration'):
                with self.subTest(failed_phase=failed_phase):
                    self.fake.proxy['State']['Running'] = False
                    result = caddy_pending_proxy_action.recover_pending(self.root, 'site', admission['reference'], run)
                    self.assertEqual(result['container_id'], self.fake.proxy['Id'])
                    self.assertTrue(self.fake.proxy['State']['Running'])
            self.fake.proxy['State']['Running'] = False
            self.fake.proxy['HostConfig']['ReadonlyRootfs'] = True
            with self.assertRaises(ValueError):
                caddy_pending_proxy_action.recover_pending(self.root, 'site', admission['reference'], run)
            self.assertFalse(self.fake.proxy['State']['Running'])

    def test_running_proxy_refuses_before_volume_creation(self):
        self.fake.proxy['State']['Running'] = True
        with patch.dict('os.environ', {'DOCKER_HOST': ''}), self.assertRaises(ValueError):
            caddy_clone_action.clone(self.request, self.run_docker)
        self.assertFalse(any(call[1:3] == ['volume', 'create'] for call in self.fake.calls))


if __name__ == '__main__':
    unittest.main()
