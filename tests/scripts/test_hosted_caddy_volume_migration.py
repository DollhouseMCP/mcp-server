"""Inert end-to-end orchestration with a fake local Docker adapter."""
import json
from pathlib import Path
import sys
import tempfile
import unittest

SCRIPTS = Path(__file__).resolve().parents[2] / 'scripts'
sys.path.insert(0, str(SCRIPTS / 'hosted-deploy'))
sys.path.insert(0, str(SCRIPTS))
import caddy_volume_migration as migration
from caddy_legacy_profile import validate_legacy_profile
from caddy_volume_guard import volume_identity
from test_hosted_caddy_legacy_profile import fixture


class VolumeMigrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.token = 'a' * 32
        self.names = ['site_data', 'site_config', 'new_data', 'new_config']
        self.volumes = {}
        for name in self.names:
            path = self.root / name
            path.mkdir()
            self.volumes[name] = {'Name': name, 'Driver': 'local', 'Scope': 'local',
                                  'Mountpoint': str(path), 'CreatedAt': 'fixture',
                                  'Labels': {'org.dollhousemcp.caddy-clone-token': self.token}}
        self.proxy, self.image = fixture()
        self.proxy['State'] = {'Running': False}
        self.profile = validate_legacy_profile(self.proxy, self.image, '/srv/site/Caddyfile', 'site_default')
        self.sources = [volume_identity(self.volumes[name], name) for name in self.names[:2]]
        self.calls = []
        self.writer = False
        self.helper = self.root / 'helper.mjs'
        self.helper.write_text('// fixture')
        self.helper_id = 'f' * 64
        self.helper_image_id = 'sha256:' + '1' * 64
        self.helper_state = {'Running': False, 'ExitCode': 0}
        self.start_error = None
        self.create_error = None
        self.stop_error = False
        self.mode = None
        self.helper_names = self.names
        self.preflight_error = None

    def run_docker(self, argv, timeout, limit):
        self.calls.append(argv)
        if argv[1:3] == ['context', 'inspect']:
            value = [{'Endpoints': {'docker': {'Host': 'unix:///var/run/docker.sock'}}}]
        elif argv[1:2] == ['info']:
            value = {'OSType': 'linux', 'Architecture': 'aarch64'}
        elif argv[1:3] == ['image', 'inspect']:
            value = [{'Id': self.helper_image_id, 'RepoDigests': [migration.HELPER_IMAGE],
                      'Os': 'linux', 'Architecture': 'arm64'}] if argv[3] == migration.HELPER_IMAGE else [self.image]
        elif argv[1:3] == ['container', 'inspect']:
            if argv[3] == self.proxy['Id']:
                value = [self.proxy]
            elif argv[3] == 'c' * 64:
                value = [{'State': {'Running': True}, 'Mounts': [
                    {'Type': 'volume', 'Name': 'site_data', 'RW': True}]}]
            else:
                mounts = [{'Type': 'volume', 'Name': name, 'Destination': target, 'RW': index >= 2 and not self.mode}
                          for index, (name, target) in enumerate(zip(self.helper_names, ('/source/data', '/source/config', '/target/data', '/target/config')))]
                mounts.append({'Type': 'bind', 'Source': str(self.helper), 'Destination': '/caddy-volume-copy.mjs', 'RW': False})
                value = [{'Id': self.helper_id, 'Name': '/dollhouse-caddy-copy-' + self.token,
                          'Image': self.helper_image_id, 'State': self.helper_state,
                          'Config': {'Labels': {'org.dollhousemcp.caddy-clone-token': self.token},
                                     'Image': migration.HELPER_IMAGE, 'User': '0:0',
                                     'Cmd': ['node', '/caddy-volume-copy.mjs'] + ([self.mode] if self.mode else [])},
                          'HostConfig': {'NetworkMode': 'none', 'ReadonlyRootfs': True,
                                         'Privileged': False, 'AutoRemove': False, 'RestartPolicy': {'Name': 'no'},
                                         'CapAdd': ['CHOWN', 'FOWNER', 'DAC_READ_SEARCH'], 'CapDrop': ['ALL'],
                                         'SecurityOpt': ['no-new-privileges:true']},
                          'Mounts': mounts}]
        elif argv[1:3] == ['volume', 'inspect']:
            value = [self.volumes[argv[3]]]
        elif argv[1:2] == ['ps']:
            if any(value.startswith('label=com.docker.compose.project=') for value in argv):
                return (self.proxy['Id'] + '\n').encode()
            return (('c' * 64 + '\n') if self.writer else '').encode()
        elif argv[1:2] == ['create']:
            if self.create_error:
                raise self.create_error
            self.token = argv[argv.index('--name') + 1].removeprefix('dollhouse-caddy-copy-')
            self.helper_names = [item.split('src=', 1)[1].split(',', 1)[0] for item in argv if item.startswith('type=volume,src=')]
            self.mode = next((value for value in ('--verify', '--verify-source', '--verify-fresh') if value in argv), None)
            return (self.helper_id + '\n').encode()
        elif argv[1:2] == ['start']:
            if self.preflight_error and len(self.helper_names) == 2:
                raise self.preflight_error
            if self.start_error and len(self.helper_names) == 4:
                self.helper_state = {'Running': True, 'ExitCode': 0}
                raise self.start_error
            if self.mode == '--verify-fresh':
                value = {'schema': 'caddy-fresh-volumes-v1', 'data_mode': 0o750, 'config_mode': 0o750,
                         'owner': 1001, 'group': 1001}
            else:
                value = {'schema': 'caddy-volume-clone-v1', 'entries': 1, 'bytes': 1,
                         'root_modes': {'data': 0o700, 'config': 0o700},
                         'inventory_sha256': 'd' * 64, 'certificate_sha256': ['e' * 64]}
        elif argv[1:2] == ['stop']:
            if self.stop_error:
                raise TimeoutError('stop unavailable')
            self.helper_state = {'Running': False, 'ExitCode': 137}
            return (self.helper_id + '\n').encode()
        elif argv[1:2] == ['rm']:
            return (self.helper_id + '\n').encode()
        else:
            self.fail('unexpected Docker command')
        return json.dumps(value).encode()

    def migrate(self):
        return migration.migrate_volumes(self.run_docker, self.profile, self.sources, self.names[2:],
                                         self.token, self.helper, '/srv/site/Caddyfile')

    def test_exact_caps_readonly_and_recheck(self):
        result = self.migrate()
        self.assertEqual(result['copy']['schema'], 'caddy-volume-clone-v1')
        command = next(call for call in self.calls if call[1] == 'create')
        for item in ('--pull', 'never', '--network', 'none', '--read-only', 'CHOWN', 'FOWNER', 'DAC_READ_SEARCH'):
            self.assertIn(item, command)
        self.assertEqual(sum(',readonly' in item for item in command), 3)
        self.assertEqual(sum('volume-nocopy' in item for item in command), 4)
        self.assertGreaterEqual(sum(call[1:3] == ['container', 'inspect'] for call in self.calls), 4)
        migration.verify_prepared(self.run_docker, self.profile, result, self.helper, '/srv/site/Caddyfile')
        verify_command = [call for call in self.calls if call[1] == 'create'][-1]
        self.assertIn('--verify', verify_command)
        self.assertEqual(sum(',readonly' in item for item in verify_command), 5)
        migration.verify_original_volumes(self.run_docker, result, self.helper)
        self.assertIn('--verify-source', [call for call in self.calls if call[1] == 'create'][-1])

    def test_source_only_args_refuse_other_modes_or_extra_mounts(self):
        names = self.names[:2]
        for mode in (None, '--verify', '--verify-fresh'):
            with self.subTest(mode=mode), self.assertRaises(ValueError):
                migration.helper_args(names, self.helper, self.token, mode)
        args = migration.helper_args(names, self.helper, self.token, '--verify-source')
        mounts = [item for item in args if item.startswith('type=')]
        self.assertEqual(len(mounts), 3)
        self.assertTrue(all(',readonly' in item for item in mounts))
        self.assertFalse(any('/target/' in item for item in mounts))
        with self.assertRaisesRegex(ValueError, 'mounts changed'):
            migration.validate_helper_mounts([], names, self.helper, '--verify-source')

    def test_legacy_raw_modes_receipt_is_bounded_and_exact(self):
        result = self.migrate()['copy']
        valid = dict(result, legacy_directory_modes={'data/caddy': 0o1777, 'config/caddy': 0o1777})
        self.assertEqual(migration.validate_copy_receipt(valid), valid)
        for value in ({}, {'data/caddy': 0o777}, {'data/nested/caddy': 0o1777}, {'data/caddy': True}):
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, 'legacy'):
                migration.validate_copy_receipt(dict(result, legacy_directory_modes=value))

    def test_helper_capability_spellings_and_malformed_refusal(self):
        host = {'Privileged': False, 'AutoRemove': False, 'RestartPolicy': {'Name': 'no'},
                'PidMode': '', 'IpcMode': '', 'SecurityOpt': ['no-new-privileges:true'], 'CapDrop': ['ALL']}
        for added in (['CHOWN', 'FOWNER', 'DAC_READ_SEARCH'],
                      ['CAP_CHOWN', 'CAP_FOWNER', 'CAP_DAC_READ_SEARCH'],
                      ['CHOWN', 'CAP_FOWNER', 'DAC_READ_SEARCH']):
            migration.validate_helper_host(dict(host, CapAdd=added))
        for added, dropped in ((['CHOWN', 'CAP_CHOWN', 'FOWNER', 'DAC_READ_SEARCH'], ['ALL']),
                               (['CAP_CHOWN', 'CAP_FOWNER', 'CAP_DAC_READ_SEARCH', 'SYS_ADMIN'], ['ALL']),
                               (['cap_chown', 'FOWNER', 'DAC_READ_SEARCH'], ['ALL']),
                               (['CAP_CAP_CHOWN', 'FOWNER', 'DAC_READ_SEARCH'], ['ALL']),
                               (['CAP_ALL'], ['ALL']), ('CHOWN', ['ALL']), (None, ['ALL']), ({'CHOWN': True}, ['ALL']), ([1], ['ALL']),
                               (['CHOWN', 'FOWNER', 'DAC_READ_SEARCH'], ['CAP_ALL']),
                               (['CHOWN', 'FOWNER', 'DAC_READ_SEARCH'], ['ALL', 'ALL']),
                               (['CHOWN', 'FOWNER', 'DAC_READ_SEARCH'], 'ALL')):
            with self.subTest(added=added, dropped=dropped), self.assertRaises(ValueError):
                migration.validate_helper_host(dict(host, CapAdd=added, CapDrop=dropped))

    def test_writer_and_destination_mismatch_refuse_before_copy(self):
        self.writer = True
        with self.assertRaises(ValueError):
            self.migrate()
        self.assertFalse(any(call[1] == 'create' for call in self.calls))
        self.writer = False
        self.calls.clear()
        self.volumes['new_data']['Labels'] = {}
        with self.assertRaises(ValueError):
            self.migrate()
        self.assertFalse(any(call[1] == 'create' for call in self.calls))

    def test_timeout_stops_exact_owned_helper_and_preserves_primary(self):
        self.start_error = TimeoutError('start timeout')
        with self.assertRaises(TimeoutError) as caught:
            self.migrate()
        self.assertIs(caught.exception, self.start_error)
        self.assertIn(['docker', 'stop', '--time', '5', self.helper_id], self.calls)
        self.assertIn(['docker', 'rm', self.helper_id], self.calls)

    def test_lost_create_ack_resolves_owned_name_before_cleanup(self):
        self.create_error = TimeoutError('create timeout')
        with self.assertRaises(TimeoutError) as caught:
            self.migrate()
        self.assertIs(caught.exception, self.create_error)
        self.assertIn(['docker', 'rm', self.helper_id], self.calls)
        self.assertFalse(any(call[1] == 'start' for call in self.calls))

    def test_ambiguous_stop_never_commits_or_removes(self):
        self.start_error = TimeoutError('start timeout')
        self.stop_error = True
        with self.assertRaises(TimeoutError) as caught:
            self.migrate()
        self.assertIs(caught.exception, self.start_error)
        self.assertTrue(any('UNKNOWN' in note for note in caught.exception.__notes__))
        self.assertFalse(any(call[1] == 'rm' for call in self.calls))


if __name__ == '__main__':
    unittest.main()
