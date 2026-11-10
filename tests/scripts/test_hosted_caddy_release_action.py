"""Inert release-order and failure controls; no network or Docker."""
from pathlib import Path
import sys
import unittest
from unittest.mock import Mock, patch

SCRIPTS = Path(__file__).resolve().parents[2] / 'scripts'
sys.path.insert(0, str(SCRIPTS / 'hosted-deploy'))
sys.path.insert(0, str(SCRIPTS))
import caddy_release_action as release


class ReleaseActionTests(unittest.TestCase):
    def setUp(self):
        self.value = {'token': 'a' * 32, 'instance': 'site'}
        self.control = {'phase': 'accepted'}
        self.state = {'pending': {'control': self.control}}
        self.pending = self.state['pending']
        self.session = Mock()
        self.session.identity = {'pid': 123}

    def failed_release(self, stop_error=None):
        if stop_error:
            self.session.stop_after_release_failure.side_effect = stop_error
        with patch.object(release, 'pending_control', return_value=(self.state, self.pending, self.control)), \
                patch.object(release, 'verified_session', return_value=(self.session, b'normal', b'fenced', b'{}')), \
                patch.object(release, 'write_state') as save, \
                patch.object(release, 'write_startup_file', side_effect=ValueError('fixture write failed')):
            with self.assertRaisesRegex(ValueError, 'fixture write failed') as caught:
                release.release(self.value, Path('/fixture'))
        self.assertEqual(self.control['phase'], 'releasing')
        self.assertEqual(save.call_count, 1)
        self.session.stop_after_release_failure.assert_called_once()
        self.session.close.assert_called_once()
        return caught.exception

    def test_release_failure_stops_exact_proxy_and_retains_pending(self):
        error = self.failed_release()
        self.assertTrue(any('stopped cleanly' in note for note in error.__notes__))

    def test_failed_release_stop_reports_possible_ingress(self):
        error = self.failed_release(ValueError('fixture stop unavailable'))
        self.assertTrue(any('UNKNOWN' in note and 'ingress may be active' in note for note in error.__notes__))

    def test_fixed_renderer_derives_fence_from_selected_inputs(self):
        renderer = {'PROXY_MODE': 'caddy-tls', 'HOSTNAME': 'fixture.example', 'HTTP_BIND_PORT': '80',
                    'MCP_PORT': '8081', 'CADDY_TRUSTED_PROXIES': '', 'CADDY_ACCESS_LOG': 'false'}
        normal, verification = release.render_profiles(renderer, 'a' * 32)
        self.assertNotIn(b'protocols h1', normal)
        self.assertIn(b'protocols h1', verification)
        self.assertIn(b'header Content-Length 0', verification)
        self.assertIn(b'{http.request.orig_uri}', verification)
        self.assertIn(b'>X-Dollhouse-Verification ' + b'a' * 32, verification)
        with self.assertRaises(ValueError):
            release.render_profiles(dict(renderer, HOSTNAME='fixture.example\nrespond 200'), 'a' * 32)

    def test_probe_deadline_does_not_multiply_by_retries(self):
        with patch.object(release.time, 'monotonic', side_effect=[0, 1, 11]), \
                patch.object(release, 'bounded_input', return_value=b'error\n503') as call:
            with self.assertRaisesRegex(ValueError, 'required status'):
                release.public_probe('https://fixture.example', '/healthz', b'200', False, 10, 'a' * 32)
        self.assertLessEqual(call.call_args.kwargs['timeout'], 12)
        self.assertIn('--http1.1', call.call_args.args[0])
        self.assertIn('Content-Length: 0', call.call_args.args[0])

    def test_zero_retry_window_attempts_once_and_requires_current_marker(self):
        response = b'HTTP/1.1 200 OK\r\nX-Dollhouse-Verification: ' + b'a' * 32 + b'\r\n\r\nok\n200'
        with patch.object(release, 'bounded_input', return_value=response) as call:
            release.public_probe('https://fixture.example', '/healthz', b'200', False, 0, 'a' * 32)
        self.assertEqual(call.call_count, 1)
        for invalid in (response.replace(b'a' * 32, b'b' * 32),
                        response.replace(b'X-Dollhouse-Verification:', b'X-Unrelated:')):
            with self.subTest(invalid=invalid), patch.object(release, 'bounded_input', return_value=invalid) as call:
                with self.assertRaisesRegex(ValueError, 'required status'):
                    release.public_probe('https://fixture.example', '/healthz', b'200', False, 0, 'a' * 32)
                self.assertEqual(call.call_count, 1)

    def test_denials_require_current_marker_before_drain(self):
        valid = b'HTTP/1.1 503 Service Unavailable\r\nX-Dollhouse-Verification: ' + b'a' * 32 + b'\r\n\r\nno\n503'
        with patch.object(release, 'bounded_input', return_value=valid) as call:
            release.confirm_denials('https://fixture.example', 'a' * 32)
        self.assertEqual(call.call_count, 2)
        for response in (valid.replace(b'a' * 32, b'b' * 32), valid.replace(b'X-Dollhouse-Verification:', b'X-Unrelated:')):
            with self.subTest(response=response), patch.object(release, 'bounded_input', return_value=response):
                with self.assertRaisesRegex(ValueError, 'unsafe probe'):
                    release.confirm_denials('https://fixture.example', 'a' * 32)

    def test_public_origin_hostname_is_bound_but_edge_tls_may_front_http(self):
        renderer = {'PROXY_MODE': 'caddy-http', 'HOSTNAME': 'fixture.example', 'HTTP_BIND_PORT': '80',
                    'MCP_PORT': '8081', 'CADDY_TRUSTED_PROXIES': '', 'CADDY_ACCESS_LOG': 'false'}
        value = {'token': 'a' * 32, 'renderer': renderer, 'public_base_url': 'https://fixture.example'}
        state, pending = {}, {}
        with patch.object(release, 'pending_control', return_value=(state, pending, None)), \
                patch.object(release, 'validate_system'), \
                patch.object(release, 'render_profiles', return_value=(b'normal', b'fenced')), \
                patch.object(release, 'read_current_caddyfile', return_value=b'normal'), \
                patch.object(release, 'snapshot_files', side_effect=RuntimeError('snapshot reached')):
            with self.assertRaisesRegex(RuntimeError, 'snapshot reached'):
                release.prepare(value, Path('/fixture'))
            with self.assertRaisesRegex(ValueError, 'differs from the selected'):
                release.prepare(dict(value, public_base_url='https://other.example'), Path('/fixture'))


if __name__ == '__main__':
    unittest.main()
