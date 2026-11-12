"""The replica launcher replaces all nine pins or none, and only on a declared replica.

Synthetic values only.
"""
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[2] / 'scripts'
sys.path.insert(0, str(SCRIPTS / 'hosted-replica'))
sys.path.insert(0, str(SCRIPTS / 'hosted-deploy'))
import run_with_replica_pins as launcher
import legacy_manual_recovery_import as manual

LIVE = dict(manual.ACCEPTED)
PINS = {name: '%064x' % number for number, name in enumerate(sorted(LIVE), 1)}


class LauncherTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.addCleanup(os.chdir, os.getcwd())
        self.addCleanup(manual.ACCEPTED.update, LIVE)
        os.chdir(temporary.name)
        self.ran = []

    def launch(self, action, pins=PINS, declared=True):
        if pins is not None:
            Path(launcher.PINS).write_text(json.dumps(pins), encoding='utf-8')
        declaration = patch.object(launcher, 'declared_replica', side_effect=None if declared else launcher.Refused('no'))
        run = patch.object(launcher.runpy, 'run_path', side_effect=lambda path, run_name: self.ran.append(
            (Path(path).name, run_name, list(sys.argv[1:]), dict(manual.ACCEPTED))))
        with declaration, run, patch.object(sys, 'argv', list(sys.argv)), patch.object(sys, 'stderr', io.StringIO()) as errors:
            status = launcher.main(['run_with_replica_pins.py', action])
            return status, errors.getvalue()

    def test_action_runs_the_real_script_with_every_pin_replaced(self):
        for action, script in launcher.ACTIONS.items():
            status, errors = self.launch(action)
            self.assertEqual(status, 0)
            self.assertEqual(self.ran[-1], (script, '__main__', [action], PINS))
            self.assertTrue((launcher.TOOLING / script).is_file())
            self.assertIn('replica pins replaced: ' + ', '.join(sorted(PINS)), errors)

    def test_pins_are_the_same_names_the_tooling_pins(self):
        self.assertEqual(len(LIVE), 9)
        for bad in (dict(list(PINS.items())[:8]), dict(PINS, extra='0' * 64), dict(PINS, state='not-a-hash'),
                    dict(PINS, state=None), []):
            with self.assertRaises(launcher.Refused):
                self.launch('reconcile-legacy', bad)
        self.assertEqual((manual.ACCEPTED, self.ran), (LIVE, []))

    def test_refused_on_a_host_that_is_not_a_declared_replica(self):
        with self.assertRaises(launcher.Refused):
            self.launch('reconcile-legacy', declared=False)
        self.assertEqual((manual.ACCEPTED, self.ran), (LIVE, []))

    def test_only_the_three_reconciliation_actions_are_accepted(self):
        for argv in (['x'], ['x', 'recover-legacy'], ['x', 'reconcile-legacy', 'more']):
            with self.assertRaises(ValueError):
                launcher.main(argv)
        self.assertEqual(self.ran, [])

    def test_live_pins_are_untouched_without_the_launcher(self):
        self.assertEqual(manual.ACCEPTED['manual_receipt'], 'b77bda432e549d0bf845db01478d48aed31466862c58dbb7ee61819b5a012ce8')


if __name__ == '__main__':
    unittest.main()
