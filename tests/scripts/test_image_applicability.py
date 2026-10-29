"""Pure fixtures; no candidate image or Docker command is executed."""
import base64
import copy
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
        for scenario in ['ok', 'create-failure-with-id', 'export-failure', 'wrong-engine', 'wrong-source', 'declared-volume', 'running', 'bad-export', 'cleanup-failure', 'elf-parser-failure']:
            with tempfile.TemporaryDirectory() as d:
                root = Path(d); (root / 'reports').mkdir(); (root / 'inputs').mkdir()
                (root / 'inputs/image.tar').write_bytes(b'verified archive fixture')
                (root / 'reports/target-archive-identity.json').write_text(json.dumps(GRAPH))
                (root / 'reports/application-image-vulnerabilities.json').write_bytes(b'raw findings sentinel')
                export_entries = [('var/lib/dpkg/status', b'Package: fixture\n', {})]
                if scenario == 'elf-parser-failure': export_entries.append(('native.node', b'\x7fELFfixture', {}))
                exported = bundle(root / 'fixture.tar', export_entries).read_bytes()
                if scenario == 'bad-export': exported = b'malformed tar'

                commands = []
                def process(cmd, timeout, maximum=0, stdout_path=None, stderr_maximum=None):
                    commands.append(cmd)
                    if cmd[:2] == ['docker', 'version']:
                        return 0, json.dumps({'Version': '29.4.2', 'GitCommit': 'unreviewed' if scenario == 'wrong-engine' else 'd329809', 'Os': 'linux', 'Arch': 'amd64'}).encode(), b'', None
                    if cmd[:3] == ['docker', 'image', 'inspect']:
                        value = {'Id': STORE, 'Descriptor': DESC, 'Architecture': 'amd64', 'Os': 'linux',
                                 'Config': {'Env': ['CANARY=never-retain'], 'User': '1001', 'Labels': {'org.dollhousemcp.engine-proof-source': ('f' if scenario == 'wrong-source' else 'e') * 40}, 'Volumes': {'/data': {}} if scenario == 'declared-volume' else None}}
                        return 0, json.dumps([value]).encode(), b'', None
                    if cmd[:2] == ['docker', 'create']: return (1 if scenario == 'create-failure-with-id' else 0), CID.encode(), b'', None
                    if cmd[:2] == ['docker', 'inspect']:
                        value = copy.deepcopy(state())
                        if scenario == 'running': value['State']['Running'] = True
                        return 0, json.dumps([value]).encode(), b'', None
                    if cmd[:2] == ['docker', 'export']:
                        stdout_path.write_bytes(exported)
                        return (1 if scenario == 'export-failure' else 0), b'', b'', None
                    if cmd[:2] == ['docker', 'rm']: return (1 if scenario == 'cleanup-failure' else 0), CID.encode(), b'', None
                    if cmd[0] == '/usr/bin/python3': return (1 if scenario == 'elf-parser-failure' and '--file-header' in cmd else 0), b'trusted readelf fixture output', b'', None
                    raise AssertionError(cmd)
                with patch.object(capture.scanner, 'bounded_process', process), patch.object(capture, 'verify_saved_image', return_value=GRAPH), patch.object(sys, 'argv', ['capture', str(root)]), patch.dict(capture.os.environ, {'GITHUB_SHA': 'e' * 40}):
                    self.assertEqual(capture.main(), 0 if scenario in ['ok', 'elf-parser-failure'] else 1)
                self.assertEqual([x for x in commands if x[:2] == ['docker', 'rm']], [] if scenario in ['wrong-engine', 'wrong-source', 'declared-volume'] else [['docker', 'rm', '--volumes', CID]])
                self.assertFalse(any(x[:2] in [['docker', 'start'], ['docker', 'run'], ['docker', 'exec']] for x in commands))
                report_bytes = b''.join(p.read_bytes() for p in (root / 'reports/applicability').iterdir())
                self.assertNotIn(b'CANARY', report_bytes)
                self.assertNotIn(b'never-retain', report_bytes)
                self.assertIn(b'"finding_closure": false', report_bytes)
                self.assertEqual((root / 'reports/application-image-vulnerabilities.json').read_bytes(), b'raw findings sentinel')
                if scenario == 'elf-parser-failure':
                    self.assertIn('UNKNOWN', (root/'reports/applicability/elf-index.json').read_text())


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
