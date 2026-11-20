"""Synthetic receipt-bound proxy recovery preflight; no Docker or network."""
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[2] / 'scripts'
sys.path.insert(0, str(SCRIPTS / 'hosted-deploy'))
sys.path.insert(0, str(SCRIPTS))
import caddy_clone_action
import caddy_recovery_preflight
import test_hosted_caddy_clone_action as fixtures
import test_hosted_caddy_hardened_profile as hardened_fixture


class RecoveryPreflightTests(unittest.TestCase):
    def setUp(self):
        self.fx = fixtures.CloneActionTests('test_receipt_binds_source_and_retains_originals')
        self.fx.setUp()
        self.addCleanup(self.fx.doCleanups)
        self.root = self.fx.root
        with patch.dict('os.environ', {'DOCKER_HOST': ''}):
            self.receipt = caddy_clone_action.clone(self.fx.request, self.fx.run_docker)
        record = json.loads((self.receipt / 'receipt.json').read_bytes())
        self.previous = Path(record['bundle'])
        (self.root / 'server').rename(self.previous)
        self.reference = 'registry.example.test/team/caddy@sha256:' + 'a' * 64
        self.current, self.current_image, self.admission, _ = hardened_fixture.hardened()
        self.current_id = 'b' * 64
        self.image_id = self.current_image['Id']
        self.current['Id'] = self.current_id
        self.current['State'] = {'Running': True}
        self.current['Config']['Image'] = self.reference
        self.current['Mounts'][0]['Source'] = str(self.root / 'Caddyfile')
        self.current['Mounts'][1]['Name'] = 'new_data'
        self.current['Mounts'][2]['Name'] = 'new_config'
        self.admission['reference'] = self.reference
        self.calls = []

    def run_docker(self, argv, timeout, limit):
        self.calls.append(argv)
        if argv[1:3] == ['container', 'inspect'] and argv[3] in ('site-caddy', self.current_id):
            return json.dumps([self.current]).encode()
        if argv[1:3] == ['image', 'inspect'] and argv[3] == self.reference:
            return json.dumps([self.current_image]).encode()
        return self.fx.run_docker(argv, timeout, limit)

    def qualify(self, reference):
        self.assertEqual(reference, self.reference)
        return self.admission

    def preflight(self):
        return caddy_recovery_preflight.preflight(self.root, 'site', self.previous, self.reference,
                                                   self.run_docker, self.qualify)

    def test_exact_previous_bundle_and_proxy_are_bound(self):
        with patch.dict('os.environ', {'DOCKER_HOST': ''}):
            plan = self.preflight()
        self.assertEqual(plan['receipt'], self.receipt)
        self.assertEqual(plan['current_id'], self.current_id)
        self.assertFalse(any(call[1] in ('stop', 'rename', 'start') and self.current_id in call for call in self.calls))

    def test_changed_bundle_refuses_before_any_docker(self):
        (self.previous / 'app').write_text('changed')
        with self.assertRaises(ValueError):
            self.preflight()
        self.assertEqual(self.calls, [])

    def test_wrong_current_volume_refuses(self):
        self.current['Mounts'][1]['Name'] = 'wrong'
        with patch.dict('os.environ', {'DOCKER_HOST': ''}), self.assertRaises(ValueError):
            self.preflight()
        self.assertFalse(any(call[1] in ('stop', 'rename', 'start') and self.current_id in call for call in self.calls))

    def test_changed_runtime_profile_refuses_before_proxy_mutation(self):
        self.current['HostConfig']['ReadonlyRootfs'] = False
        with patch.dict('os.environ', {'DOCKER_HOST': ''}), self.assertRaises(ValueError):
            self.preflight()
        self.assertFalse(any(call[1] in ('stop', 'rename', 'start') and self.current_id in call for call in self.calls))


if __name__ == '__main__':
    unittest.main()
