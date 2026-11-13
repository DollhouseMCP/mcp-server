"""Exact hardened predecessor checks without a Docker daemon."""
import copy
import importlib.util
import json
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts/hosted-deploy'))
import caddy_hardened_profile
import caddy_hardened_receipt
import test_hosted_caddy_legacy_profile as fixtures


def hardened():
    container, image = fixtures.fixture()
    ref = 'registry.example.test/team/caddy@sha256:' + 'a' * 64
    approved = json.loads((ROOT / 'scripts/hosted-deploy/caddy-qualified-native-graphs.json').read_bytes())
    graph = approved['architectures']['arm64']
    image['Id'] = graph['config_digest']
    container['Image'] = image['Id']
    container['Config']['Image'] = ref
    container['Config']['User'] = '1001:1001'
    image['Config']['User'] = '1001:1001'
    host = container['HostConfig']
    host.update({'ReadonlyRootfs': True, 'CapDrop': ['ALL'], 'CapAdd': ['NET_BIND_SERVICE'],
                 'SecurityOpt': ['no-new-privileges:true'],
                 'Sysctls': {'net.ipv4.ip_unprivileged_port_start': '1024'},
                 'Tmpfs': {'/tmp': 'noexec,nosuid,nodev,size=64M,mode=1777'}})
    admission = {'reference': ref, 'platform': 'linux/arm64', 'store_id': image['Id'], 'store_id_role': 'config',
                 'manifest_digest': graph['manifest_digest'], 'config_digest': graph['config_digest'],
                 'root_digest': graph['manifest_digest'], 'admission_descriptor': None, 'diff_ids': graph['diff_ids'],
                 'tested_checkout': approved['tested_checkout'], 'source_head': approved['source_head'],
                 'workflow_run': approved['workflow_run'], 'workflow_attempt': approved['attempt']}
    ports = [{'container_port': '80/tcp', 'host_ip': '0.0.0.0', 'host_port': '80'}]
    return container, image, admission, ports


class HardenedProfileTests(unittest.TestCase):
    def test_hardened_logging_requires_ascii_digits(self):
        caddy_hardened_receipt.validate_hardened_logging({'max-size': '25m', 'max-file': '5'})
        for digit in ('١', '１'):
            for key in ('max-size', 'max-file'):
                options = {'max-size': '25m', 'max-file': '5'}
                options[key] = '1' + digit + ('m' if key == 'max-size' else '')
                with self.subTest(digit=digit, key=key), self.assertRaises(ValueError):
                    caddy_hardened_receipt.validate_hardened_logging(options)
    def validate(self, container, image, admission, ports):
        return caddy_hardened_profile.validate_hardened_profile(container, image, admission, 'site',
                                                               '/srv/site/Caddyfile', ['site_data', 'site_config'], ports)

    def test_exact_profile(self):
        container, image, admission, ports = hardened()
        result = self.validate(container, image, admission, ports)
        self.assertEqual(result['container_id'], container['Id'])
        self.assertEqual(result['kind'], 'hardened')

    def test_observed_capability_spelling_and_malformed_refusal(self):
        for added in (['NET_BIND_SERVICE'], ['CAP_NET_BIND_SERVICE']):
            container, image, admission, ports = hardened()
            container['HostConfig']['CapAdd'] = added
            self.assertEqual(self.validate(container, image, admission, ports)['kind'], 'hardened')
        for added, dropped in ((['CAP_NET_BIND_SERVICE', 'NET_BIND_SERVICE'], ['ALL']),
                               (['CAP_NET_BIND_SERVICE', 'SYS_ADMIN'], ['ALL']),
                               (['cap_net_bind_service'], ['ALL']), (['CAP_CAP_NET_BIND_SERVICE'], ['ALL']),
                               (['CAP_ALL'], ['ALL']), ('CAP_NET_BIND_SERVICE', ['ALL']), (None, ['ALL']),
                               ({'NET_BIND_SERVICE': True}, ['ALL']), ([1], ['ALL']),
                               (['CAP_NET_BIND_SERVICE'], ['CAP_ALL']), (['CAP_NET_BIND_SERVICE'], ['ALL', 'ALL']),
                               (['CAP_NET_BIND_SERVICE'], 'ALL')):
            container, image, admission, ports = hardened()
            container['HostConfig'].update(CapAdd=added, CapDrop=dropped)
            with self.subTest(added=added, dropped=dropped), self.assertRaises(ValueError):
                self.validate(container, image, admission, ports)

    def test_runtime_or_identity_drift_refuses(self):
        for key in ('image', 'user', 'readonly', 'capabilities', 'security', 'sysctl', 'tmpfs', 'volume', 'port', 'environment'):
            container, image, admission, ports = hardened()
            if key == 'image': container['Image'] = 'sha256:' + 'f' * 64
            if key == 'user': container['Config']['User'] = '0'
            if key == 'readonly': container['HostConfig']['ReadonlyRootfs'] = False
            if key == 'capabilities': container['HostConfig']['CapAdd'] = ['SYS_ADMIN']
            if key == 'security': container['HostConfig']['SecurityOpt'] = []
            if key == 'sysctl': container['HostConfig']['Sysctls'] = {}
            if key == 'tmpfs': container['HostConfig']['Tmpfs']['/tmp'] = 'size=64M,mode=1777'
            if key == 'volume': container['Mounts'][1]['Name'] = 'other'
            if key == 'port': ports = []
            if key == 'environment': container['Config']['Env'].append('SECRET=fixture')
            with self.subTest(key=key), self.assertRaises(ValueError):
                self.validate(container, image, admission, ports)


if __name__ == '__main__':
    unittest.main()
