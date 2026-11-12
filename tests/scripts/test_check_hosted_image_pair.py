import copy
import importlib.util
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('check_hosted_image_pair', ROOT / 'scripts/ci/check-hosted-image-pair.py')
subject = importlib.util.module_from_spec(spec)
spec.loader.exec_module(subject)

SOURCE = 'c' * 40
DAEMON = {'OSType': 'linux', 'Architecture': 'x86_64'}
MIGRATIONS = [
    {'tag': '0000_first', 'when': 1000, 'hash': 'a' * 64},
    {'tag': '0001_second', 'when': 2000, 'hash': 'b' * 64},
]


def image(role, source=SOURCE, architecture='amd64'):
    labels = {'org.dollhousemcp.engine-proof-source': source, 'org.dollhousemcp.memory-upgrade-drain': 'v2'}
    return {'Id': 'sha256:' + ('d' if role == 'runtime' else 'e') * 64, 'Os': 'linux', 'Architecture': architecture,
            'RootFS': {'Type': 'layers', 'Layers': ['sha256:' + 'f' * 64]},
            'Config': {'User': '1001:1001', 'WorkingDir': '/app', 'Entrypoint': None, 'Labels': labels,
                       'Cmd': ['node', '--trace-warnings', 'dist/index.js'] if role == 'runtime' else ['node', 'dist/cli/migrate-database.js'],
                       'Healthcheck': {'Test': ['CMD', '/nodejs/bin/node'] if role == 'runtime' else ['NONE']}}}


class ProfileTests(unittest.TestCase):
    def setUp(self):
        self.admission = subject.load_admission()
        self.runtime, self.migration = image('runtime'), image('migration')

    def check(self, source=SOURCE, daemon=DAEMON):
        return subject.check_profiles(self.admission, self.runtime, self.migration, daemon, source)

    def test_a_pair_the_host_would_admit_passes_and_reports_its_platform(self):
        self.assertEqual(self.check(), 'linux/amd64')

    def test_it_applies_the_admission_module_the_deployment_tooling_ships(self):
        self.assertEqual(Path(self.admission.__file__), ROOT / 'scripts/hosted-deploy/registry_image_admission.py')

    def test_images_built_from_another_commit_are_refused_even_when_they_agree(self):
        self.runtime, self.migration = image('runtime', 'd' * 40), image('migration', 'd' * 40)
        with self.assertRaisesRegex(subject.PairError, 'not the commit that was built'):
            self.check()

    def test_images_from_two_commits_are_refused(self):
        self.migration = image('migration', 'd' * 40)
        with self.assertRaisesRegex(subject.PairError, 'source labels differ'):
            self.check()

    def test_a_short_or_upper_case_expected_commit_is_refused(self):
        for source in ('c' * 12, 'C' * 40, ''):
            with self.assertRaisesRegex(subject.PairError, 'full 40-character commit'):
                self.check(source=source)

    def test_an_image_for_another_architecture_is_refused(self):
        with self.assertRaisesRegex(subject.PairError, 'runtime image: image platform does not match'):
            self.check(daemon={'OSType': 'linux', 'Architecture': 'aarch64'})

    def test_each_profile_fault_the_host_refuses_is_refused_here_and_names_the_role(self):
        def changed(role, edit):
            value = image(role)
            edit(value)
            return value
        faults = [
            ('runtime', lambda v: v['Config'].update(User='0:0')),
            ('runtime', lambda v: v['Config'].update(Entrypoint=['/bin/sh'])),
            ('runtime', lambda v: v['Config'].update(Cmd=['node', 'dist/index.js'])),
            ('runtime', lambda v: v['Config'].update(Healthcheck={'Test': ['CMD-SHELL', 'true']})),
            ('runtime', lambda v: v['Config']['Labels'].pop('org.dollhousemcp.memory-upgrade-drain')),
            ('migration', lambda v: v['Config'].update(Cmd=['node', '--trace-warnings', 'dist/index.js'])),
            ('migration', lambda v: v['Config'].update(Healthcheck={'Test': ['CMD', 'node']})),
            ('migration', lambda v: v['Config']['Labels'].pop('org.dollhousemcp.engine-proof-source')),
            ('migration', lambda v: v.update(RootFS={'Type': 'layers', 'Layers': []})),
        ]
        for role, edit in faults:
            self.runtime, self.migration = image('runtime'), image('migration')
            setattr(self, role, changed(role, edit))
            with self.assertRaisesRegex(subject.PairError, f'^{role} image: '):
                self.check()


class LocalPairTests(unittest.TestCase):
    def test_the_images_checked_are_fixed_names_per_architecture_not_arguments(self):
        self.assertEqual(subject.LOCAL_PAIR, {
            'amd64': ('hosted-pair/runtime:amd64', 'hosted-pair/migration:amd64'),
            'arm64': ('hosted-pair/runtime:arm64', 'hosted-pair/migration:arm64'),
        })

    def test_an_unknown_architecture_is_refused_before_any_docker_command(self):
        with self.assertRaises(SystemExit):
            subject.main(['--arch', 'riscv64', '--source', SOURCE])

    def test_the_workflow_builds_under_the_same_names(self):
        workflow = (ROOT / '.github/workflows/publish-hosted-images.yml').read_text()
        self.assertIn('--tag "hosted-pair/runtime:${ARCH}"', workflow)
        self.assertIn('--tag "hosted-pair/migration:${ARCH}"', workflow)
        self.assertIn('--arch "${ARCH}"', workflow)


class MigrationTests(unittest.TestCase):
    def setUp(self):
        self.runtime = {'manifest': copy.deepcopy(MIGRATIONS), 'journal': None}
        self.migration = {'manifest': copy.deepcopy(MIGRATIONS), 'journal': copy.deepcopy(MIGRATIONS)}

    def check(self):
        return subject.check_migrations(self.runtime, self.migration)

    def test_matching_lists_pass_and_report_how_many_migrations(self):
        self.assertEqual(self.check(), 2)

    def test_key_order_in_the_files_does_not_matter(self):
        self.migration['journal'] = [dict(reversed(list(entry.items()))) for entry in MIGRATIONS]
        self.assertEqual(self.check(), 2)

    def test_a_migration_image_without_a_journal_is_refused(self):
        for journal in (None, []):
            self.migration['journal'] = journal
            with self.assertRaisesRegex(subject.PairError, 'holds no migration journal'):
                self.check()

    def test_a_journal_entry_without_its_sql_file_is_refused_and_named(self):
        self.migration['journal'][1]['hash'] = None
        with self.assertRaisesRegex(subject.PairError, 'missing SQL for: 0001_second'):
            self.check()

    def test_a_runtime_image_without_the_release_list_is_refused(self):
        self.runtime['manifest'] = None
        with self.assertRaisesRegex(subject.PairError, 'runtime image holds no release migration list'):
            self.check()

    def test_images_with_different_release_lists_are_refused(self):
        self.migration['manifest'] = MIGRATIONS[:1]
        with self.assertRaisesRegex(subject.PairError, 'different release migration lists'):
            self.check()

    def test_a_migration_the_runtime_does_not_expect_is_refused(self):
        self.migration['journal'].append({'tag': '0002_third', 'when': 3000, 'hash': 'c' * 64})
        with self.assertRaisesRegex(subject.PairError, 'does not match the migrations the migration image applies'):
            self.check()

    def test_altered_sql_is_refused(self):
        self.migration['journal'][0]['hash'] = 'e' * 64
        with self.assertRaisesRegex(subject.PairError, 'does not match the migrations the migration image applies'):
            self.check()


if __name__ == '__main__':
    unittest.main()
