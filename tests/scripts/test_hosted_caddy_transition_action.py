"""Transition selection and fresh retry controls without Docker."""
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[2] / 'scripts'
sys.path.insert(0, str(SCRIPTS / 'hosted-deploy'))
sys.path.insert(0, str(SCRIPTS))
import caddy_bundle_identity
import caddy_transition_action as action
import caddy_transition_state as state
import caddy_unchanged_action
import caddy_pending_proxy_action
import test_hosted_caddy_unchanged_action as fixtures


class TransitionActionTests(unittest.TestCase):
    def setUp(self):
        self.fx = fixtures.UnchangedActionTests('test_unchanged_proxy_kept_and_receipt_binds_rollback')
        self.fx.setUp()
        self.addCleanup(self.fx.doCleanups)
        self.root = self.fx.root
        self.value = {'deploy_dir': str(self.root), 'instance': 'site', 'data_volume': 'site_data',
                      'config_volume': 'site_config', 'image': self.fx.admission['reference'],
                      'previous': '', 'token': '', 'admission': None}

    def test_completed_pointer_binds_exact_source_and_pending_refuses_rollback(self):
        with patch.dict('os.environ', {'DOCKER_HOST': ''}):
            previous = caddy_unchanged_action.prepare(self.fx.request, self.fx.run_docker, self.fx.qualify)
        self.value['previous'] = str(previous)
        token = action.begin_update(self.value, self.root)
        (self.root / 'server').rename(previous)
        (self.root / 'server').mkdir()
        (self.root / 'server' / 'app').write_text('next')
        state.mark_staged(self.root, token, caddy_bundle_identity.bundle_identity(self.root / 'server'))
        with self.assertRaises(ValueError):
            action.selected(self.root)
        self.assertEqual(action.selected(self.root, allow_pending=True), previous)
        action.complete(self.root, token)
        self.assertEqual(action.selected(self.root), previous)
        pending = action.pending_base(self.value, 'update')
        selected_state = state.read_state(self.root)['completed']
        pending.update(selected_state)
        pending['token'] = 'a' * 32
        state.begin(self.root, pending)
        with self.assertRaises(ValueError):
            action.selected(self.root)
        self.assertEqual(state.read_state(self.root)['completed'], selected_state)

    def test_pending_before_source_move_allows_verified_noop_proxy(self):
        with patch.dict('os.environ', {'DOCKER_HOST': ''}):
            previous = caddy_unchanged_action.prepare(self.fx.request, self.fx.run_docker, self.fx.qualify)
            self.value['previous'] = str(previous)
            action.begin_update(self.value, self.root)
            self.assertEqual(action.selected_proxy(self.root), '@current')
            result = caddy_pending_proxy_action.restore_current(self.root, 'site', self.fx.run_docker, self.fx.qualify)
        self.assertEqual(result['outcome'], 'unchanged')
        self.assertFalse(any(call[1] in ('stop', 'start', 'rename') for call in self.fx.calls))

    def test_completed_pointer_does_not_sort_random_bundle_names(self):
        selected = []
        with patch.dict('os.environ', {'DOCKER_HOST': ''}):
            for token_text in ('f' * 32, '0' * 32):
                with patch.object(caddy_unchanged_action.secrets, 'token_hex', return_value=token_text):
                    previous = caddy_unchanged_action.prepare(self.fx.request, self.fx.run_docker, self.fx.qualify)
                self.value['previous'] = str(previous)
                token = action.begin_update(self.value, self.root)
                (self.root / 'server').rename(previous)
                (self.root / 'server').mkdir()
                (self.root / 'server' / 'app').write_text(token_text)
                state.mark_staged(self.root, token, caddy_bundle_identity.bundle_identity(self.root / 'server'))
                action.complete(self.root, token)
                selected.append(previous)
        self.assertLess(str(selected[1]), str(selected[0]))
        self.assertEqual(action.selected(self.root), selected[1])

    def test_fresh_retry_refuses_running_app_and_preserves_unstarted_source(self):
        fresh = action.pending_base(self.value, 'fresh')
        state.begin(self.root, fresh)
        state.bind_admission(self.root, fresh['token'], self.fx.admission)
        staged = caddy_bundle_identity.bundle_identity(self.root / 'server')
        state.mark_staged(self.root, fresh['token'], staged)
        def running(argv, timeout, limit):
            if argv[1:3] == ['context', 'inspect']:
                return b'[{"Endpoints":{"docker":{"Host":"unix:///var/run/docker.sock"}}}]'
            return b'c' * 64 + b'\n'
        with patch.dict('os.environ', {'DOCKER_HOST': ''}), self.assertRaises(ValueError):
            action.retry_fresh(self.value, self.root, running)
        def no_writers(argv, timeout, limit):
            if argv[1:3] == ['context', 'inspect']:
                return b'[{"Endpoints":{"docker":{"Host":"unix:///var/run/docker.sock"}}}]'
            return b''
        with patch.dict('os.environ', {'DOCKER_HOST': ''}), patch.object(action, 'verify_fresh') as verify:
            self.assertEqual(action.retry_fresh(self.value, self.root, no_writers), fresh['token'])
        verify.assert_called_once()
        retained = action.retain_unstarted(self.root, fresh['token'])
        self.assertEqual((retained / 'app').read_text(), 'fixture')
        self.assertFalse((self.root / 'server').exists())
        self.assertIsNone(state.read_state(self.root)['pending']['staged_source'])

    def test_fresh_begin_refuses_running_app_before_state_creation(self):
        def running(argv, timeout, limit):
            if argv[1:3] == ['context', 'inspect']:
                return b'[{"Endpoints":{"docker":{"Host":"unix:///var/run/docker.sock"}}}]'
            return b'c' * 64 + b'\n'
        with patch.dict('os.environ', {'DOCKER_HOST': ''}), self.assertRaises(ValueError):
            action.dispatch('begin-fresh', self.value, running)
        self.assertFalse((self.root / '.caddy-state').exists())


if __name__ == '__main__':
    unittest.main()
