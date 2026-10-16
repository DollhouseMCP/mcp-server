"""Run the actual helper with deterministic clock/CLI fakes; no Docker or child CLI.

The Jest entry point invokes this standard-library control synchronously. The
helper's real validation, ACK binding, TERM decision and polling loop execute.
"""
import contextlib
from decimal import Decimal
import io
import json
from pathlib import Path
import runpy
import subprocess
import sys
import types
import unittest
from unittest.mock import patch

HELPER = Path(sys.argv.pop(1)).resolve()
TARGET = 'a' * 64
NONCE = 'b' * 64


class Scenario:
    def __init__(self, mode='delayed', seconds=1):
        self.mode = mode
        self.seconds = seconds
        self.now = Decimal(0)
        self.term_at = None
        self.calls = []
        self.post_inspects = 0
        self.sleeps = []

    def monotonic(self):
        return float(self.now)

    def sleep(self, duration):
        if duration < 0:
            raise AssertionError('Negative sleep')
        self.sleeps.append((duration, float(Decimal(self.seconds) - self.now)))
        if self.mode != 'frozen-clock':
            self.now += Decimal(str(duration))

    def run(self, argv, **options):
        if self.now >= self.seconds:
            raise AssertionError('CLI invoked after absolute deadline')
        if options['timeout'] <= 0 or options['timeout'] > float(Decimal(self.seconds) - self.now) + 1e-9:
            raise AssertionError('CLI timeout extends remaining budget')
        if options != dict(capture_output=True, text=True, timeout=options['timeout'], check=False):
            raise AssertionError('Changed delegated CLI options')
        args = argv[1:]
        if argv[0] != 'synthetic-docker' or args[0] not in ('inspect', 'exec', 'kill'):
            raise AssertionError('Unexpected CLI command')
        self.calls.append((args, float(self.now)))
        if self.mode != 'frozen-clock':
            self.now += Decimal('0.01')
        if self.mode == 'api-failure':
            return types.SimpleNamespace(returncode=1, stdout='')
        if self.mode == 'api-timeout':
            raise subprocess.TimeoutExpired(argv, options['timeout'])
        if args[0] == 'inspect':
            after_term = self.term_at is not None
            if after_term:
                self.post_inspects += 1
            if self.mode == 'exhausted-initial' and not after_term:
                self.now = Decimal('1.1')
            delay = Decimal('1.2') if self.mode == 'late-close' else Decimal('0.94') if self.mode == 'tail-close' else Decimal('0.35')
            closed = after_term and self.mode not in ('live', 'frozen-clock', 'restart') and self.now >= self.term_at + delay
            if self.mode in ('late-observation', 'deadline-observation') and after_term:
                self.now = Decimal(self.seconds) + (Decimal('0.1') if self.mode == 'late-observation' else 0)
                closed = True
            state = dict(id='f' * 64 if self.mode == 'identity' else TARGET, running=not closed,
                         exitCode=7 if self.mode == 'nonzero' else 0, oomKilled=self.mode == 'oom' and closed,
                         startedAt='changed' if self.mode == 'boot' and len(self.calls) > 1 else 'first',
                         restartCount=0, restarting=self.mode == 'restart' and after_term,
                         readonly=False, mounts=[], enabled='enabled', capability='v2')
            return types.SimpleNamespace(returncode=0, stdout=json.dumps(state))
        if args[0] == 'exec':
            if args[:8] != ['exec', '--user', '1001:1001', '--workdir', '/app', TARGET, 'node', '/app/dist/lifecycle/requestMemoryDrain.js']:
                raise AssertionError('Changed drain binding')
            if args[8] != TARGET or args[9] != NONCE or not 0 < int(args[10]) <= self.seconds * 1000:
                raise AssertionError('Changed drain identity or budget')
            ack = dict(protocol=2, phase='drained', containerId=TARGET, nonce=NONCE,
                       bootId='c' * 64, generation='d' * 64, sourceBootId='c' * 64,
                       mode='same-boot', admitted=0, writes=0, failedWrites=0, retainedOwners=0)
            if self.mode == 'wrong-nonce':
                ack['nonce'] = 'e' * 64
            if self.mode == 'missing-ack':
                del ack['generation']
            if self.mode == 'obligations':
                ack['failedWrites'] = 1
            if self.mode == 'ack-boot':
                ack['sourceBootId'] = 'e' * 64
            return types.SimpleNamespace(returncode=0, stdout=json.dumps(ack))
        if args != ['kill', '--signal=TERM', TARGET] or self.term_at is not None:
            raise AssertionError('Repeated TERM or escalation')
        self.term_at = self.now
        return types.SimpleNamespace(returncode=0, stdout='')


