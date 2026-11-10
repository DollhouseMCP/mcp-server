"""Forced recovery + reconciliation with inert Docker and private files."""
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[2] / 'scripts'
sys.path.insert(0, str(SCRIPTS / 'hosted-deploy'))
sys.path.insert(0, str(SCRIPTS))
import caddy_transition_state as transition
import caddy_native_replacement as native
import legacy_control_resolution as resolution
import legacy_handoff as handoff
import legacy_reconcile_action as reconcile
import legacy_recovery_action as recovery
from hosted_legacy_recovery_fixture import Fixture


class ReconciliationTests(unittest.TestCase):
    def setUp(self):
        self.fx = Fixture(self, control_model=True)
        self.fx.state['schema'] = 'caddy-transition-v1'
        self.addCleanup(patch.stopall)
        environment = patch.dict('os.environ', {'DOCKER_HOST': ''})
        environment.start()
        self.addCleanup(environment.stop)
        self.state_dir = self.fx.root / '.caddy-state'
        self.state_dir.mkdir(mode=0o700)
        self.original_state = handoff.encoded(self.fx.state)
        reconcile.files.save(self.state_dir, 'state.json', self.original_state)
        self.public = lambda _: [{'status': code, 'version': '2.1.0-beta.2' if code == 200 else None}
                                 for code in (200, 200, 401)]

    def run_docker(self, argv, timeout, maximum):
        if argv[1] == 'ps' and 'label=com.docker.compose.service=caddy' in argv and self.fx.p.recovered:
            self.fx.calls.append(argv)
            return ('\n'.join([self.fx.current['Id'], self.fx.p.recovered['Id']]) + '\n').encode()
        return self.fx.run(argv, timeout, maximum)

    def known_stop_recovery(self):
        calls = 0

        def failure(*_):
            nonlocal calls
            calls += 1
            if calls > 1:
                raise ValueError('UNKNOWN private Caddy read after known stop')
            return self.fx.fence

        with self.assertRaisesRegex(ValueError, 'UNKNOWN private Caddy read'):
            handoff.handoff(self.fx.root, self.fx.value, self.run_docker, verify_fence=failure)
        return recovery.recover(self.fx.root, self.fx.value, self.run_docker, self.fx.p.fx.qualify, public=self.public)

    def verify_model(self, path, root, instance, data):
        result = json.loads(path.read_bytes())
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(result['name'], instance)
        self.assertEqual(result['services']['dollhousemcp']['image'], data['app']['Image'])
        self.assertEqual(result['services']['dollhousemcp']['environment']['FIXTURE_PRIVATE'], 'literal$$fixture')
        self.assertEqual(result['services']['caddy']['image'], data['proxy']['Image'])
        self.assertTrue(all('build' not in item for item in result['services'].values()))

    def reconcile(self):
        return reconcile.reconcile(self.fx.root, self.fx.value, None, self.run_docker, self.fx.p.fx.qualify,
                                   public=self.public, verify_compose=self.verify_model)

    def test_forced_recovery_reconciles_originals_and_allows_only_a_new_qualified_transition(self):
        self.assertEqual(self.known_stop_recovery()['outcome'], 'RECOVERED')
        root = self.fx.root
        issued = (root / '.legacy-handoff' / 'issued.json').read_bytes()
        stop_ack = (root / '.legacy-handoff' / 'stop-acknowledged.json').read_bytes()
        (root / '.env').write_bytes(b'failed-forward-env')
        (root / 'compose.yml').write_bytes(b'failed-forward-compose')
        before = len(self.fx.calls)
        result = self.reconcile()
        self.assertEqual(result['outcome'], 'RECONCILED')
        proof = Path(result['receipt']).parent
        self.assertEqual((proof / 'failed-files' / '.env').read_bytes(), b'failed-forward-env')
        self.assertEqual((proof / 'failed-files' / 'compose.yml').read_bytes(), b'failed-forward-compose')
        self.assertEqual((proof / 'failed-server' / 'version').read_text(), 'new-staged-source')
        self.assertEqual(resolution.bundle_identity(root / 'server'), resolution.bundle_identity(self.fx.previous))
        self.assertEqual((root / '.env').read_bytes(), b'original-.env')
        self.assertEqual((root / '.legacy-handoff' / 'issued.json').read_bytes(), issued)
        self.assertEqual((root / '.legacy-handoff' / 'stop-acknowledged.json').read_bytes(), stop_ack)
        self.assertFalse((root / '.legacy-handoff' / 'receipt.json').exists())
        self.assertEqual(resolution.raw_state(root), self.original_state)
        self.assertIsNone(resolution.unresolved_pending(root, self.fx.state))
        self.assertFalse(any(argv[1] in ('start', 'stop', 'rename', 'create', 'run', 'rm')
                             for argv in self.fx.calls[before:]))
        # A qualified disposition preserves the old failed byte stream. Only a
        # NEW transition can consume it; it cannot reuse the old checkpoint boot.
        with patch.object(transition, 'read_state', return_value=self.fx.state):
            handoff.require_unissued(root, {**self.fx.value, 'token': ''}, preflight=True)
        with self.assertRaisesRegex(ValueError, 'checkpoint app boot identity differs'):
            handoff.verify_inputs(self.fx.value, self.run_docker)
        pending = {**self.fx.b.pending, 'token': '3' * 32, 'control': None, 'phase': 'prepared',
                   'staged_source': None, 'admission': None, 'volumes': ['fresh-data', 'fresh-config']}
        with patch.object(transition, 'read_state', return_value={**self.fx.state}):
            transition.begin(root, pending)
        self.assertEqual(transition.read_state(root)['pending']['token'], pending['token'])
        next_value = {**self.fx.value, 'token': pending['token']}
        self.assertEqual(handoff.state_path(root, next_value), root / '.legacy-handoff' / ('window-' + pending['token']))
        self.assertEqual((root / '.legacy-handoff' / 'issued.json').read_bytes(), issued)
        self.assertEqual((proof / ('consume-' + pending['token'] + '-failed-state.json')).read_bytes(), self.original_state)

    def test_rewritten_intent_and_ack_refuse_even_with_consistent_linkage(self):
        self.known_stop_recovery()
        root = self.fx.root
        marker_dir = root / '.legacy-handoff'
        issued_path = marker_dir / 'issued.json'
        ack_path = marker_dir / 'stop-acknowledged.json'
        issued = issued_path.read_bytes() + b'\n'
        ack = json.loads(ack_path.read_bytes())
        ack['issued_sha256'] = handoff.digest(issued)
        issued_path.write_bytes(issued)
        ack_path.write_bytes(handoff.encoded(ack))
        with self.assertRaisesRegex(ValueError, 'handoff evidence changed'):
            self.reconcile()
        self.assertEqual((root / 'server' / 'version').read_text(), 'new-staged-source')
        self.assertEqual(resolution.raw_state(root), self.original_state)

    def test_unknown_extra_proxy_label_refuses_before_any_source_change(self):
        self.known_stop_recovery()
        original = self.run_docker

        def extra(argv, timeout, maximum):
            raw = original(argv, timeout, maximum)
            if argv[1] == 'ps' and 'label=com.docker.compose.service=caddy' in argv:
                return raw + b'9' * 64 + b'\n'
            return raw

        with self.assertRaisesRegex(ValueError, 'label census'):
            reconcile.reconcile(self.fx.root, self.fx.value, None, extra, self.fx.p.fx.qualify,
                                 public=self.public, verify_compose=self.verify_model)
        self.assertEqual((self.fx.root / 'server' / 'version').read_text(), 'new-staged-source')
        self.assertTrue(self.fx.p.recovered['State']['Running'])
        self.assertEqual(resolution.raw_state(self.fx.root), self.original_state)

    def test_acknowledged_native_failure_fence_allows_exposure_without_restarting_legacy(self):
        self.fx.control.update(phase='prepared', proxy=None, normal_config_sha256=None, verification_config_sha256=None)
        self.fx.current['Config']['Labels']['org.dollhousemcp.proxy-recovery-token'] = self.fx.value['token']
        original = json.loads((self.fx.p.fx.receipt / 'receipt.json').read_bytes())
        path = native.operation_directory(self.fx.root, self.fx.value['token'])
        expected = {'instance': 'site', 'token': self.fx.value['token'], 'image': self.fx.p.fx.current_image,
                    'admission': self.fx.p.fx.admission, 'startup': self.fx.root / 'Caddyfile',
                    'names': self.fx.b.pending['volumes'], 'ports': original['profile']['ports']}
        native.fence_failed_start(path, self.fx.current['Id'], expected, self.run_docker)
        result = recovery.recover(self.fx.root, self.fx.value, self.run_docker, self.fx.p.fx.qualify, public=self.public)
        self.assertEqual(result['outcome'], 'RECOVERED')
        self.assertEqual(self.fx.control['phase'], 'prepared')
        self.assertEqual(sum(argv[1] == 'stop' and self.fx.current['Id'] in argv for argv in self.fx.calls), 1)
        self.assertFalse(any(argv[1] == 'start' and self.fx.app['Id'] in argv for argv in self.fx.calls))
        self.assertFalse((path / 'started.json').exists())


if __name__ == '__main__':
    unittest.main()
