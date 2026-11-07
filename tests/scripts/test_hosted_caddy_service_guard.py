"""Synthetic Compose service selection refuses ambiguity."""
import json
from pathlib import Path
import sys
import unittest

SCRIPTS = Path(__file__).resolve().parents[2] / 'scripts'
sys.path.insert(0, str(SCRIPTS / 'hosted-deploy'))
sys.path.insert(0, str(SCRIPTS))
import caddy_service_guard
import test_hosted_caddy_legacy_profile as fixtures


class ServiceGuardTests(unittest.TestCase):
    def test_singleton_or_missing(self):
        container, _ = fixtures.fixture()
        def one(argv, timeout, maximum):
            if argv[1] == 'ps':
                return (container['Id'] + '\n').encode()
            return json.dumps([container]).encode()
        self.assertEqual(caddy_service_guard.unique_proxy(one, 'site'), container['Id'])
        self.assertIsNone(caddy_service_guard.unique_proxy(lambda *args: b'', 'site', required=False))

    def test_duplicate_or_foreign_refuses(self):
        def duplicate(*args):
            return (('a' * 64) + '\n' + ('b' * 64) + '\n').encode()
        with self.assertRaises(ValueError):
            caddy_service_guard.unique_proxy(duplicate, 'site')
        container, _ = fixtures.fixture()
        container['Config']['Labels']['com.docker.compose.service'] = 'other'
        def foreign(argv, timeout, maximum):
            if argv[1] == 'ps':
                return (container['Id'] + '\n').encode()
            return json.dumps([container]).encode()
        with self.assertRaises(ValueError):
            caddy_service_guard.unique_proxy(foreign, 'site')


if __name__ == '__main__':
    unittest.main()
