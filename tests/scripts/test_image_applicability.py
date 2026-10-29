"""Pure fixtures; no candidate image or Docker command is executed."""
import base64
import copy
from contextlib import redirect_stderr
from types import SimpleNamespace
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
from image_applicability import inventory_export, validate_never_started, preflight_tar
spec = importlib.util.spec_from_file_location('capture', Path(__file__).resolve().parents[2] / 'scripts/capture-image-applicability.py')
capture = importlib.util.module_from_spec(spec); spec.loader.exec_module(capture)
STORE = 'sha256:' + 'a' * 64
DESC = {'digest': STORE, 'mediaType': 'application/vnd.oci.image.manifest.v1+json', 'size': 123}
GRAPH = {'store_id': STORE, 'manifest_descriptor': DESC}
CID = 'c' * 64


class ToolFixture:
    def exists(self): return True
    def is_file(self): return True
    def stat(self): return SimpleNamespace(st_size=16, st_uid=0, st_mode=0o100755)
    def read_bytes(self): return b'trusted tool fixture'
    def resolve(self): return '/usr/bin/readelf'
    def __str__(self): return '/usr/bin/readelf'


def capture_path(value):
    return ToolFixture() if str(value) == '/usr/bin/readelf' else Path(value)


def state():
    return {'Id': CID, 'Image': STORE, 'ImageManifestDescriptor': DESC, 'RestartCount': 0,
            'State': {'Status': 'created', 'Running': False, 'Pid': 0, 'StartedAt': '0001-01-01T00:00:00Z'},
            'Config': {'Image': STORE, 'User': '65532:65532', 'Entrypoint': ['/bin/false'],
                       'Cmd': ['capture-not-executed'], 'Healthcheck': {'Test': ['NONE']},
                       'Env': ['CANARY=never-retain'], 'Volumes': None},
            'HostConfig': {'NetworkMode': 'none', 'ReadonlyRootfs': True, 'Privileged': False,
                           'CapDrop': ['ALL'], 'SecurityOpt': ['no-new-privileges=true']}, 'Mounts': []}


def bundle(path, entries):
    with tarfile.open(path, 'w', format=tarfile.PAX_FORMAT) as tar:
        for name, data, opts in entries:
            info = tarfile.TarInfo(name)
            for key, value in opts.items(): setattr(info, key, value)
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
    return path


def directory(name): return (name, b'', {'type': tarfile.DIRTYPE})


