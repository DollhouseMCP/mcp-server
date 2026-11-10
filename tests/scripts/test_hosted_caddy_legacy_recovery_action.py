"""Forced recovery in private files/inert Docker; never hosted qualification."""
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[2] / 'scripts'
sys.path.insert(0, str(SCRIPTS / 'hosted-deploy'))
sys.path.insert(0, str(SCRIPTS))
import legacy_recovery_action as recovery
import legacy_recovery_boundary as boundary
import legacy_handoff as handoff
from caddy_control_failure import ControlFailure
from hosted_legacy_recovery_fixture import Fixture
from test_hosted_caddy_legacy_recovery_guards import container


class LegacyRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.fx = Fixture(self)
        self.addCleanup(patch.stopall)
        self.environment = patch.dict('os.environ', {'DOCKER_HOST': ''})
        self.environment.start()
        self.addCleanup(self.environment.stop)

    def recover(self, exposure_only=False):
        return recovery.recover(self.fx.root, self.fx.value, self.fx.run, self.fx.p.fx.qualify,
                                exposure_only=exposure_only, public=lambda _: [{'status': n} for n in (200, 200, 401)])

    def journal_path(self):
        window = boundary.window_path(self.fx.root, self.fx.value['token'])
        issued = json.loads((window / 'recovery-issued.json').read_bytes())
        return window / ('recover-' + issued['operation'])

    def test_forced_pre_migration_recovery_retains_forward_state_and_originals(self):
        self.fx.complete_handoff()
        before = json.dumps(self.fx.state, sort_keys=True)
        result = self.recover()
        self.assertEqual(result['outcome'], 'RECOVERED')
        self.assertEqual(json.dumps(self.fx.state, sort_keys=True), before)
        self.assertFalse(self.fx.current['State']['Running'])
        self.assertTrue(self.fx.app['State']['Running'])
        self.assertTrue(self.fx.p.recovered['State']['Running'])
        starts = [argv for argv in self.fx.calls if argv[1:2] == ['start'] and self.fx.app['Id'] in argv]
        self.assertEqual(len(starts), 1)
        self.assertTrue((self.fx.root / '.legacy-handoff' / 'receipt.json').exists())
        self.assertTrue((self.fx.previous / 'app').exists())
        self.assertFalse(any(argv[1] == 'compose' or argv[1:3] in (['volume', 'rm'], ['volume', 'create'])
                             or (argv[1] == 'rm' and any(identifier in argv for identifier in
                                 (self.fx.app['Id'], self.fx.pg['Id'], self.fx.current['Id'], self.fx.p.new_id)))
                             for argv in self.fx.calls))
        self.assertTrue((self.journal_path() / 'RECOVERED.json').exists())

    def test_failed_private_probe_remains_failed_while_separate_recovery_succeeds(self):
        self.fx.complete_handoff()
        problem = ControlFailure(exit_code=28, stderr=b'fixture curl timeout', elapsed=1,
                                 timeout=10, reason='fixture timeout', context={'method': 'GET', 'path': '/config/'})
        before = json.dumps(self.fx.state, sort_keys=True)
        with patch.object(handoff, 'verified_session', side_effect=problem):
            with self.assertRaises(ControlFailure) as caught:
                handoff.fence(self.fx.root, self.fx.value)
        self.assertIs(caught.exception, problem)
        self.recover()
        self.assertEqual(json.dumps(self.fx.state, sort_keys=True), before)
        self.assertEqual(problem.diagnostic['exit_code'], 28)

    def test_prepared_forward_control_and_never_stopped_app_need_no_app_restart(self):
        self.fx.control.update(phase='prepared', proxy=None, normal_config_sha256=None, verification_config_sha256=None)
        before = json.dumps(self.fx.state, sort_keys=True)
        self.recover()
        self.assertEqual(json.dumps(self.fx.state, sort_keys=True), before)
        self.assertFalse(any(argv[1] == 'start' and self.fx.app['Id'] in argv for argv in self.fx.calls))
        self.assertFalse((self.fx.root / '.legacy-handoff').exists())

    def test_exposure_only_continuation_never_restarts_the_original_app(self):
        self.fx.complete_handoff()
        real_expose = recovery.expose
        with patch.object(recovery, 'expose', side_effect=ValueError('fixture stop before exposure')):
            with self.assertRaisesRegex(ValueError, 'stop before exposure'):
                self.recover()
        self.assertTrue((self.journal_path() / 'app-ready.json').exists())
        self.assertFalse(self.fx.current['State']['Running'])
        with patch.object(recovery, 'expose', real_expose):
            self.recover(exposure_only=True)
        starts = [argv for argv in self.fx.calls if argv[1] == 'start' and self.fx.app['Id'] in argv]
        self.assertEqual(len(starts), 1)
        with self.assertRaisesRegex(ValueError, 'already issued'):
            self.recover(exposure_only=True)

    def test_lost_app_start_acknowledgement_never_becomes_success_from_later_health(self):
        self.fx.complete_handoff()
        self.fx.fail_operation = 'app-start'
        with self.assertRaises(TimeoutError):
            self.recover()
        self.assertTrue(self.fx.app['State']['Running'])
        self.assertFalse((self.journal_path() / 'app-started.json').exists())
        with self.assertRaises(FileNotFoundError):
            self.recover(exposure_only=True)
        self.assertEqual(sum(argv[1] == 'start' and self.fx.app['Id'] in argv for argv in self.fx.calls), 1)
        self.assertIsNone(self.fx.p.recovered)

    def test_lost_proxy_stop_acknowledgement_keeps_app_stopped_and_never_retries(self):
        self.fx.complete_handoff()
        self.fx.fail_operation = 'proxy-stop'
        with self.assertRaises(TimeoutError):
            self.recover()
        with self.assertRaises(FileNotFoundError):
            self.recover(exposure_only=True)
        self.assertFalse(self.fx.app['State']['Running'])
        self.assertEqual(sum(argv[1] == 'stop' and self.fx.current['Id'] in argv for argv in self.fx.calls), 1)

    def test_missing_handoff_ack_or_forward_write_intent_refuses_before_recovery_stop(self):
        self.fx.complete_handoff()
        receipt = self.fx.root / '.legacy-handoff' / 'receipt.json'
        raw = receipt.read_bytes()
        receipt.unlink()
        with self.assertRaises(FileNotFoundError):
            self.recover()
        receipt.write_bytes(raw)
        receipt.chmod(0o600)
        window = boundary.window_path(self.fx.root, self.fx.value['token'])
        (window / 'forward-write-issued.json').write_text('even malformed intent is an absolute refusal')
        with self.assertRaisesRegex(ValueError, 'restoration is required'):
            self.recover()
        self.assertFalse(any(argv[1] == 'stop' and self.fx.current['Id'] in argv for argv in self.fx.calls))

    def test_database_change_refuses_before_proxy_stop(self):
        self.fx.complete_handoff()
        self.fx.b.schema = b'changed database schema'
        with self.assertRaisesRegex(ValueError, 'qualified checkpoint restoration'):
            self.recover()
        self.assertFalse(any(argv[1] == 'stop' and self.fx.current['Id'] in argv for argv in self.fx.calls))

    def test_public_acceptance_failure_stops_only_owned_recovery_proxy_once(self):
        self.fx.complete_handoff()
        with self.assertRaisesRegex(ValueError, 'fixture public refusal'):
            recovery.recover(self.fx.root, self.fx.value, self.fx.run, self.fx.p.fx.qualify,
                             public=lambda _: (_ for _ in ()).throw(ValueError('fixture public refusal')))
        self.assertFalse(self.fx.p.recovered['State']['Running'])
        self.assertTrue(self.fx.app['State']['Running'])
        self.assertFalse((self.journal_path() / 'RECOVERED.json').exists())
        self.assertEqual(sum(argv[1] == 'stop' and self.fx.p.new_id in argv for argv in self.fx.calls), 1)

    def test_lost_proxy_start_ack_is_fenced_without_retry_or_later_get_promotion(self):
        self.fx.complete_handoff()
        self.fx.p.start_error = TimeoutError('fixture proxy start acknowledgement lost')
        with self.assertRaises(TimeoutError):
            self.recover()
        self.assertFalse(self.fx.p.recovered['State']['Running'])
        self.assertEqual(sum(argv[1] == 'start' and self.fx.p.new_id in argv for argv in self.fx.calls), 1)
        self.assertTrue((self.journal_path() / 'exposure-refused.json').exists())
        with self.assertRaisesRegex(ValueError, 'already issued'):
            self.recover(exposure_only=True)

    def test_isolated_canary_and_reordered_unchanged_proxy_mounts_survive_exposure_continuation(self):
        self.fx.complete_handoff()
        self.fx.other.append(container('8' * 64, 'site-canary', 'site-canary_default', ['dollhousemcp'],
                                       {'3000/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '3100'}]}))
        with patch.object(recovery, 'expose', side_effect=ValueError('fixture pause before exposure')):
            with self.assertRaises(ValueError):
                self.recover()
        self.fx.current['Mounts'].reverse()
        self.recover(exposure_only=True)
        self.assertTrue(self.fx.other[0]['State']['Running'])
        self.assertEqual(sum(argv[1] == 'start' and self.fx.app['Id'] in argv for argv in self.fx.calls), 1)

    def test_changed_or_duplicate_proxy_mount_refuses_exposure_without_app_restart(self):
        self.fx.complete_handoff()
        with patch.object(recovery, 'expose', side_effect=ValueError('fixture pause before exposure')):
            with self.assertRaises(ValueError):
                self.recover()
        self.fx.current['Mounts'].append(self.fx.current['Mounts'][0])
        with self.assertRaisesRegex(ValueError, 'duplicate'):
            self.recover(exposure_only=True)
        self.assertIsNone(self.fx.p.recovered)
        self.assertEqual(sum(argv[1] == 'start' and self.fx.app['Id'] in argv for argv in self.fx.calls), 1)

    def test_duplicate_serving_dns_refuses_before_recovery_stop_or_restart(self):
        self.fx.complete_handoff()
        self.fx.other.append(container('8' * 64, 'site-imposter', 'site_default', ['dollhousemcp']))
        with self.assertRaisesRegex(ValueError, 'DNS is missing or ambiguous'):
            self.recover()
        self.assertTrue(self.fx.current['State']['Running'])
        self.assertFalse(self.fx.app['State']['Running'])
        self.assertIsNone(self.fx.p.recovered)

    def test_active_config_failure_refences_recovered_proxy_and_never_updates_forward_control(self):
        self.fx.complete_handoff()
        before = json.dumps(self.fx.state, sort_keys=True)
        self.fx.serving_config.side_effect = ValueError('fixture active configuration mismatch')
        with self.assertRaisesRegex(ValueError, 'active configuration mismatch'):
            self.recover()
        self.assertFalse(self.fx.p.recovered['State']['Running'])
        self.assertEqual(json.dumps(self.fx.state, sort_keys=True), before)


if __name__ == '__main__':
    unittest.main()
