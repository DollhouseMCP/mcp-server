"""The same proxy comes back after an abandoned offline preparation, and a later boot is accepted only when recorded.

Inert Docker adapters and private temporary folders. Never real Docker.
"""
import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts' / 'hosted-deploy'))
import test_hosted_caddy_offline_prepare as prepared
import caddy_retired_proxy as retired
import caddy_serving_boot as serving_boot
import caddy_transition_action
import legacy_handoff as handoff
import legacy_recovery_profile as retired_profile
from legacy_recovery_profile import profile

ORIGIN = 'https://site.example.invalid'
PUBLIC = [{'path': '/healthz', 'status': 200}]
ID = 'b' * 64


class AbandonTests(unittest.TestCase):
    """After the real offline preparation of the clone fixture: the proxy is stopped and its clone receipt exists."""

    def setUp(self):
        self.base = prepared.OfflinePrepareTests('test_real_clone_receipt_and_paused_ingress')
        self.base.setUp()
        self.addCleanup(self.base.doCleanups)
        self.fake, self.root = self.base.fake, self.base.fake.root
        binding = patch.object(handoff, 'host_identity', return_value={'hostname': 'fixture', 'machine_id_sha256': 'c' * 64})
        binding.start()
        self.addCleanup(binding.stop)
        self.prepared = self.base.prepare()
        self.proxy = self.fake.proxy
        self.proxy['State']['FinishedAt'] = '2026-11-09T01:00:00Z'
        self.calls, self.checked, self.other, self.start_output = [], [], None, None
        self.config_error = self.public_error = None
        self.value = dict(self.base.request, public_base_url=ORIGIN)

    def run_docker(self, argv, timeout, limit):
        self.calls.append(argv)
        if argv == ['docker', 'start', self.proxy['Id']]:
            self.proxy['State'].update(Running=True, StartedAt='2026-11-09T02:00:00Z')
            return self.start_output or (self.proxy['Id'] + '\n').encode()
        if argv == ['docker', 'ps', '--no-trunc', '--quiet'] and self.other:
            return (self.other['Id'] + '\n').encode()
        if argv[1:3] == ['container', 'inspect'] and self.other and argv[3] == self.other['Id']:
            return json.dumps([self.other]).encode()
        if argv[:2] == ['docker', 'stop'] and argv[-1] == self.proxy['Id']:
            self.proxy['State'].update(Running=False, FinishedAt='2026-11-09T03:00:00Z')
            return (argv[-1] + '\n').encode()
        return self.base.run_docker(argv, timeout, limit)

    def config(self, identifier, receipt, record, boot):
        self.checked.append((identifier, str(receipt), record['caddyfile_sha256'], boot))
        if self.config_error:
            raise self.config_error

    def public(self, origin):
        self.checked.append(origin)
        if self.public_error:
            raise self.public_error
        return PUBLIC

    def act(self, action=serving_boot.ACTIONS[0]):
        self.calls.clear()
        with patch.dict('os.environ', {'DOCKER_HOST': ''}), patch.object(serving_boot.time, 'sleep'), \
                patch.object(serving_boot, 'READY_WAIT', 0), patch.object(serving_boot, 'ACCEPT_WAIT', 0):
            return serving_boot.act(action, self.value, self.run_docker, lambda reference: {'reference': reference},
                                    self.config, self.public)

    def started(self):
        return [item for item in self.calls if item == ['docker', 'start', self.proxy['Id']]]

    def test_the_same_proxy_is_started_once_checked_and_recorded(self):
        result = self.act()
        self.assertEqual((result['outcome'], result['proxy_id'], result['ingress']), ('ABANDONED', self.proxy['Id'], 'open'))
        self.assertEqual(self.started(), [['docker', 'start', self.proxy['Id']]])
        self.assertTrue(self.proxy['State']['Running'])
        boot = {'started_at': '2026-11-09T02:00:00Z', 'restart_count': 0}
        sha = json.loads((Path(self.prepared['receipt']) / 'receipt.json').read_bytes())['caddyfile_sha256']
        self.assertEqual(self.checked, [(self.proxy['Id'], self.prepared['receipt'], sha, boot), ORIGIN])
        receipt = json.loads(Path(result['receipt']).read_bytes())
        self.assertEqual((receipt['previous'], receipt['boot'], receipt['reason'], receipt['public']),
                         ({'started_at': '2026-11-09T00:00:00Z', 'restart_count': 0}, boot, 'abandoned-offline-preparation', PUBLIC))
        operation = Path(result['receipt']).parent
        self.assertEqual(sorted(path.name for path in operation.iterdir()), ['RECORDED.json', 'issued.json', 'started.json'])
        self.assertEqual({path.stat().st_mode & 0o777 for path in operation.iterdir()} | {operation.stat().st_mode & 0o777}, {0o600, 0o700})
        # An unreconciled legacy proxy is bound to no boot, so there is no boot record to write.
        self.assertIsNone(receipt['boot_record'])
        self.assertFalse((self.root / retired.DIRECTORY).exists())

    def test_originals_clone_and_source_are_untouched(self):
        before = sorted(str(path) for path in (self.root / '.caddy-recovery').rglob('*'))
        self.act()
        self.assertEqual(sorted(str(path) for path in (self.root / '.caddy-recovery').rglob('*')), before)
        # The clone verification runs its own read-only helper container. Nothing else is created, renamed or removed.
        self.assertFalse(any(item[1:3] in (['volume', 'create'], ['volume', 'rm']) or item[1] == 'rename' for item in self.calls))
        self.assertFalse(any(item[1] in ('rm', 'stop') and item[-1] == self.proxy['Id'] for item in self.calls))
        self.assertEqual((self.root / 'server' / 'app').read_text(), 'fixture')

    def test_a_proxy_that_is_not_the_recorded_one_is_never_started(self):
        changes = {'another container': lambda: self.proxy.update(Id='9' * 64),
                   'changed profile': lambda: self.proxy['HostConfig'].update(Privileged=True),
                   'unclean stop': lambda: self.proxy['State'].update(ExitCode=137),
                   'already running': lambda: self.proxy['State'].update(Running=True)}
        for name, change in changes.items():
            original = copy.deepcopy(self.proxy)
            with self.subTest(name):
                change()
                with self.assertRaises(ValueError):
                    self.act()
                self.assertEqual(self.started(), [])
                self.assertFalse((self.root / retired.BOOTS).exists())
            self.proxy.clear()
            self.proxy.update(original)

    def test_a_taken_port_or_a_pending_transition_refuses_before_the_start(self):
        ports = json.loads((Path(self.prepared['receipt']) / 'receipt.json').read_bytes())['profile']['ports']
        self.other = {'Id': 'c' * 64, 'State': {'Running': True}, 'Mounts': [], 'NetworkSettings': {'Ports': {}},
                      'HostConfig': {'NetworkMode': 'bridge', 'PortBindings': {ports[0]['container_port']: [
                          {'HostIp': ports[0]['host_ip'], 'HostPort': ports[0]['host_port']}]}}}
        with patch.object(serving_boot, 'verify_prepared', return_value=(None, Path(self.prepared['receipt']))):
            with self.assertRaisesRegex(ValueError, 'ingress'):
                self.act()
        self.other = None
        with patch.object(serving_boot, 'require_no_transition', side_effect=ValueError('a Caddy transition is pending')):
            with self.assertRaisesRegex(ValueError, 'pending'):
                self.act()
        self.assertEqual(self.started(), [])

    def test_an_unknown_start_acknowledgement_is_not_a_start(self):
        self.start_output = b'something else\n'
        with self.assertRaisesRegex(ValueError, 'UNKNOWN'):
            self.act()
        self.assertEqual(self.checked, [])

    def test_a_failed_check_after_the_start_closes_ingress_again(self):
        for name in ('config_error', 'public_error'):
            with self.subTest(name):
                self.proxy['State'].update(Running=False, StartedAt='2026-11-09T00:00:00Z', FinishedAt='2026-11-09T01:00:00Z')
                setattr(self, name, ValueError('fixture refusal'))
                with self.assertRaisesRegex(ValueError, 'fixture refusal'):
                    self.act()
                setattr(self, name, None)
                self.assertFalse(self.proxy['State']['Running'])
                stops = [item for item in self.calls if item[:2] == ['docker', 'stop']]
                self.assertEqual(stops, [['docker', 'stop', '--signal', 'SIGTERM', '--timeout', '-1', self.proxy['Id']]])
                operations = sorted((self.root / retired.BOOTS).iterdir(), key=lambda path: path.stat().st_mtime)
                self.assertEqual(sorted(path.name for path in operations[-1].iterdir()),
                                 ['fenced.json', 'issued.json', 'refused.json', 'started.json'])

    def test_request_and_action_are_exact(self):
        for bad in (dict(self.value, token='0' * 32), {key: item for key, item in self.value.items() if key != 'image'},
                    dict(self.value, public_base_url='https://user:pw@site.example.invalid')):
            with self.assertRaises(ValueError):
                serving_boot.act(serving_boot.ACTIONS[0], bad, self.run_docker)
        with self.assertRaises(ValueError):
            serving_boot.act('recover-caddy-proxy', self.value, self.run_docker)
        self.assertEqual(self.calls, [])

    def test_proxy_recovery_names_the_action_instead_of_a_resolved_transition(self):
        with self.assertRaisesRegex(ValueError, 'abandon-caddy-offline'):
            caddy_transition_action.selected_proxy(self.root)


