"""Offline source bundle binding checks."""
import importlib.util
from pathlib import Path
import tempfile
import unittest

MODULE = Path(__file__).resolve().parents[2] / 'scripts/hosted-deploy/caddy_bundle_identity.py'
spec = importlib.util.spec_from_file_location('caddy_bundle_identity', MODULE)
identity = importlib.util.module_from_spec(spec)
spec.loader.exec_module(identity)


class BundleIdentityTests(unittest.TestCase):
    def test_stable_bytes_and_modes_bind_identity(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / 'bundle'
            root.mkdir()
            (root / 'app').mkdir()
            target = root / 'app' / 'main'
            target.write_bytes(b'abc')
            first = identity.bundle_identity(root)
            self.assertEqual(first, identity.bundle_identity(root))
            target.write_bytes(b'abd')
            self.assertNotEqual(first['sha256'], identity.bundle_identity(root)['sha256'])
            target.write_bytes(b'abc')
            target.chmod(0o755)
            self.assertNotEqual(first['sha256'], identity.bundle_identity(root)['sha256'])

    def test_symlink_and_hardlink_refuse(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / 'bundle'
            root.mkdir()
            target = root / 'file'
            target.write_bytes(b'x')
            link = root / 'link'
            link.symlink_to(target)
            with self.assertRaises(ValueError):
                identity.bundle_identity(root)
            link.unlink()
            link.hardlink_to(target)
            with self.assertRaises(ValueError):
                identity.bundle_identity(root)


if __name__ == '__main__':
    unittest.main()
