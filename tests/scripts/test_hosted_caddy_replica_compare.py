"""A replica inventory matches the live one only where it can, and every other difference needs a reason.

Synthetic inventories only.
"""
import copy
import json
from pathlib import Path
import subprocess
import sys
import unittest

SCRIPTS = Path(__file__).resolve().parents[2] / 'scripts'
sys.path.insert(0, str(SCRIPTS / 'hosted-replica'))
import compare_inventory as compare

IMAGE = 'sha256:' + 'a' * 64
LIVE = {
    'observed_utc': '2026-01-01T00:00:00+00:00', 'elapsed_seconds': 1.5,
    'engine_info': {'Driver': 'overlayfs', 'Containers': 3, 'SecurityOptions': ['name=seccomp', 'name=apparmor']},
    'containers': [{
        'name': '/app', 'id': 'b' * 64, 'image_id': IMAGE, 'created': '2026-01-01T00:00:00.5Z', 'restart_count': 0,
        'args': ['node', 'index.js'], 'state': {'Status': 'running', 'Pid': 41, 'StartedAt': '2026-01-01T00:00:01Z'},
        'config': {'env': {'names': ['B', 'A']}, 'labels': {'token': {'length': 32, 'redacted': 'str'}}},
        'host_config': {'NetworkMode': 'container:' + 'c' * 64, 'Memory': 1024},
        'networks': {'default': {'IPAddress': '172.18.0.2', 'Aliases': ['app', 'web'], 'NetworkID': 'd' * 64}}}],
    'images': [{'id': IMAGE, 'repo_tags': ['example:1'], 'rootfs': {'Layers': ['sha256:' + 'e' * 64]}}],
    'networks': [{'name': 'default', 'containers': {'b' * 64: {'Name': 'app', 'IPv4Address': '172.18.0.2/16'}}}],
    'deployment': {'entries': [{'name': 'compose.yml', 'mode': '0600', 'links': 1, 'sha256': 'f' * 64}],
                   'filesystem': {'available_bytes': 10}},
    'listeners': [{'protocol': 'tcp', 'port': 443, 'address': '0.0.0.0', 'uid': 0},
                  {'protocol': 'udp', 'port': 68, 'address': '203.0.113.7', 'uid': 998}],
}


def replica():
    """The same deployment on another host: its own identifiers, times, addresses and counters."""
    other = copy.deepcopy(LIVE)
    other.update(observed_utc='2026-02-02T00:00:00+00:00', elapsed_seconds=9.0)
    other['engine_info'].update(Containers=7, SecurityOptions=['name=apparmor', 'name=seccomp'])
    container = other['containers'][0]
    container.update(id='1' * 64, created='2026-02-02T00:00:00.25Z', restart_count=2)
    container['state'].update(Pid=977, StartedAt='2026-02-02T00:00:01Z')
    container['config']['env']['names'] = ['A', 'B']
    container['host_config']['NetworkMode'] = 'container:' + '2' * 64
    container['networks']['default'].update(IPAddress='172.20.0.9', Aliases=['web', 'app'], NetworkID='3' * 64)
    other['networks'][0]['containers'] = {'1' * 64: {'Name': 'app', 'IPv4Address': '172.20.0.9/16'}}
    other['deployment']['entries'][0]['links'] = 4
    other['deployment']['filesystem']['available_bytes'] = 99
    other['listeners'] = [{'protocol': 'udp', 'port': 68, 'address': '198.51.100.9', 'uid': 998},
                          {'protocol': 'tcp', 'port': 443, 'address': '0.0.0.0', 'uid': 0}]
    return other


def paths(report):
    return [(item['path'], item['difference']) for item in report['unexplained']]


