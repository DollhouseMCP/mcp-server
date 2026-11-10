"""Verify concrete, private legacy selection model without a Docker daemon."""
import copy
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts' / 'hosted-deploy'))
from legacy_control_compose import model
from legacy_reconcile_action import check_compose


def service(identifier, name, labels, mounts, ports=None):
    return {'Id': identifier, 'Name': '/' + name, 'Image': 'sha256:' + identifier,
            'Config': {'Env': ['FIXTURE_PRIVATE=literal$variable'], 'Cmd': ['node', 'test$script'],
                       'Labels': labels, 'User': '1000:1000', 'Healthcheck': {'Test': ['CMD', 'node', 'check'],
                                                                           'Interval': 1000000000, 'Retries': 3}},
            'HostConfig': {'NetworkMode': 'site_default', 'RestartPolicy': {'Name': 'unless-stopped'},
                           'LogConfig': {'Type': 'json-file', 'Config': {'max-size': '10m'}},
                           'PortBindings': ports or {}, 'Privileged': False},
            'Mounts': mounts, 'NetworkSettings': {'Networks': {'site_default': {'Aliases': [name, identifier[:12]]}}}}


class LegacyComposeTests(unittest.TestCase):
    def setUp(self):
        self.app = service('a' * 64, 'site', {}, [{'Type': 'bind', 'Destination': '/portfolio',
                                                'Source': '/fixture/portfolio', 'RW': True}])
        self.pg = service('b' * 64, 'site-postgres', {}, [{'Type': 'volume', 'Destination': '/pg',
                                                       'Name': 'old-pg', 'RW': True}])
        self.proxy = service('c' * 64, 'site-caddy', {}, [{'Type': 'bind', 'Destination': '/etc/caddy/Caddyfile',
                                                         'Source': '/protected/original/Caddyfile', 'RW': False}],
                             {'443/tcp': [{'HostIp': '0.0.0.0', 'HostPort': '443'}]})

    def test_control_model_uses_existing_ids_external_storage_and_literal_environment(self):
        result = model('site', self.app, self.pg, self.proxy)
        app, pg, proxy = [result['services'][name] for name in ('dollhousemcp', 'postgres', 'caddy')]
        self.assertEqual(app['image'], self.app['Image'])
        self.assertEqual(pg['image'], self.pg['Image'])
        self.assertEqual(proxy['image'], self.proxy['Image'])
        self.assertEqual(app['environment'], {'FIXTURE_PRIVATE': 'literal$$variable'})
        self.assertEqual(app['command'], ['node', 'test$$script'])
        self.assertEqual(app['healthcheck']['interval'], '1000000000ns')
        self.assertEqual(app['networks']['serving']['aliases'], ['site'])
        self.assertEqual(proxy['volumes'][0]['source'], '/protected/original/Caddyfile')
        self.assertTrue(proxy['volumes'][0]['read_only'])
        self.assertFalse(proxy['volumes'][0]['bind']['create_host_path'])
        self.assertEqual(proxy['ports'][0]['published'], '443')
        self.assertEqual(result['networks'], {'serving': {'external': True, 'name': 'site_default'}})
        self.assertEqual(result['volumes'], {'old-pg': {'external': True, 'name': 'old-pg'}})
        self.assertTrue(all('build' not in item and 'env_file' not in item for item in (app, pg, proxy)))

    def test_canonical_compose_dollars_are_compared_without_losing_literal_values(self):
        self.app['Config']['Env'] = ['DOLLAR=one$two', 'ESCAPED=one$$two']
        data = {'app': self.app, 'postgres': self.pg, 'proxy': self.proxy}
        result = model('site', self.app, self.pg, self.proxy)
        with patch('legacy_reconcile_action.bounded_input', return_value=json.dumps(result).encode()):
            check_compose('/fixture/compose.yml', Path('/fixture'), 'site', data)
        result['services']['dollhousemcp']['environment']['ESCAPED'] = 'one$$two'
        with patch('legacy_reconcile_action.bounded_input', return_value=json.dumps(result).encode()):
            with self.assertRaisesRegex(ValueError, 'environment or service identity differs'):
                check_compose('/fixture/compose.yml', Path('/fixture'), 'site', data)

    def test_invalid_environment_duplicate_mount_or_changed_network_refuses(self):
        for field, changed in (('Config', {**self.app['Config'], 'Env': ['KEY=one', 'KEY=two']}),
                               ('Mounts', self.app['Mounts'] * 2),
                               ('NetworkSettings', {'Networks': {'unknown': {}}})):
            with self.subTest(field=field):
                app = copy.deepcopy(self.app)
                app[field] = changed
                with self.assertRaises(ValueError):
                    model('site', app, self.pg, self.proxy)


if __name__ == '__main__':
    unittest.main()
