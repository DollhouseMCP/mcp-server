#!/usr/bin/env python3
"""Tiny in-process receipt mocks; no Docker/compiler/candidate/subprocess executes."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('proof_evidence', Path(__file__).with_name('evidence.py'))
evidence = importlib.util.module_from_spec(spec)
spec.loader.exec_module(evidence)


class Evidence(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='node-receipt-fixture-')
        self.root = Path(self.directory.name)
        self.environment = patch.dict(os.environ, GITHUB_SHA='a'*40, GITHUB_RUN_ID='123', GITHUB_RUN_ATTEMPT='1')
        self.environment.start()

    def tearDown(self):
        self.environment.stop()
        self.directory.cleanup()

    def call(self, mode, *args):
        with patch.object(sys, 'argv', ['evidence.py', mode, str(self.root), 'linux/amd64', *args]):
            evidence.main()

    def read(self, name):
        return json.loads((self.root/name).read_text())

    def image(self, digit):
        return json.dumps({'Id':'sha256:'+digit*64,'Architecture':'amd64','Os':'linux','Size':1024,'RootFS':{'Layers':[]},'labels':{}}).encode()

    def test_image_identity_retained_before_probes_and_partial_binding_failure(self):
        with patch.object(evidence.subprocess, 'check_output', side_effect=[self.image('1'),subprocess.CalledProcessError(7,['mock-docker'])]):
            with self.assertRaises(SystemExit): self.call('bind','builder','production')
        binding=self.read('source-images-before-base-build.json')
        self.assertEqual(binding['source']['GITHUB_SHA'],'a'*40)
        self.assertEqual(binding['images']['builder']['probe_execution_id'],'sha256:'+'1'*64)
        self.assertIn('production',binding['errors'])
        self.assertTrue(binding['bound_before_runtime_probes'])

    def test_platform_mismatch_refuses_probe_binding(self):
        wrong=json.loads(self.image('1')); wrong['Architecture']='arm64'
        with patch.object(evidence.subprocess,'check_output',return_value=json.dumps(wrong).encode()):
            with self.assertRaises(SystemExit): self.call('bind','builder','production','base')
        self.assertEqual(self.read('source-image-binding.json')['images'],{})

    def test_failed_phase_original_status_and_partial_logs_survive(self):
        self.call('init')
        self.call('phase','native-compile','started','-')
        self.call('phase','native-compile','finished','7')
        raw=b'partial compile output'; (self.root/'native-compile.log').write_bytes(raw)
        self.call('finalize','7','native-compile','1')
        receipt=self.read('completion.json')
        self.assertEqual(receipt['exit_status'],7)
        self.assertEqual(receipt['probe_exit_status'],7)
        self.assertEqual(receipt['cleanup_status'],1)
        self.assertEqual(receipt['files']['native-compile.log']['sha256'],hashlib.sha256(raw).hexdigest())
        self.assertEqual(self.read('phases.json')[-1]['exit_status'],7)

    def test_cleanup_observes_absence_and_unknown_without_masking_failure(self):
        with patch.object(evidence.subprocess,'check_output',return_value=b''):
            self.call('cleanup','exact-owned-name')
        self.assertEqual(self.read('cleanup.json')['state'],'ABSENCE_OBSERVED')
        with patch.object(evidence.subprocess,'check_output',side_effect=OSError('mock unavailable')):
            with self.assertRaises(SystemExit): self.call('cleanup','exact-owned-name')
        self.assertEqual(self.read('cleanup.json')['state'],'UNKNOWN')
        self.call('finalize','0','complete','1')
        self.assertEqual(self.read('completion.json')['exit_status'],1)
        self.assertEqual(self.read('completion.json')['probe_exit_status'],0)

    def test_cleanup_removes_only_exact_owned_container_then_verifies_absence(self):
        with patch.object(evidence.subprocess,'check_output',side_effect=[b'exact-owned-name\nother\n',b'other\n']), patch.object(evidence.subprocess,'run') as remove:
            self.call('cleanup','exact-owned-name')
        self.assertEqual(remove.call_args.args[0],['docker','rm','-f','exact-owned-name'])
        self.assertEqual(self.read('cleanup.json')['state'],'REMOVED_AND_ABSENCE_OBSERVED')

    def test_hash_budget_exhaustion_is_incomplete_failure(self):
        self.call('init')
        with patch.object(evidence.time,'monotonic',side_effect=[0,11]):
            with self.assertRaises(SystemExit): self.call('finalize','0','complete','0')
        self.assertFalse(self.read('completion.json')['hash_inventory_complete'])
        self.assertEqual(self.read('completion.json')['exit_status'],1)


if __name__ == '__main__':
    unittest.main()
