"""Synthetic proxy-only recovery; no live Docker, app, or database."""
import copy
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[2] / 'scripts'
sys.path.insert(0, str(SCRIPTS / 'hosted-deploy'))
sys.path.insert(0, str(SCRIPTS))
import caddy_recover_action
import test_hosted_caddy_recovery_preflight as fixtures


class RecoverActionTests(unittest.TestCase):
    def setUp(self):
        self.fx = fixtures.RecoveryPreflightTests('test_exact_previous_bundle_and_proxy_are_bound')
        self.fx.setUp()
        self.addCleanup(self.fx.doCleanups)
        self.current = self.fx.current
        self.current['State'] = {'Running': True}
        self.new_id = 'e' * 64
        self.recovered = None
        self.calls = []
        self.fail_start = False
        self.start_error = None
        self.stop_error = None

    def run_docker(self, argv, timeout, limit):
        self.calls.append(argv)
        if argv[1:2] == ['ps'] and '--filter' in argv:
            if self.recovered and self.recovered['Name'] == '/site-caddy':
                return (self.new_id + '\n').encode()
            if self.current['Name'] == '/site-caddy':
                return (self.fx.current_id + '\n').encode()
            return b''
        if argv[1:3] == ['container', 'inspect'] and argv[3] == self.fx.current_id:
            return json.dumps([self.current]).encode()
        if argv[1:3] == ['container', 'inspect'] and argv[3] == self.new_id:
            return json.dumps([self.recovered]).encode()
        if argv[1:2] == ['stop'] and self.fx.current_id in argv:
            self.current['State']['Running'] = False
            if self.stop_error:
                raise self.stop_error
            return b'stopped\n'
        if argv[1:2] == ['stop'] and self.new_id in argv:
            self.recovered['State']['Running'] = False
            return b'stopped\n'
        if argv[1:2] == ['rename']:
            self.current['Name'] = '/' + argv[-1]
            return b''
        if argv[1:2] == ['rm'] and self.new_id in argv:
            evidence = list((self.fx.root / '.caddy-transactions').glob('candidate-*.json'))
            self.assertEqual(len(evidence), 1)
            self.assertEqual(json.loads(evidence[0].read_bytes())['candidate_id'], self.new_id)
            self.assertEqual(evidence[0].stat().st_mode & 0o777, 0o600)
            self.recovered = None
            return b'removed\n'
        if argv[1:2] == ['create'] and argv[argv.index('--name') + 1] == 'site-caddy':
            token = next(item.split('=', 1)[1] for item in argv if item.startswith('org.dollhousemcp.proxy-recovery-token='))
            self.recovered = copy.deepcopy(self.fx.fx.fake.proxy)
            self.recovered['Id'] = self.new_id
            self.recovered['State'] = {'Running': False}
            self.recovered['Config']['Labels']['org.dollhousemcp.proxy-recovery-token'] = token
            self.recovered['Mounts'][0]['Source'] = str(self.fx.receipt / 'Caddyfile')
            return (self.new_id + '\n').encode()
        if argv[1:2] == ['start'] and self.new_id in argv:
            if self.start_error:
                self.recovered['State']['Running'] = True
                raise self.start_error
            if self.fail_start:
                raise ValueError('fixture start failure')
            self.recovered['State']['Running'] = True
            return (self.new_id + '\n').encode()
        if argv[1:2] == ['start'] and self.fx.current_id in argv:
            self.current['State']['Running'] = True
            return (self.fx.current_id + '\n').encode()
        return self.fx.run_docker(argv, timeout, limit)

    def recover(self):
        return caddy_recover_action.recover_locked(self.fx.root, 'site', self.fx.previous,
                                                   self.fx.reference, self.run_docker, self.fx.qualify)

    def test_proxy_only_restores_old_contract_and_preserves_replacement(self):
        with patch.dict('os.environ', {'DOCKER_HOST': ''}):
            result = self.recover()
        self.assertEqual(result['restored_id'], self.new_id)
        self.assertEqual(result['preserved_replacement_id'], self.fx.current_id)
        self.assertFalse(self.current['State']['Running'])
        self.assertTrue(self.recovered['State']['Running'])
        evidence = list((self.fx.root / '.caddy-transactions').glob('success-*.json'))
        self.assertEqual(len(evidence), 1)
        record = json.loads(evidence[0].read_bytes())
        self.assertEqual(record['preserved_replacement_id'], self.fx.current_id)
        self.assertEqual(record['restored_id'], self.new_id)
        self.assertEqual(evidence[0].stat().st_mode & 0o777, 0o600)
        self.assertTrue((self.fx.previous / 'app').is_file())
        self.assertFalse(any('postgres' in item or 'dollhousemcp-migrate' in item for call in self.calls for item in call))

    def test_recovery_replaces_volatile_container_alias(self):
        old = self.fx.fx.fake.proxy
        old['NetworkSettings']['Networks']['site_default']['Aliases'].append(old['Id'][:12])
        receipt_path = self.fx.receipt / 'receipt.json'
        record = json.loads(receipt_path.read_bytes())
        record['profile']['aliases'].append(old['Id'][:12])
        receipt_path.write_text(json.dumps(record))
        def run(argv, timeout, limit):
            result = self.run_docker(argv, timeout, limit)
            if argv[1:2] == ['create'] and self.recovered:
                aliases = self.recovered['NetworkSettings']['Networks']['site_default']['Aliases']
                aliases.remove(old['Id'][:12])
                aliases.append(self.new_id[:12])
            return result
        with patch.dict('os.environ', {'DOCKER_HOST': ''}):
            result = caddy_recover_action.recover_locked(self.fx.root, 'site', self.fx.previous,
                                                         self.fx.reference, run, self.fx.qualify)
        self.assertEqual(result['restored_id'], self.new_id)
        create = next(call for call in self.calls if call[1:2] == ['create'] and 'site-caddy' in call)
        self.assertNotIn(old['Id'][:12], create)

    def test_bad_receipt_refuses_before_mutation(self):
        (self.fx.previous / 'app').write_text('changed')
        with self.assertRaises(ValueError):
            self.recover()
        self.assertEqual(self.calls, [])
        self.assertTrue(self.current['State']['Running'])

    def test_start_failure_does_not_invoke_app_or_database_rollback(self):
        self.fail_start = True
        with patch.dict('os.environ', {'DOCKER_HOST': ''}), self.assertRaises(ValueError):
            self.recover()
        self.assertFalse(any('postgres' in item or 'dollhousemcp-migrate' in item for call in self.calls for item in call))
        self.assertTrue(self.current['State']['Running'])

    def test_lost_start_ack_stops_only_owned_recovery(self):
        self.start_error = TimeoutError('start acknowledgement lost')
        with patch.dict('os.environ', {'DOCKER_HOST': ''}), self.assertRaises(TimeoutError) as caught:
            self.recover()
        self.assertIs(caught.exception, self.start_error)
        self.assertIn(['docker', 'stop', '--time', '5', self.new_id], self.calls)
        self.assertIsNone(self.recovered)
        self.assertTrue(self.current['State']['Running'])

    def test_lost_stop_ack_restores_original_proxy_without_source_mutation(self):
        self.stop_error = TimeoutError('stop acknowledgement lost')
        with patch.dict('os.environ', {'DOCKER_HOST': ''}), self.assertRaises(TimeoutError) as caught:
            self.recover()
        self.assertIs(caught.exception, self.stop_error)
        self.assertEqual(self.current['Name'], '/site-caddy')
        self.assertTrue(self.current['State']['Running'])
        self.assertTrue((self.fx.previous / 'app').is_file())

    def test_failed_cleanup_evidence_never_removes_candidate(self):
        self.fail_start = True
        with patch.dict('os.environ', {'DOCKER_HOST': ''}), \
                patch.object(caddy_recover_action, 'retain_candidate_evidence', side_effect=OSError('fixture')), \
                self.assertRaises(ValueError) as caught:
            self.recover()
        self.assertTrue(any('UNKNOWN' in note for note in caught.exception.__notes__))
        self.assertFalse(any(call[1] == 'rm' and self.new_id in call for call in self.calls))

    def test_success_evidence_failure_restores_replacement(self):
        with patch.dict('os.environ', {'DOCKER_HOST': ''}), \
                patch.object(caddy_recover_action, 'retain_success_evidence', side_effect=OSError('fixture')), \
                self.assertRaises(OSError):
            self.recover()
        self.assertTrue(self.current['State']['Running'])
        self.assertIsNone(self.recovered)

    def test_wrong_owned_candidate_label_is_never_removed(self):
        self.fail_start = True
        original = self.run_docker

        def altered(argv, timeout, limit):
            if argv[1:3] == ['container', 'inspect'] and argv[3] == self.new_id:
                self.recovered['Config']['Labels']['org.dollhousemcp.proxy-recovery-token'] = 'wrong'
            return original(argv, timeout, limit)

        with patch.dict('os.environ', {'DOCKER_HOST': ''}), self.assertRaises(ValueError):
            caddy_recover_action.recover_locked(self.fx.root, 'site', self.fx.previous,
                                                self.fx.reference, altered, self.fx.qualify)
        self.assertFalse(any(call[1] == 'rm' and self.new_id in call for call in self.calls))


if __name__ == '__main__':
    unittest.main()
