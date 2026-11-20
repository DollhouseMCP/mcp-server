"""Control failures retain evidence and never turn a later read into success."""
import json
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
import sys
import threading
import unittest
from unittest.mock import Mock, patch

SCRIPTS = Path(__file__).resolve().parents[2] / 'scripts'
sys.path.insert(0, str(SCRIPTS / 'hosted-deploy'))
sys.path.insert(0, str(SCRIPTS))
import caddy_active_config as control


class ControlOutcomesTests(unittest.TestCase):
    def test_spawn_failure_preserves_errno_and_identity_without_command(self):
        with patch.object(control.subprocess, 'Popen', side_effect=FileNotFoundError(2, 'secret-command')), \
                self.assertRaises(control.ControlFailure) as caught:
            control.bounded_input(['/secret-command'], context={'operation': 'GET /config/'})
        self.assertIsNone(caught.exception.diagnostic['exit_code'])
        self.assertEqual(caught.exception.diagnostic['spawn_errno'], 2)
        self.assertEqual(caught.exception.diagnostic['outcome'], 'UNKNOWN')
        self.assertNotIn('secret-command', str(caught.exception))

    def test_actual_child_exit_and_stderr_are_preserved(self):
        with self.assertRaises(control.ControlFailure) as caught:
            control.bounded_input([sys.executable, '-c',
                                   'import sys; sys.stderr.write("fixture refusal\\n"); sys.exit(42)'])
        self.assertEqual(caught.exception.diagnostic['exit_code'], 42)
        self.assertEqual(caught.exception.diagnostic['stderr'], 'fixture refusal\n')
        self.assertEqual(caught.exception.diagnostic['outcome'], 'REFUSED')
        self.assertTrue(caught.exception.diagnostic['cleanup_confirmed'])

    def test_actual_loopback_http_refusal_keeps_curl_exit_and_stderr(self):
        class Refuse(BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(503)
                self.end_headers()

            def log_message(self, *_args):
                pass

        with HTTPServer(('127.0.0.1', 0), Refuse) as server:
            thread = threading.Thread(target=server.serve_forever)
            thread.start()
            try:
                with self.assertRaises(control.ControlFailure) as caught:
                    control.bounded_input([control.CURL, '--disable', '--noproxy', '*',
                                           '--silent', '--show-error', '--fail', '--max-time', '2',
                                           'http://127.0.0.1:' + str(server.server_port) + '/config/'],
                                          context={'operation': 'GET /config/'})
            finally:
                server.shutdown()
                thread.join(timeout=2)
        self.assertFalse(thread.is_alive())
        self.assertEqual(caught.exception.diagnostic['exit_code'], 22)
        self.assertIn('503', caught.exception.diagnostic['stderr'])
        self.assertEqual(caught.exception.diagnostic['outcome'], 'REFUSED')

    def test_actual_curl_native_timeout_is_unknown_before_capture_deadline(self):
        release = threading.Event()

        class WithholdResponse(BaseHTTPRequestHandler):
            def do_GET(self):
                release.wait(timeout=2)

            def log_message(self, *_args):
                pass

        with HTTPServer(('127.0.0.1', 0), WithholdResponse) as server:
            thread = threading.Thread(target=server.serve_forever)
            thread.start()
            try:
                with self.assertRaises(control.ControlFailure) as caught:
                    control.bounded_input([control.CURL, '--disable', '--noproxy', '*',
                                           '--silent', '--show-error', '--fail', '--max-time', '0.1',
                                           'http://127.0.0.1:' + str(server.server_port) + '/config/'],
                                          context={'operation': 'GET /config/'})
            finally:
                release.set()
                server.shutdown()
                thread.join(timeout=2)
        self.assertFalse(thread.is_alive())
        self.assertEqual(caught.exception.diagnostic['exit_code'], 28)
        self.assertTrue(caught.exception.diagnostic['stderr'])
        self.assertEqual(caught.exception.diagnostic['outcome'], 'UNKNOWN')

    def test_other_curl_transfer_failures_are_also_unknown(self):
        for status in (5, 6, 7, 28, 52, 56):
            with self.subTest(status=status):
                failure = self.fail_child(status=status, context={'operation': 'GET /config/'})
                self.assertEqual(failure.diagnostic['exit_code'], status)
                self.assertEqual(failure.diagnostic['outcome'], 'UNKNOWN')

    def fail_child(self, *, status=22, error=None, cleaned=True, context=None, settled=True):
        child = Mock(returncode=status)
        child.poll.return_value = status if settled else None

        def capture(_child, _deadline, _maximum, _stderr_maximum, _sink, buffers):
            buffers[1].extend(b'curl: confirmed HTTP refusal\n')
            return error

        with patch.object(control.subprocess, 'Popen', return_value=child), \
                patch.object(control.scanner, 'capture_process', side_effect=capture), \
                patch.object(control.scanner, 'terminate_process', return_value=cleaned), \
                patch.object(control.scanner, 'close_child_pipes'), \
                patch.object(control.time, 'monotonic', side_effect=[100, 100.25, 100.5]):
            with self.assertRaises(control.ControlFailure) as caught:
                control.bounded_input(['/fixed/tool', 'secret-argv'], b'secret-input',
                                      context=context)
        return caught.exception

    def test_settled_read_refusal_preserves_exit_stderr_timing_and_no_argv(self):
        failure = self.fail_child(context={'operation': 'GET /config/', 'identity': {'id': 'a' * 64}})
        report = failure.diagnostic
        self.assertEqual(report['outcome'], 'REFUSED')
        self.assertEqual(report['exit_code'], 22)
        self.assertEqual(report['stderr'], 'curl: confirmed HTTP refusal\n')
        self.assertEqual(report['elapsed_seconds'], 0.25)
        self.assertEqual(report['total_elapsed_seconds'], 0.5)
        self.assertEqual(report['timeout_seconds'], 15)
        self.assertTrue(report['cleanup_confirmed'])
        self.assertEqual(report['context']['identity']['id'], 'a' * 64)
        self.assertNotIn('secret-argv', str(failure))
        self.assertNotIn('secret-input', str(failure))
        json.loads(str(failure).split(': ', 1)[1])

    def test_timeout_signal_unsettled_and_unknown_cleanup_never_become_refusal(self):
        for options in ({'status': None, 'error': 'process deadline exceeded'},
                        {'status': -9}, {'settled': False}, {'cleaned': False},
                        {'error': 'combined stdout/stderr exceeds bounded capture size'}):
            with self.subTest(options=options):
                failure = self.fail_child(**options)
                self.assertEqual(failure.diagnostic['outcome'], 'UNKNOWN')

    def test_post_failure_is_unknown_even_with_known_child_exit(self):
        failure = self.fail_child(context={'operation': 'POST /load'})
        self.assertEqual(failure.diagnostic['exit_code'], 22)
        self.assertEqual(failure.diagnostic['outcome'], 'UNKNOWN')

    def test_original_failure_survives_successful_identity_recheck_and_later_get(self):
        session = control.ActiveConfig.__new__(control.ActiveConfig)
        session.fd, session.namespace = 7, (10, 20)
        session.identity = {'id': 'a' * 64, 'pid': 123, 'started_at': 'boot', 'restart_count': 0}
        failure = self.fail_child(context=session.failure_context('POST /load'))
        with patch.object(session, 'recheck'), \
                patch.object(control, 'bounded_input', side_effect=[failure, b'{"later":"healthy"}']) as call:
            with self.assertRaises(control.ControlFailure) as caught:
                session.request('POST', '/load', b'{}')
            self.assertIs(caught.exception, failure)
            self.assertEqual(call.call_count, 1)  # No automatic GET or retry after failure.
            self.assertEqual(session.read(), b'{"later":"healthy"}')
        self.assertEqual(failure.diagnostic['outcome'], 'UNKNOWN')
        self.assertTrue(failure.diagnostic['identity_verified'])
        self.assertEqual(failure.diagnostic['context']['namespace'], [10, 20])

    def test_changed_identity_preserves_real_child_status_but_marks_unknown(self):
        session = control.ActiveConfig.__new__(control.ActiveConfig)
        session.fd = 7
        failure = self.fail_child()
        with patch.object(session, 'recheck', side_effect=[None, ValueError('boot changed')]), \
                patch.object(control, 'bounded_input', side_effect=failure):
            with self.assertRaises(control.ControlFailure) as caught:
                session.request('GET', '/config/')
        self.assertIs(caught.exception, failure)
        self.assertEqual(failure.diagnostic['exit_code'], 22)
        self.assertEqual(failure.diagnostic['outcome'], 'UNKNOWN')
        self.assertFalse(failure.diagnostic['identity_verified'])


if __name__ == '__main__':
    unittest.main()
