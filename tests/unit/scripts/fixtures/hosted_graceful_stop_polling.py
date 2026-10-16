"""Run the actual helper with deterministic clock/CLI fakes; no Docker or child CLI.

The Jest entry point invokes this standard-library control synchronously. The
helper's real validation, ACK binding, TERM decision and polling loop execute.
"""
import builtins
import contextlib
from decimal import Decimal
import io
import json
import os
from pathlib import Path
import runpy
import shutil
import subprocess
import sys
import time
import types
import unittest

HELPER = Path(sys.argv.pop(1)).resolve()
TARGET = 'a' * 64
NONCE = 'b' * 64


class Scenario:
    def __init__(self, mode='delayed', seconds=1, nonce=NONCE):
        self.mode = mode
        self.nonce = nonce
        self.entropy_calls = []
        self.helper_imports = []
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
        if self.mode not in ('frozen-clock', 'zero-cost-tail', 'zero-cost-live', 'resolution-close'):
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
            delay = Decimal('1.2') if self.mode == 'late-close' else Decimal('0.94') if self.mode == 'tail-close' else Decimal('0.96') if self.mode == 'zero-cost-tail' else Decimal('0.9998') if self.mode == 'resolution-close' else Decimal('0.35')
            closed = after_term and self.mode not in ('live', 'zero-cost-live', 'frozen-clock', 'restart') and self.now >= self.term_at + delay
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
            if args[8] != TARGET or args[9] != self.nonce or not 0 < int(args[10]) <= self.seconds * 1000:
                raise AssertionError('Changed drain identity or budget')
            ack = dict(protocol=2, phase='drained', containerId=TARGET, nonce=self.nonce,
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


def execute(mode='delayed', seconds=1, entropy=bytes.fromhex(NONCE), entropy_error=None):
    scenario = Scenario(mode, seconds, entropy.hex())
    original_import = builtins.__import__

    def observe_import(name, globals=None, locals=None, fromlist=(), level=0):
        if globals and globals.get('__file__') == str(HELPER):
            scenario.helper_imports.append(name)
        return original_import(name, globals, locals, fromlist, level)

    def entropy_source(size):
        scenario.entropy_calls.append(size)
        if size != 32:
            raise AssertionError('Changed nonce entropy byte count')
        if entropy_error is not None:
            raise entropy_error
        return entropy

    stdout, stderr = io.StringIO(), io.StringIO()
    code = 0
    bindings = (
        (sys, 'argv', [str(HELPER), TARGET, str(seconds)]),
        (time, 'monotonic', scenario.monotonic),
        (time, 'sleep', scenario.sleep),
        (shutil, 'which', lambda *_args, **_kwargs: 'synthetic-docker'),
        (os, 'urandom', entropy_source),
        (subprocess, 'run', scenario.run),
        (builtins, '__import__', observe_import),
    )
    with contextlib.ExitStack() as originals:
        for module, attribute, replacement in bindings:
            original = getattr(module, attribute)
            originals.callback(setattr, module, attribute, original)
            setattr(module, attribute, replacement)
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            try:
                runpy.run_path(str(HELPER), run_name='__main__')
            except SystemExit as result:
                code = result.code
    if 'os' not in scenario.helper_imports or 'secrets' in scenario.helper_imports:
        raise AssertionError('Changed direct helper nonce import boundary')
    if len(scenario.entropy_calls) > 1 or any(size != 32 for size in scenario.entropy_calls):
        raise AssertionError('Repeated or changed entropy request')
    # These guards apply to every positive and negative actual-helper execution.
    if scenario.post_inspects > seconds * 10 + 10:
        raise AssertionError('Post-TERM inspect count exceeded explicit bound')
    if sum(args[0] == 'inspect' for args, _ in scenario.calls) > seconds * 10 + 12:
        raise AssertionError('Total inspect count exceeded initial two plus post-TERM bound')
    if len(scenario.calls) > seconds * 10 + 14:
        raise AssertionError('Total CLI count exceeded explicit bound')
    if sum(args[0] == 'kill' for args, _ in scenario.calls) > 1:
        raise AssertionError('Repeated TERM')
    return scenario, code, stdout.getvalue(), stderr.getvalue()


class ActualHelperPolling(unittest.TestCase):
    def test_exact_nonce_bytes_width_and_single_entropy_request(self):
        vectors = [(bytes(range(start, start + 32)), expected) for start, expected in [
            (0, '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f'),
            (32, '202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f'),
            (64, '404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f'),
            (96, '606162636465666768696a6b6c6d6e6f707172737475767778797a7b7c7d7e7f'),
            (128, '808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f'),
            (160, 'a0a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6b7b8b9babbbcbdbebf'),
            (192, 'c0c1c2c3c4c5c6c7c8c9cacbcccdcecfd0d1d2d3d4d5d6d7d8d9dadbdcdddedf'),
            (224, 'e0e1e2e3e4e5e6e7e8e9eaebecedeeeff0f1f2f3f4f5f6f7f8f9fafbfcfdfeff'),
        ]]
        vectors.append((bytes(32), '0' * 64))
        for entropy, expected in vectors:
            with self.subTest(expected=expected):
                scenario, code, out, err = execute(entropy=entropy)
                self.assertEqual((code, err), (0, ''))
                self.assertEqual(out.strip(), 'Old process closed cleanly')
                self.assertEqual(scenario.entropy_calls, [32])
                nonce = next(args[9] for args, _ in scenario.calls if args[0] == 'exec')
                self.assertEqual(nonce, expected)
                self.assertRegex(nonce, r'^[a-f0-9]{64}$')

    def test_entropy_failures_refuse_before_exec_or_term_without_retry(self):
        for failure in [OSError('entropy unavailable'), RuntimeError('entropy unavailable'),
                        ValueError('entropy unavailable'), TypeError('entropy unavailable'),
                        KeyError('entropy unavailable'), NotImplementedError('entropy unavailable')]:
            with self.subTest(error=type(failure).__name__):
                scenario, code, out, err = execute(entropy_error=failure)
                self.assertEqual(code, 1)
                self.assertEqual(out, '')
                self.assertNotEqual(err, '')
                self.assertEqual(scenario.entropy_calls, [32])
                self.assertEqual([args[0] for args, _ in scenario.calls], ['inspect'])
                self.assertIsNone(scenario.term_at)

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

    def test_every_sleep_obeys_bounded_resolution_and_remaining_window(self):
        for mode in ['delayed', 'tail-close', 'live', 'zero-cost-tail', 'zero-cost-live']:
            with self.subTest(mode=mode):
                scenario, _, _, _ = execute(mode)
                for duration, remaining in scenario.sleeps:
                    self.assertGreater(remaining, 0)
                    self.assertGreaterEqual(duration, 0)
                    # Numeric allowance covers float conversion only, not an
                    # extension to the product's strict absolute deadline.
                    self.assertLessEqual(duration, remaining + 1e-12)
                    self.assertAlmostEqual(duration, min(remaining, max(0.001, min(0.1, remaining / 2))), delta=1e-12)

    def test_zero_cost_tail_close_is_observed_before_count_exhaustion(self):
        scenario, code, out, err = execute('zero-cost-tail')
        self.assertEqual((code, err), (0, ''))
        self.assertEqual(out.strip(), 'Old process closed cleanly')
        self.assertGreaterEqual(scenario.now, Decimal('0.96'))
        self.assertLess(scenario.now, 1)
        self.assertEqual(scenario.post_inspects, 12)

    def test_advancing_live_clock_reaches_expiry_before_count_cap(self):
        scenario, code, out, err = execute('zero-cost-live')
        self.assertEqual(code, 1)
        self.assertEqual(out, '')
        self.assertIn('refused', err)
        self.assertGreaterEqual(scenario.now, 1)
        self.assertLess(scenario.post_inspects, 20)
        self.assertTrue(any(remaining <= 0.001 for _, remaining in scenario.sleeps))
        # At the declared resolution the last positive sub-ms window is
        # deliberately consumed, without accepting a later observation.
        self.assertAlmostEqual(scenario.sleeps[-1][0], scenario.sleeps[-1][1], delta=1e-12)

    def test_final_submillisecond_close_is_not_claimed_observed(self):
        scenario, code, out, err = execute('resolution-close')
        self.assertEqual(code, 1)
        self.assertEqual(out, '')
        self.assertIn('refused', err)
        self.assertGreaterEqual(scenario.now, 1)
        self.assertLess(scenario.post_inspects, 20)

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
                self.assertEqual(scenario.post_inspects, seconds * 10 + 10)
                self.assertEqual(len(scenario.calls), seconds * 10 + 14)


if __name__ == '__main__':
    unittest.main()
