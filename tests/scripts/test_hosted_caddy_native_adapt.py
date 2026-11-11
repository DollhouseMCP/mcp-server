"""Inert checks that the native adapt witness cannot pass on the wrong evidence.

The witness itself runs against real Caddy binaries in the native CI job.
"""
import importlib.util
import io
from pathlib import Path
import unittest
import unittest.mock
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[2] / 'scripts/ci/caddy-adapt-native.py'
spec = importlib.util.spec_from_file_location('native_adapt_witness', SCRIPT)
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)

IDENTIFIER = 'a' * 64
CADDYFILE = b'fixture.local:80 {\n\treverse_proxy dollhousemcp:8081\n}\n'
ADAPTED = b'{"apps":{}}'


def refusal(stderr, exit_code=1, reason=None):
    return native.ControlFailure(exit_code=exit_code, stderr=stderr, elapsed=0.1, timeout=15, reason=reason)


class Session:
    identity = {'id': IDENTIFIER, 'pid': 1, 'started_at': 'fixture', 'restart_count': 0}

    def __init__(self, serving=ADAPTED, dependent=ValueError('adapted Caddy configuration depends on its input path')):
        self.serving, self.dependent, self.closed, self.adapted = serving, dependent, False, []

    def adapt(self, caddyfile):
        self.adapted.append(caddyfile)
        if caddyfile == native.PATH_DEPENDENT:
            if self.dependent is None:
                return ADAPTED
            raise self.dependent
        return ADAPTED

    def read(self):
        return self.serving

    def recheck(self):
        return None

    def close(self):
        self.closed = True


class NativeAdaptWitnessTests(unittest.TestCase):
    def run_witness(self, session, dash):
        with patch.object(native, 'ActiveConfig', return_value=session), \
                patch.object(native, 'bounded_input', side_effect=dash) as bounded:
            try:
                return native.witness(IDENTIFIER, CADDYFILE), bounded
            finally:
                self.assertTrue(session.closed)

    def test_legacy_binary_adapts_and_refuses_the_former_dash_form(self):
        missing = refusal(b'Error: reading input file: open -: no such file or directory\n')
        result, bounded = self.run_witness(Session(), [missing])
        self.assertEqual(result['dash_form'], 'refused')
        self.assertEqual(result['input'], '/dev/stdin')
        self.assertIs(result['serving_configuration_matches'], True)
        self.assertIs(result['path_dependent_refused'], True)
        self.assertEqual(bounded.call_args.args[0][-5:], ['adapt', '--config', '-', '--adapter', 'caddyfile'])
        self.assertEqual(bounded.call_args.args[1], CADDYFILE)

    def test_current_binary_accepts_the_dash_form(self):
        result, _ = self.run_witness(Session(), [ADAPTED])
        self.assertEqual(result['dash_form'], 'accepted')

    def test_serving_difference_fails_the_witness(self):
        session = Session(serving=b'{"apps":{"other":1}}')
        with self.assertRaisesRegex(ValueError, 'differs from the serving configuration'):
            self.run_witness(session, [ADAPTED])

    def test_an_unrelated_dash_failure_is_not_counted_as_the_legacy_refusal(self):
        missing = b'Error: reading input file: open -: no such file or directory\n'
        for failure in (refusal(b'Error: adapting config: unrecognized directive\n'),
                        refusal(missing, exit_code=137), refusal(missing, reason='deadline')):
            session = Session()
            with self.subTest(failure=failure.diagnostic), self.assertRaises(native.ControlFailure):
                self.run_witness(session, [failure])

    def test_path_dependent_fixture_must_be_refused_for_the_right_reason(self):
        cases = ((None, ValueError, 'without refusal'), (ValueError('other refusal'), ValueError, 'other refusal'),
                 (refusal(b'depends on its input path'), native.ControlFailure, 'private Caddy control'))
        for dependent, expected, message in cases:
            session = Session(dependent=dependent)
            with self.subTest(message=message), self.assertRaisesRegex(expected, message):
                self.run_witness(session, [ADAPTED])

    def test_fixture_arrives_on_standard_input_and_is_bounded(self):
        for payload in (b'', b'x' * (native.LIMIT + 1)):
            stream = unittest.mock.Mock(buffer=io.BytesIO(payload))
            with self.subTest(size=len(payload)), patch.object(native.sys, 'argv', ['witness', IDENTIFIER]), \
                    patch.object(native.sys, 'stdin', stream), patch.object(native, 'validate_system') as validate, \
                    self.assertRaisesRegex(ValueError, 'missing or exceeds'):
                native.main()
            validate.assert_not_called()


if __name__ == '__main__':
    unittest.main()