class RecordedBootTests(unittest.TestCase):
    """A reconciled serving proxy: its serving record and authority, written as reconciliation writes them."""

    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name).resolve()
        self.host = {'hostname': 'fixture', 'machine_id_sha256': 'c' * 64}
        binding = patch.object(handoff, 'host_identity', return_value=self.host)
        binding.start()
        self.addCleanup(binding.stop)
        self.proxy = {'Id': ID, 'Name': '/site-caddy', 'Image': 'sha256:' + 'e' * 64, 'RestartCount': 0,
                      'Config': {'Labels': {'com.docker.compose.project': 'site', 'com.docker.compose.service': 'caddy'}},
                      'HostConfig': {}, 'Mounts': [{'Type': 'volume', 'Destination': '/data', 'Name': 'site_data'}],
                      'State': {'Running': True, 'Restarting': False, 'OOMKilled': False, 'ExitCode': 0,
                                'StartedAt': '2026-11-09T00:00:00Z', 'FinishedAt': '0001-01-01T00:00:00Z'}}
        receipt = self.root / '.caddy-recovery' / ('proxy-' + '1' * 32)
        receipt.mkdir(parents=True, mode=0o700)
        receipt.parent.chmod(0o700)
        for path in (receipt / 'Caddyfile', self.root / 'Caddyfile'):
            path.write_bytes(b'fixture caddyfile')
            path.chmod(0o600)
        self.serving = {'id': ID, 'profile': profile(self.proxy), 'boot': {'started_at': '2026-11-09T00:00:00Z', 'restart_count': 0},
                        'caddyfile': str(receipt / 'Caddyfile'), 'caddyfile_sha256': handoff.digest(b'fixture caddyfile')}
        self.setUp_records()
        self.checked = []

    def setUp_records(self):
        operation = self.root / '.legacy-recovery' / ('reconciled-' + 'f' * 32)
        operation.mkdir(parents=True, mode=0o700, exist_ok=True)
        operation.parent.chmod(0o700)
        proof = handoff.encoded({'schema': 'qualified-proxy-retirement-v1', 'host': self.host, 'instance': 'site',
                                 'serving': self.serving})
        self.private(operation / 'retirement-authority.json', proof)
        (self.root / retired.DIRECTORY).mkdir(mode=0o700, exist_ok=True)
        self.private(self.root / retired.DIRECTORY / ('serving-' + ID + '.json'), handoff.encoded({
            'authority': {'path': str(operation / 'retirement-authority.json'), 'sha256': handoff.digest(proof)},
            'serving': self.serving}))

    @staticmethod
    def private(path, raw):
        path.write_bytes(raw)
        path.chmod(0o600)

    def run_docker(self, argv, timeout, maximum):
        if argv[1] == 'ps':
            return (ID + '\n').encode()
        self.assertEqual(argv[1:], ['container', 'inspect', ID])
        return json.dumps([self.proxy]).encode()

    def restart(self, started_at):
        self.proxy['State']['StartedAt'] = started_at

    def accept(self):
        with patch.object(serving_boot.time, 'sleep'), patch.object(serving_boot, 'READY_WAIT', 0), \
                patch.object(serving_boot, 'ACCEPT_WAIT', 0):
            return serving_boot.accept(self.root, {'instance': 'site'}, ORIGIN, self.run_docker,
                                       lambda *arguments: self.checked.append(arguments), lambda origin: PUBLIC)

    def startup(self):
        return retired.startup_path(self.root, 'site', ID, self.run_docker)

    def test_a_restarted_proxy_is_refused_until_its_boot_is_accepted(self):
        self.assertEqual(self.startup(), Path(self.serving['caddyfile']))
        self.restart('2026-11-09T05:00:00Z')
        with self.assertRaisesRegex(ValueError, 'boot changed'):
            self.startup()
        result = self.accept()
        self.assertEqual((result['outcome'], result['proxy_id']), ('ACCEPTED', ID))
        self.assertEqual(self.startup(), Path(self.serving['caddyfile']))
        boot = {'started_at': '2026-11-09T05:00:00Z', 'restart_count': 0}
        self.assertEqual(self.checked, [(ID, Path(self.serving['caddyfile']).parent,
                                        {'caddyfile_sha256': self.serving['caddyfile_sha256']}, boot)])
        receipt = json.loads(Path(result['receipt']).read_bytes())
        self.assertEqual((receipt['reason'], receipt['previous'], receipt['boot']), ('accepted-restart', self.serving['boot'], boot))
        self.assertEqual(set(receipt['restart']), {'observed_utc', 'host_boot_utc', 'docker_daemon_started_utc', 'explained_by'})
        self.assertEqual(retired.inventory(self.root, 'site', self.run_docker), set())

    def test_each_later_boot_needs_its_own_record_and_the_chain_is_followed(self):
        for started_at in ('2026-11-09T05:00:00Z', '2026-11-09T06:00:00Z'):
            self.restart(started_at)
            with self.assertRaisesRegex(ValueError, 'boot changed'):
                self.startup()
            self.accept()
            self.startup()
        self.assertEqual(retired.serving_boot(self.root, 'site', ID, self.serving)['started_at'], '2026-11-09T06:00:00Z')
        self.restart('2026-11-09T05:00:00Z')
        with self.assertRaisesRegex(ValueError, 'boot changed'):
            self.startup()

    def test_nothing_is_accepted_without_a_new_boot_or_for_another_proxy(self):
        with self.assertRaisesRegex(ValueError, 'nothing to accept'):
            self.accept()
        self.restart('2026-11-09T05:00:00Z')
        for key, value in (('Name', '/other-caddy'), ('Image', 'sha256:' + '0' * 64), ('HostConfig', {'Privileged': True})):
            original = self.proxy[key]
            self.proxy[key] = value
            with self.subTest(key), self.assertRaisesRegex(ValueError, 'not the reconciled serving proxy|differs'):
                self.accept()
            self.proxy[key] = original
        self.proxy['State']['Restarting'] = True
        with self.assertRaises(ValueError):
            self.accept()
        self.assertFalse((self.root / retired.BOOTS).exists())

    def reload(self, **host):
        """What a Docker daemon restart does to a container it reloads: a new boot, and empty DNS lists become []."""
        self.restart('2026-11-09T07:00:00Z')
        self.proxy['HostConfig'] = dict({'Dns': [], 'DnsOptions': [], 'DnsSearch': []}, **host)

    def test_a_container_the_daemon_reloaded_is_still_the_same_container(self):
        for before in ({'Dns': None, 'DnsOptions': None, 'DnsSearch': None}, {'Dns': None, 'DnsOptions': [], 'DnsSearch': []}):
            with self.subTest(before=before):
                self.setUp()
                self.proxy['HostConfig'] = dict(before)
                recorded = profile(copy.deepcopy(self.proxy))
                pinned = retired_profile.profile_hash(self.proxy)
                self.reload()
                self.assertNotEqual(profile(self.proxy), recorded)
                self.assertTrue(retired_profile.same_profile(profile(self.proxy), recorded))
                self.assertIn(pinned, retired_profile.profile_hashes(self.proxy))
                self.assertLessEqual(len(retired_profile.profile_hashes(self.proxy)), 8)

    def test_a_real_dns_setting_or_any_other_change_still_refuses(self):
        self.proxy['HostConfig'] = {'Dns': None, 'DnsOptions': None, 'DnsSearch': None, 'Privileged': False}
        recorded, pinned = profile(copy.deepcopy(self.proxy)), retired_profile.profile_hash(self.proxy)
        for name, host in {'a DNS server': {'Dns': ['203.0.113.53']}, 'a DNS option': {'DnsOptions': ['ndots:1']},
                           'a search domain': {'DnsSearch': ['example.invalid']}, 'another field': {'Privileged': True},
                           'another empty list': {'CapAdd': []}}.items():
            with self.subTest(name):
                self.reload(**dict({'Privileged': False}, **host))
                self.assertFalse(retired_profile.same_profile(profile(self.proxy), recorded))
                self.assertNotIn(pinned, retired_profile.profile_hashes(self.proxy))
        self.proxy['HostConfig'] = {'Dns': ['203.0.113.53'], 'DnsOptions': None, 'DnsSearch': None, 'Privileged': False}
        self.assertEqual(retired_profile.profile_hashes(self.proxy) & {pinned}, set())

    def test_the_reconciled_proxy_is_accepted_after_a_daemon_restart_and_not_with_a_changed_setting(self):
        self.proxy['HostConfig'] = {'Dns': None, 'DnsOptions': None, 'DnsSearch': None}
        self.serving['profile'] = profile(copy.deepcopy(self.proxy))
        self.setUp_records()
        self.reload(Dns=['203.0.113.53'])
        with self.assertRaisesRegex(ValueError, 'not the reconciled serving proxy'):
            self.accept()
        self.reload()
        self.assertEqual(self.accept()['outcome'], 'ACCEPTED')
        self.assertEqual(self.startup(), Path(self.serving['caddyfile']))

    def records(self):
        return sorted((self.root / retired.DIRECTORY).glob('boot-*.json'))

    def test_a_changed_forged_or_forked_record_refuses(self):
        self.restart('2026-11-09T05:00:00Z')
        receipt_path = Path(self.accept()['receipt'])
        record_path = self.records()[0]
        record, receipt = json.loads(record_path.read_bytes()), receipt_path.read_bytes()
        cases = {
            'another host': dict(record, host={'hostname': 'other', 'machine_id_sha256': 'd' * 64}),
            'another instance': dict(record, instance='other'),
            'another serving record': dict(record, serving_sha256='0' * 64),
            'unknown reason': dict(record, reason='operator said so'),
            'a boot the authority does not name': dict(record, boot={'started_at': '2026-11-09T09:00:00Z', 'restart_count': 0}),
            'no change of boot': dict(record, boot=record['previous']),
            'authority outside its folder': dict(record, authority=dict(record['authority'], path=str(self.root / 'Caddyfile'))),
        }
        for name, changed in cases.items():
            with self.subTest(name):
                self.private(record_path, handoff.encoded(changed))
                with self.assertRaises(ValueError):
                    self.startup()
        self.private(record_path, handoff.encoded(record))
        self.startup()
        self.private(receipt_path, receipt + b' ')
        with self.assertRaisesRegex(ValueError, 'digest changed'):
            self.startup()
        self.private(receipt_path, receipt)
        fork = record_path.with_name('boot-%s-%s.json' % (ID, '0' * 32))
        self.private(fork, record_path.read_bytes())
        with self.assertRaisesRegex(ValueError, 'one chain'):
            self.startup()
        fork.unlink()
        self.startup()

    def test_a_record_for_another_proxy_is_ignored_and_an_unknown_file_still_refuses_the_inventory(self):
        self.private(self.root / retired.DIRECTORY / ('boot-%s-%s.json' % ('9' * 64, '0' * 32)), b'{}')
        self.assertEqual(self.startup(), Path(self.serving['caddyfile']))
        self.assertEqual(retired.inventory(self.root, 'site', self.run_docker), set())
        self.private(self.root / retired.DIRECTORY / 'boot-unknown.json', b'{}')
        with self.assertRaisesRegex(ValueError, 'unknown entry'):
            retired.inventory(self.root, 'site', self.run_docker)

    def test_restart_evidence_says_explained_only_when_the_times_fit(self):
        boot = {'started_at': '2026-11-09T05:00:10.123456789Z', 'restart_count': 0}
        evidence = serving_boot.restart_evidence(boot, now=0)
        self.assertEqual(evidence['observed_utc'], '1970-01-01T00:00:00+00:00')
        self.assertIn(evidence['explained_by'], (None, 'host boot', 'Docker daemon start'))
        if evidence['docker_daemon_started_utc'] is None:
            self.assertIsNone(evidence['explained_by'])


if __name__ == '__main__':
    unittest.main()