class CompareTests(unittest.TestCase):
    def test_another_host_with_the_same_deployment_is_equivalent(self):
        report = compare.compare(LIVE, replica())
        self.assertEqual((report['unexplained'], report['equivalent']), ([], True))

    def test_configuration_differences_are_found_by_name(self):
        other = replica()
        other['containers'][0]['host_config']['Memory'] = 2048
        other['containers'][0]['args'] = ['node', 'other.js']
        other['containers'][0]['config']['env']['names'] = ['A', 'C']
        other['containers'].append(dict(other['containers'][0], name='/extra'))
        other['deployment']['entries'][0]['mode'] = '0644'
        other['listeners'].pop()
        self.assertEqual(paths(compare.compare(LIVE, other)), [
            ('containers[/app].args[1]', 'value differs'),
            ('containers[/app].config.env.names[B]', 'missing on the replica'),
            ('containers[/app].config.env.names[C]', 'only on the replica'),
            ('containers[/app].host_config.Memory', 'value differs'),
            ('containers[/extra]', 'only on the replica'),
            ('deployment.entries[compose.yml].mode', 'value differs'),
            ('listeners[tcp/443 on 0.0.0.0]', 'missing on the replica')])

    def test_content_identities_must_be_equal(self):
        other = replica()
        other['containers'][0]['image_id'] = 'sha256:' + '9' * 64
        other['deployment']['entries'][0]['sha256'] = '8' * 64
        other['images'][0]['rootfs']['Layers'] = ['sha256:' + '7' * 64]
        self.assertEqual(paths(compare.compare(LIVE, other)), [
            ('containers[/app].image_id', 'content differs'),
            ('deployment.entries[compose.yml].sha256', 'content differs'),
            ('images[sha256:%s].rootfs.Layers[0]' % ('a' * 64), 'content differs')])

    def test_an_identifier_is_not_equal_to_a_value_of_another_kind(self):
        other = replica()
        other['containers'][0]['id'] = 'not-an-identifier'
        other['containers'][0]['state']['StartedAt'] = 'yesterday'
        other['containers'][0]['networks']['default']['NetworkID'] = '3' * 32
        self.assertEqual(paths(compare.compare(LIVE, other)), [
            ('containers[/app].id', 'value differs'), ('containers[/app].networks.default.NetworkID', 'value differs'),
            ('containers[/app].state.StartedAt', 'value differs')])

    def test_type_and_presence_changes_are_differences(self):
        other = replica()
        other['containers'][0]['config']['labels']['token'] = 'plain'
        del other['engine_info']['Driver']
        other['engine_info']['Extra'] = True
        self.assertEqual(paths(compare.compare(LIVE, other)), [
            ('containers[/app].config.labels.token', 'type dict on live, str on the replica'),
            ('engine_info.Driver', 'missing on the replica'), ('engine_info.Extra', 'only on the replica')])

    def test_a_difference_is_accepted_only_with_a_matching_reason(self):
        other = replica()
        other['containers'][0]['host_config']['Memory'] = 2048
        other['engine_info']['Driver'] = 'other'
        allowed = [{'path': r'containers\[/app\]\.host_config\.Memory', 'reason': 'smaller host'}]
        report = compare.compare(LIVE, other, allowed)
        self.assertEqual(report['accepted'], [
            {'path': 'containers[/app].host_config.Memory', 'difference': 'value differs', 'reason': 'smaller host'}])
        self.assertEqual((paths(report), report['equivalent']), ([('engine_info.Driver', 'value differs')], False))

    def test_an_allowance_must_match_the_whole_path_and_be_used(self):
        other = replica()
        other['containers'][0]['host_config']['Memory'] = 2048
        partial = compare.compare(LIVE, other, [{'path': r'containers\[/app\]', 'reason': 'too broad a prefix'}])
        self.assertEqual((len(partial['unexplained']), partial['unused_allowances']), (1, [r'containers\[/app\]']))
        stale = compare.compare(LIVE, replica(), [{'path': r'engine_info\.Driver', 'reason': 'no longer needed'}])
        self.assertEqual((stale['unexplained'], stale['unused_allowances'], stale['equivalent']),
                         ([], [r'engine_info\.Driver'], False))

    def test_report_names_paths_and_never_values(self):
        other = replica()
        other['engine_info']['Driver'] = 'Zq7-SENTINEL-value'
        self.assertNotIn('SENTINEL', json.dumps(compare.compare(LIVE, other)))

    def run_script(self, *documents):
        return subprocess.run([sys.executable, str(SCRIPTS / 'hosted-replica' / 'compare_inventory.py')],
                              input='\n'.join(json.dumps(document, indent=1) for document in documents).encode('utf-8'),
                              capture_output=True, check=False)

    def test_exit_status_follows_the_verdict(self):
        different = replica()
        different['engine_info']['Driver'] = 'other'
        self.assertEqual(self.run_script(LIVE, replica()).returncode, 0)
        self.assertEqual(self.run_script(LIVE, different).returncode, 3)
        allowed = [{'path': r'engine_info\.Driver', 'reason': 'declared'}]
        self.assertEqual(self.run_script(LIVE, different, allowed).returncode, 0)
        self.assertNotEqual(self.run_script(LIVE, different, [{'path': 'x'}]).returncode, 0)
        self.assertNotEqual(self.run_script(LIVE).returncode, 0)


if __name__ == '__main__':
    unittest.main()
