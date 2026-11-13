"""Safe allowlisted reading of a disposable historical filesystem archive."""
import io
import os
from pathlib import Path
import sys
import tarfile
import unittest
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[2] / 'scripts'
sys.path.insert(0, str(SCRIPTS / 'hosted-deploy'))
sys.path.insert(0, str(SCRIPTS))
from legacy_manual_recovery_import import OVERLAYS, fixed_members, validate_failed_state
from legacy_handoff import digest
from legacy_reconcile_action import prepare_request


class ManualArchiveTests(unittest.TestCase):
    ROOT = Path('/opt/fixture')
    REQUIRED = ('.env', '.env.production', 'compose.yml', 'Caddyfile')

    def archive(self, mutate=None, extra=()):
        output = io.BytesIO()
        with tarfile.open(fileobj=output, mode='w') as archive:
            for name in (*self.REQUIRED, *OVERLAYS.values(), 'portfolio/unrelated', *extra):
                item = tarfile.TarInfo('opt/fixture/' + name)
                item.uid = os.geteuid()
                item.mode = 0o600
                data = ('fixture-' + name).encode()
                item.size = len(data)
                if mutate:
                    mutate(name, item)
                archive.addfile(item, io.BytesIO(data))
        return output.getvalue()

    def test_only_fixed_original_controls_and_both_overlays_are_read(self):
        selected = fixed_members(self.ROOT, self.archive(extra=('../unrelated',)))
        self.assertEqual(set(selected), set(self.REQUIRED) | set(OVERLAYS))
        self.assertEqual(selected['.env'], (b'fixture-.env', 0o600))
        self.assertNotIn('portfolio/unrelated', selected)

    def test_duplicate_or_nonprivate_original_environment_is_refused(self):
        duplicate = self.archive(extra=('.env',))
        with self.assertRaisesRegex(ValueError, 'archive member is unsafe'):
            fixed_members(self.ROOT, duplicate)

        def public(name, item):
            if name == '.env':
                item.mode = 0o644

        public_environment = self.archive(public)
        with self.assertRaisesRegex(ValueError, 'environment was not private'):
            fixed_members(self.ROOT, public_environment)

    def test_historical_destination_names_are_not_operator_overrides(self):
        raw = b'exact accepted failed state'
        state = {'completed': None}
        pending = {'volumes': ['old-data', 'old-config']}
        value = {'data_volume': 'old-data', 'config_volume': 'old-config'}
        with patch('legacy_manual_recovery_import.raw_state', return_value=raw), patch.dict(
                'legacy_manual_recovery_import.ACCEPTED', {'state': digest(raw)}):
            validate_failed_state(self.ROOT, value, state, pending)
            with self.assertRaisesRegex(ValueError, 'failed controls differ'):
                validate_failed_state(self.ROOT, {**value, 'data_volume': 'new-data'}, state, pending)

    def test_archive_links_and_wrong_owner_never_become_controls(self):
        for kind in (tarfile.SYMTYPE, tarfile.LNKTYPE):
            def link(name, item):
                if name == '.env.production':
                    item.type = kind
                    item.linkname = '/fixture/unknown'
                    item.size = 0
            linked = self.archive(link)
            with self.subTest(kind=kind), self.assertRaisesRegex(ValueError, 'archive member is unsafe'):
                fixed_members(self.ROOT, linked)

        def owner(name, item):
            if name == 'compose.yml':
                item.uid = os.geteuid() + 1

        wrong_owner = self.archive(owner)
        with self.assertRaisesRegex(ValueError, 'archive member is unsafe'):
            fixed_members(self.ROOT, wrong_owner)

    def test_preparation_never_accepts_a_handwritten_token_or_receipt_override(self):
        inputs = {'deploy_dir': '/fixture', 'instance': 'site',
                  'checkpoint_dir': '/protected/checkpoint', 'manual_evidence_dir': '/protected/evidence'}
        for field in ('token', 'receipt_identities', 'data_volume', 'proxy_recovery_token'):
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, 'never tokens'):
                prepare_request({**inputs, field: 'b' * 32})


if __name__ == '__main__':
    unittest.main()
