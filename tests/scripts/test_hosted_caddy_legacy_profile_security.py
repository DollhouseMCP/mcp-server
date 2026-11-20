"""Exercise legacy admission boundaries using synthetic Docker inspect data."""
import copy
import importlib.util
from pathlib import Path
import unittest

fixture_path = Path(__file__).with_name('test_hosted_caddy_legacy_profile.py')
spec = importlib.util.spec_from_file_location('legacy_profile_fixture', fixture_path)
fixture_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture_module)
profile = fixture_module.profile


class LegacySecurityTests(unittest.TestCase):
    def validate(self, container, image):
        return profile.validate_legacy_profile(container, image, '/srv/site/Caddyfile', 'site_default')

    def test_unsupported_host_overrides(self):
        overrides = {
            'Privileged': True, 'ReadonlyRootfs': True,
            'CapAdd': ['SYS_ADMIN'], 'CapDrop': ['ALL'], 'GroupAdd': ['0'],
            'Devices': [{'PathOnHost': '/dev/sda'}], 'SecurityOpt': ['seccomp=unconfined'],
            'DeviceRequests': [{'Count': -1}], 'ExtraHosts': ['host:127.0.0.1'],
            'Links': ['other:other'], 'VolumesFrom': ['other'],
            'Dns': ['127.0.0.1'], 'DnsOptions': ['ndots:0'], 'DnsSearch': ['example.test'],
            'PidMode': 'host', 'IpcMode': 'host', 'UsernsMode': 'host', 'UTSMode': 'host',
            'Runtime': 'custom', 'Init': True, 'Sysctls': {'net.ipv4.ip_forward': '1'},
            'CgroupnsMode': 'host', 'MaskedPaths': [], 'ReadonlyPaths': [],
        }
        for key, value in overrides.items():
            with self.subTest(field=key):
                container, image = fixture_module.fixture()
                container['HostConfig'][key] = value
                with self.assertRaises(ValueError):
                    self.validate(container, image)

    def test_network_and_alias_refusals(self):
        for case in ('host', 'extra-network', 'foreign-alias', 'duplicate-alias', 'missing-aliases'):
            with self.subTest(case=case):
                container, image = fixture_module.fixture()
                network = container['NetworkSettings']['Networks']['site_default']
                if case == 'host':
                    container['HostConfig']['NetworkMode'] = 'host'
                elif case == 'extra-network':
                    container['NetworkSettings']['Networks']['other'] = copy.deepcopy(network)
                elif case == 'foreign-alias':
                    network['Aliases'].append('postgres')
                elif case == 'duplicate-alias':
                    network['Aliases'].append('caddy')
                else:
                    del network['Aliases']
                with self.assertRaises(ValueError):
                    self.validate(container, image)

    def test_port_refusals(self):
        cases = [
            {}, {'443/udp': [{'HostIp': '0.0.0.0', 'HostPort': '443'}]},
            {'65536/tcp': [{'HostIp': '0.0.0.0', 'HostPort': '80'}]},
            {'80/tcp': [{'HostIp': 'not-an-ip', 'HostPort': '80'}]},
            {'80/tcp': [{'HostIp': '0.0.0.0', 'HostPort': '65536'}]},
            {'80/tcp': [{'HostIp': '0.0.0.0', 'HostPort': '0'}]},
            {'80/tcp': [{'HostIp': '0.0.0.0', 'HostPort': '80', 'extra': True}]},
            {'80/tcp': [{'HostIp': '0.0.0.0', 'HostPort': '80'}, {'HostIp': '::', 'HostPort': '80'}]},
            {'80/tcp': [{'HostIp': '0.0.0.0', 'HostPort': '80'}],
             '8080/tcp': [{'HostIp': '0.0.0.0', 'HostPort': '8080'}]},
        ]
        for index, bindings in enumerate(cases):
            with self.subTest(case=index):
                container, image = fixture_module.fixture()
                container['HostConfig']['PortBindings'] = bindings
                with self.assertRaises(ValueError):
                    self.validate(container, image)

    def test_config_identity_and_source_refusals(self):
        for case in ('container-id', 'image-id', 'layers', 'caddyfile-source', 'user',
                     'working-dir', 'command', 'private-env', 'duplicate-env', 'storage-env'):
            with self.subTest(case=case):
                container, image = fixture_module.fixture()
                if case == 'container-id':
                    container['Id'] = 'not-an-id'
                elif case == 'image-id':
                    image['Id'] = 'sha256:' + 'd' * 64
                elif case == 'layers':
                    image['RootFS']['Layers'] = ['not-a-digest']
                elif case == 'caddyfile-source':
                    container['Mounts'][0]['Source'] = '/other/Caddyfile'
                elif case == 'user':
                    container['Config']['User'] = '1001'
                elif case == 'working-dir':
                    container['Config']['WorkingDir'] = '/other'
                elif case == 'command':
                    container['Config']['Cmd'] = ['run', '--config', '/other/Caddyfile']
                else:
                    addition = {'private-env': 'TOKEN=synthetic', 'duplicate-env': 'PATH=/usr/bin',
                                'storage-env': 'XDG_DATA_HOME=/other'}[case]
                    container['Config']['Env'].append(addition)
                with self.assertRaises(ValueError):
                    self.validate(container, image)

    def test_supported_tls_bindings_are_retained(self):
        container, image = fixture_module.fixture()
        container['HostConfig']['PortBindings']['443/tcp'] = [{'HostIp': '::1', 'HostPort': '8443'}]
        result = self.validate(container, image)
        self.assertEqual(result['ports'], [
            {'container_port': '443/tcp', 'host_ip': '::1', 'host_port': '8443'},
            {'container_port': '80/tcp', 'host_ip': '0.0.0.0', 'host_port': '80'},
        ])


if __name__ == '__main__':
    unittest.main()
