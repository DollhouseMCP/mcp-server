"""Private receipt and bundle-binding tests without Docker."""
import hashlib
import importlib.util
import os
import sys
from pathlib import Path
import tempfile
import unittest

MODULE = Path(__file__).resolve().parents[2] / 'scripts/hosted-deploy/caddy_recovery_receipt.py'
sys.path.insert(0, str(MODULE.parent))
sys.path.insert(0, str(MODULE.parent.parent))
spec = importlib.util.spec_from_file_location('caddy_recovery_receipt', MODULE)
receipt = importlib.util.module_from_spec(spec)
spec.loader.exec_module(receipt)


def sample_profile():
    return {'container_id': 'b' * 64, 'image_id': 'sha256:' + 'c' * 64,
            'diff_ids': ['sha256:' + 'd' * 64], 'data_volume': 'site_data',
            'config_volume': 'site_config', 'public_env': {}, 'network': 'site_default',
            'aliases': ['caddy'], 'ports': [{'container_port': '80/tcp', 'host_ip': '0.0.0.0', 'host_port': '80'}],
            'platform': 'linux/arm64', 'repo_digests': [], 'logging': {'max-size': '25m', 'max-file': '5'}}


def sample_clone():
    volumes = [{'name': name, 'driver': 'local', 'created_at': 'fixture',
                'mountpoint': '/volumes/' + name, 'device': 1, 'inode': index}
               for index, name in enumerate(('site_data', 'site_config', 'new_data', 'new_config'), 1)]
    return {'volumes': volumes, 'copy': {'schema': 'caddy-volume-clone-v1', 'entries': 1, 'bytes': 1,
                                        'root_modes': {'data': 0o700, 'config': 0o700},
                                        'inventory_sha256': 'e' * 64, 'certificate_sha256': []}}


class ReceiptTests(unittest.TestCase):
    def test_old_caddyfile_is_bounded_and_never_followed(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            target = root / 'Caddyfile'
            target.write_bytes(b'original')
            target.chmod(0o644)
            self.assertEqual(receipt.read_current_caddyfile(root), b'original')
            target.unlink()
            target.symlink_to(root / 'other')
            with self.assertRaises(OSError):
                receipt.read_current_caddyfile(root)

    def test_private_snapshot_and_binding(self):
        with tempfile.TemporaryDirectory() as temporary:
            parent = Path(temporary)
            parent.chmod(0o700)
            data = b'example.test { respond "ok" }\n'
            bundle = parent / 'server.prev'
            identity = {'sha256': 'a' * 64, 'entries': 1, 'bytes': 1}
            record = {'schema': 1, 'bundle': str(bundle), 'bundle_identity': identity,
                      'caddyfile_sha256': hashlib.sha256(data).hexdigest(), 'profile': sample_profile(), 'clone': sample_clone()}
            path = receipt.create_receipt(parent, record, data)
            self.assertEqual(receipt.read_receipt(path, bundle, identity), record)
            self.assertEqual(path.stat().st_mode & 0o777, 0o700)
            self.assertEqual((path / 'receipt.json').stat().st_mode & 0o777, 0o600)
            with self.assertRaises(ValueError):
                receipt.read_receipt(path, parent / 'other', identity)
            (path / 'Caddyfile').write_bytes(b'changed')
            with self.assertRaises(ValueError):
                receipt.read_receipt(path, bundle, identity)

    def test_refuses_permissive_or_linked_record(self):
        with tempfile.TemporaryDirectory() as temporary:
            parent = Path(temporary)
            parent.chmod(0o700)
            data = b'fixture'
            identity = {'sha256': 'a' * 64, 'entries': 0, 'bytes': 0}
            record = {'schema': 1, 'bundle': '/bundle', 'bundle_identity': identity,
                      'caddyfile_sha256': hashlib.sha256(data).hexdigest(), 'profile': sample_profile(), 'clone': sample_clone()}
            path = receipt.create_receipt(parent, record, data)
            (path / 'receipt.json').chmod(0o644)
            with self.assertRaises(ValueError):
                receipt.read_receipt(path, Path('/bundle'), identity)
            (path / 'receipt.json').unlink()
            os.symlink(path / 'Caddyfile', path / 'receipt.json')
            with self.assertRaises(OSError):
                receipt.read_receipt(path, Path('/bundle'), identity)


if __name__ == '__main__':
    unittest.main()