class InventoryTests(unittest.TestCase):
    def inventory(self, entries):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            result = inventory_export(bundle(root / 'export.tar', entries), root / 'scratch')
            # No target tree is extracted, even links/devices are data only.
            self.assertFalse((root / 'scratch/usr').exists())
            for p in (root / 'scratch').iterdir(): self.assertEqual(p.stat().st_mode & 0o777, 0o600)
            return result

    def test_complete_metadata_hashes_aliases_and_positive_caps_missing_is_unknown(self):
        cap = '\x01\x00\x00\x02' + '\x00' * 16
        entries = [directory('usr'), directory('usr/lib'),
                   ('usr/lib/payload', b'owned bytes', {'mode': 0o4755, 'uid': 0, 'gid': 0,
                    'pax_headers': {'SCHILY.xattr.security.capability': cap}}),
                   ('usr/lib/alias', b'', {'type': tarfile.LNKTYPE, 'linkname': 'usr/lib/payload'}),
                   ('usr/lib/symbolic', b'', {'type': tarfile.SYMTYPE, 'linkname': '/usr/lib/alias'}),
                   ('renamed', b'owned bytes', {}), ('packed', b'PK\x03\x04data', {})]
        result = self.inventory(entries); rows = {x['path']: x for x in result['entries']}
        self.assertEqual(rows['/usr/lib/payload']['mode'], 0o4755)
        self.assertEqual(base64.b64decode(rows['/usr/lib/payload']['capability_base64']).decode(), cap)
        self.assertIn('UNKNOWN', rows['/renamed']['capability_state'])
        self.assertEqual(rows['/renamed']['sha256'], rows['/usr/lib/payload']['sha256'])
        self.assertEqual(result['aliases'][-1]['sha256'], rows['/renamed']['sha256'])
        self.assertEqual(rows['/packed']['format'], 'zip-archive-candidate')
        self.assertTrue(any('Nested' in x for x in result['boundaries']))

    def test_named_perl_variants_and_package_status_are_selected_as_opaque_data(self):
        entries = [('var/lib/dpkg/status', b'Package: perl-base\n', {})]
        entries += [('opt/Pod/Text' + suffix, b'Perl data', {}) for suffix in ['.pm', '.pmc', '/Color.pm', '/Overstrike.pm', '/Termcap.pm']]
        entries += [('app/node_modules/Archive/Tar.pm', b'Perl data', {})]
        rows = self.inventory(entries)['entries']
        self.assertTrue(all(x.get('scratch_data') for x in rows))

    def test_alias_cycle_and_escape_are_unknown_not_absence(self):
        result = self.inventory([('one', b'', {'type': tarfile.SYMTYPE, 'linkname': 'two'}),
                                 ('two', b'', {'type': tarfile.SYMTYPE, 'linkname': 'one'}),
                                 ('escape', b'', {'type': tarfile.SYMTYPE, 'linkname': '../../host'})])
        self.assertTrue(all(x['status'] == 'UNKNOWN' for x in result['aliases']))

    def test_unsafe_duplicate_whiteout_and_unsupported_entries_refuse(self):
        for entries in [[('../host', b'x', {})], [('/absolute', b'x', {})], [('a//b', b'x', {})],
                        [('same', b'a', {}), ('same', b'b', {})], [('.wh.old', b'', {})],
                        [('d/.wh..wh..opq', b'', {})], [('unsupported', b'', {'type': b'Z'})]]:
            with self.subTest(entries=entries), self.assertRaises((ValueError, tarfile.TarError)):
                self.inventory(entries)

    def test_merged_export_fixture_does_not_include_whiteouted_parent_paths(self):
        # Docker, not this parser, materializes normal/opaque whiteouts. A merged
        # fixture has only final paths. Unexpected layer whiteouts refuse above.
        result = self.inventory([directory('opt'), ('opt/new', b'new', {})])
        self.assertEqual([x['path'] for x in result['entries']], ['/opt', '/opt/new'])
        self.assertNotIn('/opt/removed-lower-layer', [x['path'] for x in result['entries']])

    def test_extended_metadata_truncation_and_deadline_fail_closed(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d); p = bundle(root / 'archive', [('large-metadata', b'', {'pax_headers': {'comment': 'x' * 70000}})])
            with self.assertRaisesRegex(ValueError, 'Extended'): preflight_tar(p, lambda: None)
            p.write_bytes(b'broken')
            with self.assertRaises(ValueError): inventory_export(p, root / 'scratch')
            p = bundle(root / 'valid', [('file', b'x', {})])
            with self.assertRaisesRegex(ValueError, 'deadline'): inventory_export(p, root / 'other', deadline=0.01)

    def test_selected_object_and_entry_limits_refuse_before_claim(self):
        with patch('image_applicability.MAX_OBJECT', 2):
            with self.assertRaisesRegex(ValueError, 'scratch'): self.inventory([('Pod/Text.pm', b'abc', {})])
        with patch('image_applicability.MAX_REPORT', 1):
            with self.assertRaisesRegex(ValueError, 'report'): self.inventory([('file', b'x', {})])


