"""Disposable inspect records: no host or service operations."""
import copy
import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts' / 'hosted-deploy'))
import legacy_recovery_guards as guards
from legacy_recovery_profile import profile

APP, PROXY, CANARY = 'a' * 64, 'b' * 64, 'c' * 64


def container(identifier, name, network, aliases, ports=None):
    return {'Id': identifier, 'Name': '/' + name, 'Image': 'sha256:' + 'd' * 64,
            'Config': {'Labels': {}}, 'Mounts': [], 'RestartCount': 0,
            'HostConfig': {'NetworkMode': network, 'PortBindings': ports or {}},
            'NetworkSettings': {'Ports': ports or {}, 'Networks': {network: {'Aliases': aliases}}},
            'State': {'Running': True, 'Restarting': False, 'OOMKilled': False,
                      'StartedAt': '2026-01-01T00:00:00Z', 'Health': {'Status': 'healthy'}}}


class RecoveryGuardsTests(unittest.TestCase):
    def setUp(self):
        self.app = container(APP, 'site', 'site_default', ['site', 'dollhousemcp'])
        self.proxy = container(PROXY, 'site-caddy', 'site_default', ['caddy'])
        self.canary = container(CANARY, 'site-canary', 'site-canary_default', ['dollhousemcp'],
                                {'3000/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '3100'}]})
        self.records = [self.app, self.proxy, self.canary]
        self.ports = [{'host_ip': '0.0.0.0', 'host_port': '80', 'container_port': '80/tcp'},
                      {'host_ip': '0.0.0.0', 'host_port': '443', 'container_port': '443/tcp'}]
        self.commands = []

    def docker_run(self, command, timeout, maximum):
        self.commands.append(command)
        if command[1:4] == ['ps', '--no-trunc', '--quiet']:
            return '\n'.join(item['Id'] for item in self.records).encode()
        if command[1:3] == ['container', 'inspect']:
            return json.dumps([next(item for item in self.records if item['Id'] == command[-1])]).encode()
        raise AssertionError(command)

    def test_isolated_canary_3100_is_not_serving_ingress_or_serving_dns(self):
        guards.ingress_available(self.docker_run, self.ports)
        guards.serving_dns(self.docker_run, 'site', APP)
        self.assertTrue(all(command[1] in ('ps', 'container') for command in self.commands))

    def test_conflicting_configured_or_actual_port_and_host_network_refuse(self):
        for field in ('HostConfig', 'NetworkSettings'):
            key = 'PortBindings' if field == 'HostConfig' else 'Ports'
            old = self.canary[field][key]
            self.canary[field][key] = {'3000/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '443'}]}
            with self.assertRaisesRegex(ValueError, 'owns recovery ingress'):
                guards.ingress_available(self.docker_run, self.ports)
            self.canary[field][key] = old
        self.canary['HostConfig']['NetworkMode'] = 'host'
        with self.assertRaisesRegex(ValueError, 'UNKNOWN ingress'):
            guards.ingress_available(self.docker_run, self.ports)

    def test_missing_malformed_or_unknown_port_inventory_never_means_free(self):
        for value in (None, [], {'80/tcp': 'unknown'}, {'80/tcp': [{'HostPort': '80'}]},
                      {'80/sctp': []}, {'80/tcp': [{'HostIp': '0.0.0.0', 'HostPort': '0'}]}):
            with self.subTest(value=value), self.assertRaises(ValueError):
                guards.published(value)
        self.assertEqual(guards.published({'80/tcp': None}), set())
        self.assertTrue(guards.overlaps(('::', 443, 'tcp'), ('127.0.0.1', 443, 'tcp')))
        self.assertFalse(guards.overlaps(('0.0.0.0', 443, 'tcp'), ('0.0.0.0', 443, 'udp')))

    def test_same_alias_on_serving_network_is_ambiguous_even_with_canary_name(self):
        self.canary['NetworkSettings']['Networks']['site_default'] = {'Aliases': ['dollhousemcp']}
        with self.assertRaisesRegex(ValueError, 'DNS is missing or ambiguous'):
            guards.serving_dns(self.docker_run, 'site', APP)
        self.records.remove(self.app)
        with self.assertRaises(ValueError):
            guards.serving_dns(self.docker_run, 'site', APP)

    def test_unknown_network_inventory_refuses(self):
        self.canary['NetworkSettings']['Networks'] = None
        with self.assertRaisesRegex(ValueError, 'inventory is unavailable'):
            guards.serving_dns(self.docker_run, 'site', APP)

    def test_exact_profile_compares_all_fields_but_canonicalizes_mount_order(self):
        self.app['Mounts'] = [{'Type': 'bind', 'Destination': '/a', 'Source': '/fixture/a'},
                              {'Type': 'volume', 'Destination': '/b', 'Name': 'fixture-b', 'Source': '/fixture/b'}]
        expected = copy.deepcopy(profile(self.app))
        self.app['Mounts'].reverse()
        guards.exact_container(self.docker_run, APP, expected, 'site', True)
        self.app['Mounts'][0]['RW'] = True
        with self.assertRaisesRegex(ValueError, 'profile changed'):
            guards.exact_container(self.docker_run, APP, expected, 'site', True)

    def test_lifecycle_unknown_or_changed_boot_is_not_inferred_as_success(self):
        boot = guards.lifecycle(self.app, True)
        self.app['State']['StartedAt'] = 'another-boot'
        with self.assertRaisesRegex(ValueError, 'boot changed'):
            guards.lifecycle(self.app, True, boot)
        self.app['State']['Running'] = False
        self.app['State']['ExitCode'] = 137
        self.app['State']['FinishedAt'] = '2026-01-01T00:01:00Z'
        with self.assertRaisesRegex(ValueError, 'stop cleanly'):
            guards.lifecycle(self.app, False)


if __name__ == '__main__':
    unittest.main()