def execute(mode='delayed', seconds=1):
    scenario = Scenario(mode, seconds)
    stdout, stderr = io.StringIO(), io.StringIO()
    code = 0
    with patch.object(sys, 'argv', [str(HELPER), TARGET, str(seconds)]), \
            patch('time.monotonic', scenario.monotonic), patch('time.sleep', scenario.sleep), \
            patch('shutil.which', return_value='synthetic-docker'), \
            patch('secrets.token_hex', return_value=NONCE), patch('subprocess.run', scenario.run), \
            contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
        try:
            runpy.run_path(str(HELPER), run_name='__main__')
        except SystemExit as result:
            code = result.code
    # These guards apply to every positive and negative actual-helper execution.
    if scenario.post_inspects > seconds * 10 + 1:
        raise AssertionError('Post-TERM inspect count exceeded explicit bound')
    if sum(args[0] == 'inspect' for args, _ in scenario.calls) > seconds * 10 + 3:
        raise AssertionError('Total inspect count exceeded initial two plus post-TERM bound')
    if sum(args[0] == 'kill' for args, _ in scenario.calls) > 1:
        raise AssertionError('Repeated TERM')
    return scenario, code, stdout.getvalue(), stderr.getvalue()


class ActualHelperPolling(unittest.TestCase):
    def test_delayed_clean_close_before_same_deadline(self):
        scenario, code, out, err = execute()
        self.assertEqual((code, err), (0, ''))
        self.assertEqual(out.strip(), 'Old process closed cleanly')
        self.assertLess(scenario.now, 1)
        self.assertGreater(scenario.post_inspects, 1)
        self.assertEqual(sum(args[0] == 'kill' for args, _ in scenario.calls), 1)

    def test_tail_clean_close_before_same_deadline(self):
        # TERM at model .04s; closure at .98s. A full remaining-tail sleep
        # misses it, whereas another bounded observation can still prove it.
        scenario, code, out, err = execute('tail-close')
        self.assertEqual((code, err), (0, ''))
        self.assertEqual(out.strip(), 'Old process closed cleanly')
        self.assertLess(scenario.now, 1)
        self.assertEqual(scenario.post_inspects, 11)
        self.assertEqual(sum(args[0] == 'kill' for args, _ in scenario.calls), 1)

    def test_every_sleep_leaves_half_the_positive_remaining_window(self):
        for mode in ['delayed', 'tail-close', 'live']:
            with self.subTest(mode=mode):
                scenario, _, _, _ = execute(mode)
                for duration, remaining in scenario.sleeps:
                    self.assertGreater(remaining, 0)
                    self.assertGreaterEqual(duration, 0)
                    # Numeric allowance covers float conversion only, not an
                    # extension to the product's strict absolute deadline.
                    self.assertLessEqual(duration, min(0.1, remaining / 2) + 1e-12)

    def test_live_late_and_unsafe_closure_stay_refused(self):
        for mode in ['live', 'late-close', 'nonzero', 'oom', 'restart', 'late-observation', 'deadline-observation']:
            with self.subTest(mode=mode):
                scenario, code, out, err = execute(mode)
                self.assertEqual(code, 1)
                self.assertEqual(out, '')
                self.assertIn('refused', err)
                self.assertEqual(sum(args[0] == 'kill' for args, _ in scenario.calls), 1)

    def test_invalid_authority_never_sends_term(self):
        for mode in ['boot', 'identity', 'wrong-nonce', 'missing-ack', 'obligations', 'ack-boot', 'api-failure', 'api-timeout', 'exhausted-initial']:
            with self.subTest(mode=mode):
                scenario, code, out, err = execute(mode)
                self.assertEqual(code, 1)
                self.assertEqual(out, '')
                self.assertIn('refused', err)
                self.assertIsNone(scenario.term_at)

    def test_frozen_clock_cannot_exceed_explicit_inspect_cap(self):
        for seconds in [1, 2]:
            with self.subTest(seconds=seconds):
                scenario, code, out, err = execute('frozen-clock', seconds)
                self.assertEqual(code, 1)
                self.assertEqual(out, '')
                self.assertIn('refused', err)
                self.assertEqual(scenario.post_inspects, seconds * 10 + 1)


if __name__ == '__main__':
    unittest.main()
