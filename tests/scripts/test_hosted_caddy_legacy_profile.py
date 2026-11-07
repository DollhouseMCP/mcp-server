"""Pure legacy-profile checks; no Docker or host interaction."""
import copy
import importlib.util
from pathlib import Path
import unittest

PATH = Path(__file__).resolve().parents[2] / 'scripts/hosted-deploy/caddy_legacy_profile.py'
spec = importlib.util.spec_from_file_location('caddy_legacy_profile', PATH)
profile = importlib.util.module_from_spec(spec)
spec.loader.exec_module(profile)


def fixture():
    image_id = 'sha256:' + 'a' * 64
    conf = {'Cmd': ['run', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile'],
            'Entrypoint': ['caddy'], 'WorkingDir': '/srv', 'User': '',
            'Env': ['PATH=/usr/bin:/bin', 'CADDY_VERSION=2.8', 'XDG_DATA_HOME=/data', 'XDG_CONFIG_HOME=/config']}
    container = {'Id': 'b' * 64, 'Name': '/site-caddy', 'Image': image_id, 'Config': copy.deepcopy(conf),
                 'HostConfig': {'Privileged': False, 'ReadonlyRootfs': False, 'NetworkMode': 'site_default',
                                'ShmSize': 67108864,
                                'RestartPolicy': {'Name': 'unless-stopped', 'MaximumRetryCount': 0},
                                'LogConfig': {'Type': 'json-file', 'Config': {'max-size': '25m', 'max-file': '5'}},
                                'MaskedPaths': profile.MASKED_PATHS, 'ReadonlyPaths': profile.READONLY_PATHS,
                                'PortBindings': {'80/tcp': [{'HostIp': '0.0.0.0', 'HostPort': '80'}]}},
                 'NetworkSettings': {'Networks': {'site_default': {'Aliases': ['site-caddy', 'caddy']}}},
                 'Mounts': [{'Type': 'bind', 'Source': '/srv/site/Caddyfile', 'Destination': '/etc/caddy/Caddyfile', 'RW': False},
                            {'Type': 'volume', 'Name': 'site_data', 'Destination': '/data', 'RW': True},
                            {'Type': 'volume', 'Name': 'site_config', 'Destination': '/config', 'RW': True}]}
    image = {'Id': image_id, 'Config': conf, 'Os': 'linux', 'Architecture': 'arm64',
             'RepoDigests': [], 'RootFS': {'Type': 'layers', 'Layers': ['sha256:' + 'c' * 64]}}
    container['Config']['Labels'] = {'com.docker.compose.project': 'site', 'com.docker.compose.service': 'caddy'}
    return container, image


class LegacyProfileTests(unittest.TestCase):
    def test_legacy_port_and_log_digits_remain_ascii(self):
        binding = [{'HostIp': '127.0.0.1', 'HostPort': '80'}]
        profile.legacy_port('80/tcp', binding)
        for digit in ('١', '１'):
            with self.subTest(digit=digit), self.assertRaises(ValueError):
                profile.legacy_port('8' + digit + '/tcp', binding)
            with self.subTest(digit=digit), self.assertRaises(ValueError):
                profile.legacy_port('80/tcp', [{'HostIp': '127.0.0.1', 'HostPort': '8' + digit}])
            container, _ = fixture()
            container['HostConfig']['LogConfig']['Config']['max-size'] = '1' + digit + 'm'
            with self.subTest(digit=digit), self.assertRaises(ValueError):
                profile.legacy_restart_and_logging(container['HostConfig'])
    def test_exact_image_defaults_and_mounts(self):
        container, image = fixture()
        result = profile.validate_legacy_profile(container, image, '/srv/site/Caddyfile', 'site_default')
        self.assertEqual((result['data_volume'], result['config_volume']), ('site_data', 'site_config'))
        self.assertEqual(result['image_id'], image['Id'])

    def test_unsupported_differences_refuse(self):
        for mutation in ('environment', 'command', 'image', 'mount', 'capability', 'volume'):
            container, image = fixture()
            if mutation == 'environment': container['Config']['Env'].append('SECRET=redacted')
            if mutation == 'command': container['Config']['Cmd'] = ['sh']
            if mutation == 'image': image['Id'] = 'sha256:' + 'd' * 64
            if mutation == 'mount': container['Mounts'][0]['RW'] = True
            if mutation == 'capability': container['HostConfig']['CapAdd'] = ['SYS_ADMIN']
            if mutation == 'volume': container['Mounts'][2]['Name'] = 'site_data'
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                profile.validate_legacy_profile(container, image, '/srv/site/Caddyfile', 'site_default')


if __name__ == '__main__':
    unittest.main()