class ElfCoverageTests(unittest.TestCase):
    def phase(self, count, fail=None):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d); data = root/'opaque.data'; data.write_bytes(b'\x7fELFdata')
            digest = hashlib.sha256(data.read_bytes()).hexdigest()
            rows = [{'path': '/native-' + str(n), 'sha256': digest, 'scratch_data': str(data)} for n in range(count)]
            self.reports = {}; self.calls = []; clock = [100.0]
            def write(name, value): self.reports[name] = copy.deepcopy(value)
            def run(cmd, label, timeout=30, maximum=1024*1024):
                self.calls.append((cmd, label, timeout, maximum))
                if label.startswith('elf-'):
                    self.assertLessEqual(timeout, 5)
                    self.assertEqual(maximum, 8 * 1024 ** 2)
                    if label == 'elf-0' and fail == 'deadline': clock[0] += 60
                    if label == 'elf-1' and fail == 'output': raise ValueError('Capture raw report budget exhausted')
                    if label == 'elf-1' and fail == 'parser': return None, b''
                return 0, b'trusted mock output'
            with patch.object(capture, 'Path', side_effect=capture_path), patch.object(capture.time, 'monotonic', side_effect=lambda: clock[0]):
                return capture.capture_elf_facts(rows, root, run, write, 240.0)

    def test_observed_663_objects_are_admitted_with_unchanged_child_and_phase_bounds(self):
        result = self.phase(663)
        self.assertEqual(result['processed_count'], 663)
        self.assertEqual(result['unknown_count'], 0)
        self.assertEqual(len(self.calls), 665)  # Two trusted metadata calls.
        self.assertEqual(result['limits'], {'object_count': 1024, 'seconds': 60, 'child_seconds': 5,
                                           'child_output_bytes': 8*1024**2})
        self.assertIn('(536870912,536870912)', capture.READELF_LAUNCHER)
        self.assertIn('(5,5)', capture.READELF_LAUNCHER)
        self.assertTrue(all(cmd[0] == '/usr/bin/python3' for cmd, *_ in self.calls))
        self.assertEqual(self.phase(1024)['processed_count'], 1024)

    def test_over_count_keeps_bounded_ledger_and_every_omitted_object_unknown(self):
        with self.assertRaisesRegex(ValueError, '1024 bound'): self.phase(1025)
        index = self.reports['elf-index.json']
        self.assertEqual(len(index['objects']), 1024)
        self.assertEqual(index['overlimit_unknown_count'], 1)
        self.assertEqual(index['unknown_count'], 1025)
        self.assertEqual(self.calls, [])

    def test_phase_deadline_retains_completed_and_unprocessed_unknown(self):
        with self.assertRaisesRegex(ValueError, 'deadline'): self.phase(3, 'deadline')
        index = self.reports['elf-index.json']
        self.assertEqual(index['processed_count'], 1)
        self.assertEqual(index['unknown_count'], 2)
        self.assertEqual(index['objects'][0]['status'], 'parsed-data')
        self.assertTrue(all('UNKNOWN' in row['status'] for row in index['objects'][1:]))

    def test_aggregate_output_exception_and_child_parser_failure_remain_nonclean(self):
        for failure in ['output', 'parser']:
            with self.subTest(failure=failure), self.assertRaises(ValueError): self.phase(3, failure)
            index = self.reports['elf-index.json']
            self.assertEqual(index['phase_status'], 'UNKNOWN-not-completed')
            self.assertEqual(index['unknown_count'], 2 if failure == 'output' else 1)
            self.assertEqual(index['objects'][0]['status'], 'parsed-data')
            self.assertIn('UNKNOWN', index['objects'][1]['status'])


