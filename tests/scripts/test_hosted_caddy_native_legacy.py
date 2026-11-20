"""Inert checks that the native legacy control witness cannot pass on the wrong evidence.

The witness itself runs against real Caddy 2.8.4 in the native CI job.
"""
import copy
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
import unittest.mock
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[2] / 'scripts/ci/caddy-legacy-native.py'
spec = importlib.util.spec_from_file_location('native_legacy_witness', SCRIPT)
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)

IDENTIFIER = 'a' * 64
CADDYFILE = b'fixture.local:80 {\n\treverse_proxy dollhousemcp:8081\n}\n'


class Engine:
    """One container whose stop and start follow the fixture's exit status and boot time."""

    def __init__(self, exit_code=0, new_boot='2026-01-01T00:02:00Z'):
        self.exit_code, self.new_boot, self.commands = exit_code, new_boot, []
        self.container = {'Id': IDENTIFIER, 'Name': '/fixture-legacy', 'Image': 'sha256:' + 'b' * 64, 'RestartCount': 0,
                          'Config': {}, 'HostConfig': {}, 'Mounts': [],
                          'State': {'Running': True, 'Restarting': False, 'OOMKilled': False,
                                    'StartedAt': '2026-01-01T00:00:00Z'}}

    def run(self, argv, _timeout, _maximum):
        self.commands.append(argv)
        if argv[1:3] == ['container', 'inspect']:
            return json.dumps([copy.deepcopy(self.container)]).encode()
        state = self.container['State']
        if argv[1] == 'stop':
            state.update(Running=False, ExitCode=self.exit_code, FinishedAt='2026-01-01T00:01:00Z')
        elif argv[1] == 'start':
            state.update(Running=True, StartedAt=self.new_boot)
        return (argv[-1] + '\n').encode()


class NativeLegacyWitnessTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.parent = temporary.name
        self.checked = []
        self.match_everything = False

    def serving(self, identifier, receipt, record, boot):
        """Inert serving check: the snapshot matches only when it holds the fixture Caddyfile."""
        content = native.checks.read_caddy_snapshot(receipt, record['caddyfile_sha256'])
        self.checked.append((Path(receipt).name, boot['started_at']))
        if content != CADDYFILE and not self.match_everything:
            raise ValueError('recovered serving configuration differs from the original receipt')

    def run_witness(self, engine):
        with patch.object(native, 'system_docker', engine.run), \
                patch.object(native.checks, 'serving_config', side_effect=self.serving):
            return native.witness(IDENTIFIER, CADDYFILE, self.parent)

    def test_serving_check_brackets_the_exact_stop_and_start(self):
        engine = Engine()
        result = self.run_witness(engine)
        lifecycle = [argv for argv in engine.commands if argv[1] in ('stop', 'start')]
        self.assertEqual(lifecycle, [['docker', 'stop', '--signal', 'SIGTERM', '--timeout', '-1', IDENTIFIER],
                                     ['docker', 'start', IDENTIFIER],
                                     ['docker', 'stop', '--time', '5', IDENTIFIER]])
        self.assertIs(engine.container['State']['Running'], False)
        self.assertEqual(self.checked, [('receipt', '2026-01-01T00:00:00Z'), ('different', '2026-01-01T00:00:00Z'),
                                        ('receipt', '2026-01-01T00:02:00Z')])
        self.assertEqual((result['serving_checks'], result['clean_stop'], result['bounded_stop'],
                          result['different_snapshot_refused']), (2, True, True, True))
        self.assertEqual(result['caddyfile_sha256'], hashlib.sha256(CADDYFILE).hexdigest())
        self.assertNotEqual(result['second_boot'], result['first_boot'])

    def test_a_forced_stop_fails_the_witness_before_any_start(self):
        engine = Engine(exit_code=137)
        with self.assertRaisesRegex(ValueError, 'did not stop cleanly'):
            self.run_witness(engine)
        self.assertFalse(any(argv[1] == 'start' for argv in engine.commands))

    def test_a_start_that_keeps_the_old_boot_fails_the_witness(self):
        engine = Engine(new_boot='2026-01-01T00:00:00Z')
        with self.assertRaisesRegex(ValueError, 'single new boot'):
            self.run_witness(engine)
        self.assertEqual(len(self.checked), 2)

    def test_a_comparison_that_accepts_a_different_snapshot_fails_the_witness(self):
        self.match_everything = True
        engine = Engine()
        with self.assertRaisesRegex(ValueError, 'different receipt snapshot matched'):
            self.run_witness(engine)
        self.assertFalse(any(argv[1] in ('stop', 'start') for argv in engine.commands))

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
