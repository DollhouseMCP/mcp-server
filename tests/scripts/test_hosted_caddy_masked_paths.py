"""Exact observed masked paths for both supported proxy profiles; no Docker."""
import unittest

import test_hosted_caddy_legacy_profile as legacy
import test_hosted_caddy_hardened_profile as hardened


# Literal order observed in the retained host preflight, independent of the
# admission module's expected list.
OBSERVED = ['/proc/acpi', '/proc/asound', '/proc/interrupts', '/proc/kcore', '/proc/keys',
            '/proc/latency_stats', '/proc/sched_debug', '/proc/scsi', '/proc/timer_list',
            '/proc/timer_stats', '/sys/devices/virtual/powercap', '/sys/firmware']


class MaskedPathsTests(unittest.TestCase):
    def validate(self, role, masked, readonly=None):
        if role == 'legacy':
            container, image = legacy.fixture()
            container['HostConfig']['MaskedPaths'] = masked
            if readonly is not None:
                container['HostConfig']['ReadonlyPaths'] = readonly
            return legacy.profile.validate_legacy_profile(container, image, '/srv/site/Caddyfile', 'site_default')
        container, image, admission, ports = hardened.hardened()
        container['HostConfig']['MaskedPaths'] = masked
        if readonly is not None:
            container['HostConfig']['ReadonlyPaths'] = readonly
        return hardened.caddy_hardened_profile.validate_hardened_profile(
            container, image, admission, 'site', '/srv/site/Caddyfile', ['site_data', 'site_config'], ports)

    def test_exact_observed_paths_are_order_independent(self):
        for role in ('legacy', 'hardened'):
            for paths in (OBSERVED, list(reversed(OBSERVED)), OBSERVED[5:] + OBSERVED[:5]):
                with self.subTest(role=role, paths=paths):
                    self.assertEqual(self.validate(role, paths)['container_id'], 'b' * 64)

    def test_each_missing_path_extra_and_duplicate_refuse(self):
        for role in ('legacy', 'hardened'):
            for index, path in enumerate(OBSERVED):
                with self.subTest(role=role, missing=path), self.assertRaises(ValueError):
                    self.validate(role, OBSERVED[:index] + OBSERVED[index + 1:])
                with self.subTest(role=role, duplicate=path), self.assertRaises(ValueError):
                    self.validate(role, OBSERVED + [path])
                with self.subTest(role=role, replaced_by_duplicate=path), self.assertRaises(ValueError):
                    self.validate(role, OBSERVED[:index] + OBSERVED[index + 1:] + [OBSERVED[(index + 1) % len(OBSERVED)]])
            with self.subTest(role=role, extra=True), self.assertRaises(ValueError):
                self.validate(role, OBSERVED + ['/proc/extra'])

    def test_malformed_masked_and_unchanged_readonly_refuse(self):
        for role in ('legacy', 'hardened'):
            for paths in (None, [], ' '.join(OBSERVED), tuple(OBSERVED), {'/proc/acpi': True},
                          OBSERVED[:-1] + [None], OBSERVED[:-1] + [[]], OBSERVED[:-1] + [1]):
                with self.subTest(role=role, paths=paths), self.assertRaises(ValueError):
                    self.validate(role, paths)
            with self.subTest(role=role, readonly=True), self.assertRaises(ValueError):
                self.validate(role, OBSERVED, ['/proc/bus'])


if __name__ == '__main__':
    unittest.main()
