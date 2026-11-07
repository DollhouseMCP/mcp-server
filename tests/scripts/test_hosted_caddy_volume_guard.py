"""Synthetic local daemon and writer inventory tests."""
import importlib.util
from pathlib import Path
import tempfile
import unittest

MODULE = Path(__file__).resolve().parents[2] / 'scripts/hosted-deploy/caddy_volume_guard.py'
spec = importlib.util.spec_from_file_location('caddy_volume_guard', MODULE)
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)


class VolumeGuardTests(unittest.TestCase):
    def test_local_only(self):
        guard.require_local_endpoint('unix:///var/run/docker.sock')
        for endpoint in ('tcp://host:2376', 'ssh://host', '', None):
            with self.subTest(endpoint=endpoint), self.assertRaises(ValueError):
                guard.require_local_endpoint(endpoint)

    def test_volume_identity_and_writers(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            volume = {'Name': 'old_data', 'Driver': 'local', 'Scope': 'local',
                      'Mountpoint': str(root), 'CreatedAt': 'fixture'}
            observed = guard.volume_identity(volume, 'old_data')
            guard.refuse_writers([], [observed])
            for mount in ({'Type': 'volume', 'Name': 'old_data', 'RW': True},
                          {'Type': 'bind', 'Source': str(root), 'RW': True},
                          {'Type': 'bind', 'Source': str(root.parent), 'RW': True},
                          {'Type': 'volume', 'RW': True}):
                containers = [{'State': {'Running': True}, 'Mounts': [mount]}]
                with self.subTest(mount=mount), self.assertRaises(ValueError):
                    guard.refuse_writers(containers, [observed])
            guard.refuse_writers([{'State': {'Running': False}, 'Mounts': [
                {'Type': 'volume', 'Name': 'old_data', 'RW': True}]}], [observed])
            with self.assertRaises(ValueError):
                guard.volume_identity(dict(volume, Driver='remote'), 'old_data')

    def test_rejects_all_cross_aliases(self):
        volumes = [{'name': 'v' + str(i), 'device': 1, 'inode': i,
                    'mountpoint': '/var/lib/docker/volumes/v' + str(i)} for i in range(4)]
        guard.validate_volume_pair(volumes)
        volumes[2] = dict(volumes[2], device=volumes[0]['device'], inode=volumes[0]['inode'])
        with self.assertRaises(ValueError):
            guard.validate_volume_pair(volumes)


if __name__ == '__main__':
    unittest.main()