class ContainerTests(unittest.TestCase):
    def test_exact_created_container_roles_and_all_active_or_mounted_variants_refuse(self):
        self.assertEqual(validate_never_started(state(), GRAPH)['pid'], 0)
        changes = [lambda x: x.update(Image='sha256:' + 'b' * 64),
                   lambda x: x['Config'].update(Image='mutable:tag'),
                   lambda x: x['ImageManifestDescriptor'].update(size=1),
                   lambda x: x['State'].update(Status='running'), lambda x: x['State'].update(Pid=12),
                   lambda x: x['State'].update(Running=True), lambda x: x['State'].update(StartedAt='2026-10-29'),
                   lambda x: x['Config'].update(Volumes={'/data': {}}), lambda x: x.update(Mounts=[{'Source': '/host'}]),
                   lambda x: x['HostConfig'].update(Binds=['/host:/data']),
                   lambda x: x['HostConfig'].update(NetworkMode='bridge'),
                   lambda x: x['Config'].update(Entrypoint=['/target/node']),
                   lambda x: x['Config'].update(Healthcheck={'Test': ['CMD', '/target/probe']})]
        for mutate in changes:
            value = copy.deepcopy(state()); mutate(value)
            with self.subTest(value=value), self.assertRaises(ValueError): validate_never_started(value, GRAPH)

    def test_orchestrator_exact_cleanup_on_export_failure_and_no_env_or_target_command(self):
        for scenario in ['ok', 'create-failure-with-id', 'create-timeout-lost-id', 'create-malformed-id', 'receipt-persist-failure', 'missing-late-create', 'foreign-owner', 'foreign-name', 'foreign-container-source', 'conflicting-create-id', 'export-failure', 'wrong-engine', 'wrong-source', 'declared-volume', 'running', 'bad-export', 'cleanup-failure', 'elf-parser-failure', 'elf-count-bound', 'elf-output-bound']:
            with tempfile.TemporaryDirectory() as d:
                root = Path(d); (root / 'reports').mkdir(); (root / 'inputs').mkdir()
                (root / 'inputs/image.tar').write_bytes(b'verified archive fixture')
                (root / 'reports/target-archive-identity.json').write_text(json.dumps(GRAPH))
                (root / 'reports/application-image-vulnerabilities.json').write_bytes(b'raw findings sentinel')
                export_entries = [('var/lib/dpkg/status', b'Package: fixture\n', {})]
                if scenario in ['elf-parser-failure', 'elf-count-bound', 'elf-output-bound']:
                    export_entries += [('native' + str(n) + '.node', b'\x7fELFfixture' + bytes([n]), {})
                                       for n in range(3 if scenario == 'elf-count-bound' else 1)]
                    export_entries += [('packed', b'PK\x03\x04unknown nested data', {}),
                                       ('status-alias', b'', {'type': tarfile.SYMTYPE, 'linkname': 'var/lib/dpkg/status'})]
                exported = bundle(root / 'fixture.tar', export_entries).read_bytes()
                if scenario == 'bad-export': exported = b'malformed tar'

                commands = []; owner = {}
                real_write = Path.write_bytes
                def write_bytes(path, data):
                    if scenario == 'receipt-persist-failure' and path.name == 'container-create.stdout':
                        raise OSError('simulated create receipt persistence failure')
                    return real_write(path, data)
                def process(cmd, timeout, maximum=0, stdout_path=None, stderr_maximum=None):
                    commands.append(cmd)
                    if cmd[:2] == ['docker', 'version']:
                        return 0, json.dumps({'Version': '29.4.2', 'GitCommit': 'unreviewed' if scenario == 'wrong-engine' else 'd329809', 'Os': 'linux', 'Arch': 'amd64'}).encode(), b'', None
                    if cmd[:3] == ['docker', 'image', 'inspect']:
                        value = {'Id': STORE, 'Descriptor': DESC, 'Architecture': 'amd64', 'Os': 'linux',
                                 'Config': {'Env': ['CANARY=never-retain'], 'User': '1001', 'Labels': {'org.dollhousemcp.engine-proof-source': ('f' if scenario == 'wrong-source' else 'e') * 40}, 'Volumes': {'/data': {}} if scenario == 'declared-volume' else None}}
                        return 0, json.dumps([value]).encode(), b'', None
                    if cmd[:2] == ['docker', 'create']:
                        owner['name'] = cmd[cmd.index('--name')+1]
                        owner['nonce'] = cmd[cmd.index('--label')+1].split('=',1)[1]
                        if scenario in ['create-timeout-lost-id', 'missing-late-create']: return None, b'', b'timeout', 'deadline'
                        if scenario == 'create-malformed-id': return 0, b'malformed', b'', None
                        if scenario == 'conflicting-create-id': return 0, ('d'*64).encode(), b'', None
                        return (1 if scenario == 'create-failure-with-id' else 0), CID.encode(), b'', None
                    if cmd[:2] == ['docker', 'inspect']:
                        if scenario == 'missing-late-create': return 1, b'', b'No such object', None
                        value = copy.deepcopy(state()); value['Name'] = '/' + owner['name']
                        value['Config']['Labels'] = {'org.dollhousemcp.applicability-owner': owner['nonce'],
                            'org.dollhousemcp.engine-proof-source': 'e'*40}
                        if scenario == 'foreign-owner': value['Config']['Labels']['org.dollhousemcp.applicability-owner'] = 'foreign'
                        if scenario == 'foreign-name': value['Name'] = '/foreign'
                        if scenario == 'foreign-container-source': value['Config']['Labels']['org.dollhousemcp.engine-proof-source'] = 'foreign'
                        if scenario == 'running': value['State']['Running'] = True
                        return 0, json.dumps([value]).encode(), b'', None
                    if cmd[:2] == ['docker', 'export']:
                        stdout_path.write_bytes(exported)
                        return (1 if scenario == 'export-failure' else 0), b'', b'', None
                    if cmd[:2] == ['docker', 'rm']: return (1 if scenario == 'cleanup-failure' else 0), CID.encode(), b'', None
                    if cmd[0] == '/usr/bin/python3':
                        output = b'x'*(2*1024**2) if scenario == 'elf-output-bound' and '--file-header' in cmd else b'trusted readelf fixture output'
                        return (1 if scenario == 'elf-parser-failure' and '--file-header' in cmd else 0), output, b'', None
                    raise AssertionError(cmd)
                with patch.object(capture.scanner, 'bounded_process', process), patch.object(capture, 'verify_saved_image', return_value=GRAPH), patch.object(sys, 'argv', ['capture', str(root)]), patch.dict(capture.os.environ, {'GITHUB_SHA': 'e' * 40}), patch.object(capture, 'Path', side_effect=capture_path), patch.object(Path, 'write_bytes', write_bytes), patch.object(capture, 'MAX_ELF_OBJECTS', 2 if scenario == 'elf-count-bound' else 1024), patch.object(capture, 'MAX_REPORT', 2*1024**2 if scenario == 'elf-output-bound' else 32*1024**2):
                    self.assertEqual(capture.main(), 0 if scenario == 'ok' else 1)
                self.assertEqual([x for x in commands if x[:2] == ['docker', 'rm']], [] if scenario in ['wrong-engine', 'wrong-source', 'declared-volume', 'running', 'missing-late-create', 'foreign-owner', 'foreign-name', 'foreign-container-source', 'conflicting-create-id'] else [['docker', 'rm', '--volumes', CID]])
                self.assertFalse(any(x[:2] in [['docker', 'start'], ['docker', 'run'], ['docker', 'exec']] for x in commands))
                report_bytes = b''.join(p.read_bytes() for p in (root / 'reports/applicability').iterdir())
                self.assertNotIn(b'CANARY', report_bytes)
                self.assertNotIn(b'never-retain', report_bytes)
                self.assertIn(b'"finding_closure": false', report_bytes)
                self.assertEqual((root / 'reports/application-image-vulnerabilities.json').read_bytes(), b'raw findings sentinel')
                if scenario in ['create-timeout-lost-id', 'create-malformed-id', 'receipt-persist-failure']:
                    self.assertEqual(json.loads((root/'reports/applicability/container-cleanup.json').read_text())['status'], 'verified-owned-container-removed')
                if scenario in ['missing-late-create', 'foreign-owner', 'foreign-name', 'foreign-container-source', 'conflicting-create-id', 'running']:
                    self.assertEqual(json.loads((root/'reports/applicability/container-cleanup.json').read_text())['status'], 'UNKNOWN')
                if scenario in ['elf-parser-failure', 'elf-count-bound', 'elf-output-bound']:
                    index = json.loads((root/'reports/applicability/elf-index.json').read_text())
                    self.assertGreater(index['unknown_count'], 0)
                    self.assertIn('UNKNOWN', index['phase_status'])
                    reports = root/'reports/applicability'
                    self.assertEqual(list(reports.glob('data-*.raw'))[0].read_bytes(), b'Package: fixture\n')
                    self.assertEqual(len(json.loads((reports/'unresolved-archive-locations.json').read_text())['archives']), 1)
                    self.assertEqual(len(json.loads((reports/'predicate-surfaces.json').read_text())['aliases']), 1)
                    self.assertEqual(json.loads((reports/'capture-summary.json').read_text())['status'], 'incomplete')
                    if scenario == 'elf-count-bound':
                        self.assertEqual(index['overlimit_unknown_count'], 1)
                        self.assertEqual(index['processed_count'], 0)
                        self.assertFalse(any(cmd[0] == '/usr/bin/python3' for cmd in commands))


    def test_terminal_summary_disk_failure_emits_bounded_nonclean_state(self):
        output = io.StringIO()
        summary = {'schema': 'image-applicability-capture-v1', 'status': 'incomplete',
                   'cleanup': {'status': 'UNKNOWN', 'owned_name': 'exact-owned', 'removal_invoked': False,
                               'reason': 'late/missing create'}, 'receipts': {}}
        with patch.object(Path, 'write_text', side_effect=OSError('disk full')), redirect_stderr(output):
            with self.assertRaises(RuntimeError): capture.persist_terminal_summary(Path('/unused'), summary)
        result = json.loads(output.getvalue())
        self.assertEqual(result['status'], 'incomplete-summary-persistence')
        self.assertEqual(result['cleanup']['status'], 'UNKNOWN')
        self.assertFalse(result['finding_closure'])
        self.assertLess(len(output.getvalue()), 4096)

    def test_streamed_export_stderr_is_separately_bounded(self):
        with tempfile.TemporaryDirectory() as d:
            status, stdout, stderr, error = capture.scanner.bounded_process(
                ['/usr/bin/python3', '-c', 'import sys;sys.stderr.write("x"*10000)'], 5,
                maximum=1024*1024, stdout_path=Path(d)/'stream', stderr_maximum=100)
            self.assertIsNone(status)
            self.assertIn('stderr', error)
            self.assertLessEqual(len(stderr), 100)

    def test_trusted_existing_readelf_only_parses_nonexecutable_fixture_data(self):
        if not Path('/usr/bin/readelf').exists(): self.skipTest('Trusted host readelf unavailable')
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / 'opaque.data'; path.write_bytes(Path('/usr/bin/true').read_bytes()); path.chmod(0o600)
            r = subprocess.run(['/usr/bin/python3', '-I', '-c', capture.READELF_LAUNCHER, d,
                                '--file-header', '--dynamic', '--notes', '--dyn-syms', '--wide', '--no-demangle', '--debug-dump=no-follow-links', '--debug-dump=do-not-use-debuginfod', str(path)],
                               capture_output=True, timeout=5)
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertIn(b'ELF Header', r.stdout)
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertNotIn('ldd', capture.READELF_LAUNCHER)


if __name__ == '__main__': unittest.main()
