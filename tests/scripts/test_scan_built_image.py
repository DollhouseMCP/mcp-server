"""No network/execution: checksum and hostile archive extraction boundaries."""
import hashlib
import datetime
import json
import copy
import importlib.util
import io
import os
import subprocess
from pathlib import Path
import tarfile
import tempfile
import time
import unittest
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))

spec = importlib.util.spec_from_file_location(
    "scan_built_image", Path(__file__).resolve().parents[2] / "scripts/scan-built-image.py")
import image_scan_intake as intake
scanner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scanner)


class ExtractVerifiedBinaryTests(unittest.TestCase):
    def archive(self, root, entries):
        archive = root / "release.tar.gz"
        with tarfile.open(archive, "w:gz") as bundle:
            for name, kind in entries:
                member = tarfile.TarInfo(name)
                member.type = kind
                member.linkname = "outside"
                data = b"fixture binary; never executed"
                if kind == tarfile.REGTYPE:
                    member.size = len(data)
                    bundle.addfile(member, io.BytesIO(data))
                else:
                    bundle.addfile(member)
        return archive, hashlib.sha256(archive.read_bytes()).hexdigest()

    def test_exact_regular_binary_only_other_paths_are_never_extracted(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive, checksum = self.archive(root, [("grype", tarfile.REGTYPE),
                                                   ("../escape", tarfile.REGTYPE)])
            scanner.extract_verified_binary(archive, root / "verified", checksum)
            self.assertEqual((root / "verified").read_bytes(), b"fixture binary; never executed")
            self.assertEqual(sorted(p.name for p in root.iterdir()), ["release.tar.gz", "verified"])

    def test_wrong_checksum_refuses_before_any_extraction(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive, _ = self.archive(root, [("grype", tarfile.REGTYPE)])
            with self.assertRaisesRegex(ValueError, "SHA256"):
                scanner.extract_verified_binary(archive, root / "verified", "0" * 64)
            self.assertFalse((root / "verified").exists())

    def test_symlinks_hardlinks_directories_and_duplicate_binaries_refuse(self):
        cases = [[("grype", kind)] for kind in [tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.DIRTYPE]]
        cases += [[("grype", tarfile.REGTYPE), ("grype", tarfile.REGTYPE)]]
        for entries in cases:
            with self.subTest(entries=entries), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                archive, checksum = self.archive(root, entries)
                with self.assertRaisesRegex(ValueError, "exactly one regular"):
                    scanner.extract_verified_binary(archive, root / "verified", checksum)
                self.assertFalse((root / "verified").exists())


class FrozenInputTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve() / 'image-security'; self.root.mkdir()
        for name in ('admitted', 'inputs', 'reports'): (self.root / name).mkdir(mode=0o700)
        self.binary = b'inert binary'
        archive = self.root / 'admitted' / scanner.ARCHIVE_NAME
        with tarfile.open(archive, 'w:gz') as bundle:
            item = tarfile.TarInfo('grype'); item.size = len(self.binary)
            bundle.addfile(item, io.BytesIO(self.binary))
        self.archive_hash = hashlib.sha256(archive.read_bytes()).hexdigest()
        self.db = b'inert database archive'
        (self.root / 'admitted' / scanner.DATABASE_ARCHIVE).write_bytes(self.db)
        self.manifest = {'status': 'active', 'schemaVersion': 'v6.1.10',
            'built': datetime.datetime.now(datetime.timezone.utc).isoformat(),
            'path': 'vulnerability-db_v6.1.10_fixture.tar.zst',
            'checksum': 'sha256:' + hashlib.sha256(self.db).hexdigest()}
        self.write_manifest(json.dumps(self.manifest).encode())
        self.hashes = {'manifest': self.manifest_hash, 'binary': hashlib.sha256(self.binary).hexdigest()}

    def write_manifest(self, content):
        (self.root / 'admitted' / 'database-manifest.json').write_bytes(content)
        self.manifest_hash = hashlib.sha256(content).hexdigest()

    def prepare(self):
        from unittest.mock import patch
        with patch.object(scanner, 'ARCHIVE_SHA256', self.archive_hash), patch.object(scanner, 'download', side_effect=AssertionError('network forbidden')):
            return scanner.prepare_frozen_inputs(self.root, self.hashes, time.monotonic() + 30)

    def test_fixed_files_copy_and_binary_identity(self):
        binary, manifest, database = self.prepare()
        self.assertEqual((self.root / 'inputs' / 'grype').read_bytes(), self.binary)
        self.assertEqual((self.root / 'inputs' / 'grype').stat().st_mode & 0o777, 0o555)
        self.assertEqual(manifest, self.manifest)
        self.assertEqual(database['sha256'], hashlib.sha256(self.db).hexdigest())
        self.assertEqual(binary['origin'], 'frozen-admitted')
        self.assertEqual(binary['binary_sha256'], self.hashes['binary'])
        self.assertEqual(binary['binary_bytes'], len(self.binary))
        self.assertIsNone(binary['url'])
        self.assertEqual(database['url'], 'https://grype.anchore.io/databases/v6/' + self.manifest['path'])
        scanner.verify_frozen_mounts(self.root, self.hashes, database['sha256'], time.monotonic()+30)
        (self.root / 'inputs' / scanner.DATABASE_ARCHIVE).write_bytes(b'changed')
        deadline = time.monotonic()+30
        with self.assertRaisesRegex(ValueError, 'mounted input changed'):
            scanner.verify_frozen_mounts(self.root, self.hashes, database['sha256'], deadline)

    def test_invalid_flags_refuse_before_output_preparation(self):
        complete = ['x'] * 10; complete[8] = 1
        self.assertIsNone(scanner.validate_frozen_arguments(None, None, complete))
        for a, b, retained in [('', 'a'*64, complete), ('a'*64, None, complete),
                               ('z'*64, 'b'*64, complete), ('a'*64, 'b'*64, [None]*10)]:
            with self.subTest(a=a, b=b), self.assertRaises(ValueError):
                scanner.validate_frozen_arguments(a, b, retained)

    def test_wrong_binary_hash_refuses_before_chmod(self):
        self.hashes['binary'] = '0' * 64
        with self.assertRaisesRegex(ValueError, 'binary SHA256'): self.prepare()
        self.assertEqual((self.root / 'inputs' / 'grype').stat().st_mode & 0o777, 0o600)

    def test_duplicate_stale_or_wrong_manifest_refuses(self):
        for content in (b'{"status":"active","status":"active"}',
                        json.dumps({**self.manifest, 'built': '2020-01-01T00:00:00Z'}).encode()):
            with self.subTest(content=content):
                for path in (self.root / 'inputs').iterdir(): path.unlink()
                for path in (self.root / 'reports').iterdir(): path.unlink()
                self.write_manifest(content); self.hashes['manifest'] = self.manifest_hash
                with self.assertRaises(ValueError): self.prepare()
        self.hashes['manifest'] = '0' * 64
        for path in (self.root / 'inputs').iterdir(): path.unlink()
        for path in (self.root / 'reports').iterdir(): path.unlink()
        with self.assertRaises(ValueError): self.prepare()

    def test_symlink_wrong_database_and_expired_deadline_refuse(self):
        archive = self.root / 'admitted' / scanner.ARCHIVE_NAME
        archive.unlink(); archive.symlink_to(self.root / 'admitted' / scanner.DATABASE_ARCHIVE)
        with self.assertRaises(ValueError): self.prepare()
        deadline = time.monotonic() - 1
        with self.assertRaisesRegex(ValueError, 'deadline'):
            scanner.frozen_copy(self.root, scanner.DATABASE_ARCHIVE, scanner.GIB, '0'*64, 'inputs', scanner.DATABASE_ARCHIVE, deadline)

    def test_main_rejects_partial_frozen_flags_before_output(self):
        from unittest.mock import patch
        with patch.object(sys, 'argv', ['scanner', '/unused', '--frozen-db-manifest-sha256', 'a'*64]), patch.object(scanner, 'trusted_work_root', side_effect=AssertionError('output preparation reached')):
            with self.assertRaisesRegex(ValueError, 'both SHA256'):
                scanner.main()

    def test_bad_database_hash_and_missing_inputs_refuse(self):
        (self.root / 'admitted' / scanner.DATABASE_ARCHIVE).write_bytes(b'wrong database')
        with self.assertRaisesRegex(ValueError, 'SHA256 mismatch'): self.prepare()
        for path in (self.root / 'inputs').iterdir(): path.unlink()
        for path in (self.root / 'reports').iterdir(): path.unlink()
        (self.root / 'admitted' / 'database-manifest.json').unlink()
        with self.assertRaises(FileNotFoundError): self.prepare()

    def test_symlinked_admitted_directory_refuses(self):
        admitted = self.root / 'admitted'; original = self.root / 'moved'
        admitted.rename(original); admitted.symlink_to(original, target_is_directory=True)
        with self.assertRaises(ValueError): self.prepare()

    def test_common_preparation_accepts_local_runner_without_network(self):
        from unittest.mock import patch, Mock
        config = self.root / 'config'; config.write_text('config')
        runner_file = self.root / 'runner'; runner_file.write_text('runner')
        run = Mock(return_value=(0, b'')); inspect = Mock(return_value={'id': 'local'}); save = Mock(return_value={'graph': True})
        with patch.object(scanner, 'ARCHIVE_SHA256', self.archive_hash), patch.object(scanner, 'database_payload_bytes', return_value=1), patch.object(scanner, 'download', side_effect=AssertionError('network forbidden')), patch.object(scanner, 'verify_fixed_runner', return_value={'runner': 'verified'}):
            payload, binary, manifest, database, runner = scanner.prepare_offline_inputs(self.root/'inputs', self.root/'reports', config, runner_file, runner_file, run, inspect, save, time.monotonic()+30, frozen=self.hashes)
        self.assertEqual(payload, 1); self.assertEqual(binary['binary_sha256'], self.hashes['binary'])
        self.assertEqual(database['origin'], 'frozen-admitted'); self.assertEqual(manifest, self.manifest)
        self.assertEqual(runner, {'runner': 'verified'})
        inspect.assert_called_once_with(scanner.RUNNER_REF, 'runner-inspect')
        save.assert_called_once_with(scanner.RUNNER_REF, {'id': 'local'}, 'runner')
        self.assertEqual(run.call_count, 1)
        self.assertEqual(run.call_args.args[0], ['/usr/bin/zstd', '--version'])

    def test_missing_runner_never_pulls(self):
        from unittest.mock import patch, Mock
        config = self.root / 'config'; config.write_text('config')
        runner = self.root / 'runner'; runner.write_text('runner')
        run = Mock(return_value=(0, b'')); inspect = Mock(return_value=None); save = Mock()
        fake = ({'origin':'frozen-admitted'}, self.manifest, {'origin':'frozen-admitted'})
        inputs = self.root/'inputs'; reports = self.root/'reports'; deadline = time.monotonic()+30
        with patch.object(scanner, 'prepare_frozen_inputs', return_value=fake), patch.object(scanner, 'database_payload_bytes', return_value=1), patch.object(scanner, 'download', side_effect=AssertionError('network forbidden')):
            with self.assertRaisesRegex(ValueError, 'runner reference'):
                scanner.prepare_offline_inputs(inputs, reports, config, runner, runner, run, inspect, save, deadline, frozen=self.hashes)
        self.assertEqual(run.call_count, 1)
        self.assertEqual(run.call_args.args[0], ['/usr/bin/zstd', '--version'])
        save.assert_not_called()


class ScannerEnvironmentTests(unittest.TestCase):
    def test_inherited_cataloger_exclusion_distro_and_database_controls_are_stripped(self):
        inherited = {
            "PATH": "/runner/existing/path", "DOCKER_CONFIG": "/runner/normal-docker-auth",
            "GRYPE_EXCLUDE": "**/node_modules/**", "GRYPE_DISTRO": "alpine:0.1",
            "GRYPE_DB_UPDATE_URL": "https://other.example/databases",
            "GRYPE_DB_VALIDATE_AGE": "false", "GRYPE_VEX_DOCUMENTS": "unreviewed.json",
            "SYFT_EXCLUDE": "**/*", "SYFT_SOURCE_NAME": "unreviewed-source",
        }
        actual = scanner.scanner_environment(inherited, Path("/owned/scanner"))
        self.assertNotIn("GRYPE_EXCLUDE", actual)
        self.assertNotIn("GRYPE_DISTRO", actual)
        self.assertNotIn("GRYPE_VEX_DOCUMENTS", actual)
        self.assertFalse(any(key.startswith("SYFT_") for key in actual))
        self.assertEqual(actual["GRYPE_DB_UPDATE_URL"], "https://grype.anchore.io/databases")
        self.assertEqual(actual["GRYPE_DB_VALIDATE_AGE"], "true")
        self.assertEqual(actual["GRYPE_DB_CACHE_DIR"], "/owned/scanner/db")
        self.assertEqual(actual["PATH"], inherited["PATH"])
        self.assertEqual(actual["DOCKER_CONFIG"], inherited["DOCKER_CONFIG"])
        self.assertEqual(inherited["GRYPE_DB_VALIDATE_AGE"], "false")


class OfflineBoundaryTests(unittest.TestCase):
    def test_source_owned_inputs_are_resolved_from_script_checkout(self):
        root, config, runner, reference = scanner.scanner_source_paths()
        self.assertEqual(root, Path(scanner.__file__).resolve().parent.parent)
        self.assertEqual(config, root / '.github/grype-image-scan.yaml')
        self.assertEqual(runner, root / 'scripts/grype-offline-runner.mjs')
        self.assertEqual(reference, root / '.github/grype-runner-reference')
        self.assertTrue(all(p.is_absolute() for p in (root, config, runner, reference)))

    def test_malicious_caller_directory_cannot_supply_scanner_source_inputs(self):
        original = os.getcwd()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); (root / '.github/grype-runner-reference').mkdir(parents=True); (root / 'scripts').mkdir()
            for path in (root / '.github/grype-image-scan.yaml', root / 'scripts/grype-offline-runner.mjs', root / '.github/grype-runner-reference/index.json'):
                path.write_text('malicious cwd fixture')
            try:
                os.chdir(root)
                source, config, runner, reference = scanner.scanner_source_paths()
                for path in (config, runner, reference / 'index.json'):
                    self.assertNotEqual(path.read_text(), 'malicious cwd fixture')
                    self.assertTrue(path.is_relative_to(source))
            finally:
                os.chdir(original)

    def test_retained_target_selection_uses_admitted_record(self):
        from types import SimpleNamespace
        from unittest.mock import patch
        args = SimpleNamespace(caddy=False, retained_intake='doc', intake_sha256='digest', retained_archive='archive', scanner_head='head', scanner_tree='tree')
        record = {'store_id': 'sha256:' + 'a' * 64, 'platform': 'linux/arm64', 'descriptor': {'digest': 'root'}}
        with patch.object(scanner, 'validate_intake', return_value=(record, {'fixture': True})):
            retained, target, image_id, descriptor = scanner.select_scanner_target([True], args, Path('/source'), {}, lambda *_: None)
        self.assertTrue(retained)
        self.assertEqual(target, {'store_id': record['store_id'], 'architecture': 'arm64', 'os': 'linux'})
        self.assertEqual(image_id, record['store_id'])
        self.assertEqual(descriptor, record['descriptor'])

    def test_final_target_verification_preserves_root_descriptor_for_child_store(self):
        from types import SimpleNamespace
        from unittest.mock import patch
        from test_image_archive_identity import fixture, write_archive
        from image_archive_identity import verify_saved_image
        source = 'f' * 40
        members, root_id, _, root_descriptor, size = fixture(True, True, source=source)
        child = json.loads(members['blobs/sha256/' + root_id[7:]])['manifests'][0]['digest']
        with tempfile.TemporaryDirectory() as directory:
            runner = Path(directory).resolve(); root = runner / 'image-security'; inputs = root / 'inputs'; inputs.mkdir(parents=True)
            archive = write_archive(inputs, members)
            graph = verify_saved_image(archive, child, size, root_descriptor, expected_source=source)
            target = {'architecture': 'amd64'}; args = SimpleNamespace(caddy=False, target_source=source)
            admitted_hash = hashlib.sha256(archive.read_bytes()).hexdigest()
            wrong = dict(root_descriptor); wrong['size'] += 1
            with patch.dict(scanner.os.environ, {'RUNNER_TEMP': str(runner)}):
                for retained in (False, True):
                    with self.subTest(retained=retained):
                        actual_hash = scanner.confirm_target_archive(root, child, graph, root_descriptor, target, args, retained, admitted_hash)
                        self.assertEqual(actual_hash, hashlib.sha256(archive.read_bytes()).hexdigest())
                        with self.assertRaises(ValueError):
                            scanner.confirm_target_archive(root, child, graph, wrong, target, args, retained, admitted_hash)
                data = bytearray(archive.read_bytes()); data[-1] ^= 1; archive.write_bytes(data)
                self.assertEqual(verify_saved_image(archive, child, size, root_descriptor, expected_source=source), graph)
                for retained in (False, True):
                    with self.subTest(mutated=True, retained=retained), self.assertRaisesRegex(ValueError, 'admitted bytes'):
                        scanner.confirm_target_archive(root, child, graph, root_descriptor, target, args, retained, admitted_hash)

    def test_scanner_saved_image_graph_uses_fixed_fd_route(self):
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); inputs = root / 'inputs'; reports = root / 'reports'
            inputs.mkdir(); reports.mkdir(); selected = {'store_id': 'sha256:' + 'a' * 64, 'descriptor': None}
            def process(command, timeout, maximum, stdout_path):
                stdout_path.write_bytes(b'inert export')
                return 0, b'', b'', None
            with patch.object(scanner, 'bounded_process', side_effect=process), patch.object(scanner, 'verify_trusted_image', return_value=({'fixture': True}, 'admitted-hash')) as verified:
                hashes = {}; _, _, save = scanner.scanner_operations(reports, inputs, time.monotonic() + 240, {}, hashes)
                self.assertEqual(save(selected['store_id'], selected, 'target'), {'fixture': True})
                verified.assert_called_once_with(root, 'target', selected['store_id'], scanner.TARGET_MAX_BYTES, None, include_hash=True)
                self.assertEqual(hashes['target'], 'admitted-hash')

    def test_official_database_requires_reviewed_schema_checksum_name_and_freshness(self):
        now = datetime.datetime(2026, 10, 28, 20, tzinfo=datetime.timezone.utc)
        record = {"status": "active", "schemaVersion": "v6.1.10", "built": "2026-10-28T06:23:30Z",
                  "path": "vulnerability-db_v6.1.10_2026-10-28T00:24:28Z_1793168610.tar.zst",
                  "checksum": "sha256:" + "a" * 64}
        url, checksum = scanner.database_manifest(record, now)
        self.assertTrue(url.startswith("https://grype.anchore.io/databases/v6/"))
        self.assertEqual(checksum, "a" * 64)
        for key, bad in [("path", "../../private"), ("schemaVersion", "v7.0.0"),
                         ("checksum", "sha256:bad"), ("built", "2026-10-01T00:00:00Z")]:
            value = dict(record); value[key] = bad
            with self.subTest(key=key), self.assertRaises(ValueError):
                scanner.database_manifest(value, now)

    def test_https_redirects_cannot_leave_bounded_origins(self):
        scanner.validate_public_url("https://grype.anchore.io/databases/v6/latest.json")
        for bad in ["http://grype.anchore.io/", "https://127.0.0.1/", "file:///private/key",
                    "https://grype.anchore.io:8443/", "https://user:password@grype.anchore.io/"]:
            with self.subTest(url=bad), self.assertRaises(ValueError):
                scanner.validate_public_url(bad)

    def test_actual_isolation_rejects_network_socket_mounts_and_inherited_app_startup(self):
        inputs = Path("/owned/inputs")
        image = "sha256:" + "a" * 64
        names = ["grype", "grype.yaml", "database.tar.zst", "image.tar", "grype-offline-runner.mjs"]
        runner = {"execution_reference": scanner.RUNNER_REF, "container_image_id": scanner.RUNNER_CONFIG_DIGEST}
        value = {"Image": scanner.RUNNER_CONFIG_DIGEST, "Config": {"Image": scanner.RUNNER_REF, "User": "65532:65532", "Entrypoint": ["/usr/bin/env"],
                 "Cmd": ["-i"], "WorkingDir": "/work", "Healthcheck": {"Test": ["NONE"]}},
                 "Mounts": [{"Type": "bind", "Destination": "/inputs/" + name,
                             "Source": str(inputs / name), "RW": False} for name in names],
                 "HostConfig": {"NetworkMode": "none", "ReadonlyRootfs": True, "Privileged": False,
                 "CapDrop": ["ALL"], "SecurityOpt": ["no-new-privileges=true"], "NanoCpus": 2000000000,
                 "Memory": 8589934592, "MemorySwap": 8589934592, "PidsLimit": 64,
                 "Tmpfs": {"/work": "rw,noexec,nosuid,nodev,size=6g,mode=1777",
                           "/tmp": "rw,noexec,nosuid,nodev,size=128m,mode=1777"}}}
        plan = scanner.isolated_container_command("fixture", inputs, runner)
        value["Config"]["Cmd"] = plan[plan.index(runner["execution_reference"]) + 1:]
        self.assertEqual(scanner.isolation_evidence(value, inputs, runner)["user"], "65532:65532")
        mutations = [lambda x: x.update(Image=image),
                     lambda x: x["Config"].update(Image="mutable-candidate-base"),
                     lambda x: x["HostConfig"].update(NetworkMode="bridge"),
                     lambda x: x["Mounts"][0].update(Source="/var/run/docker.sock"),
                     lambda x: x["Mounts"][0].update(RW=True),
                     lambda x: x["Config"]["Cmd"].insert(1, "GRYPE_EXCLUDE=**/*"),
                     lambda x: x["Config"].update(WorkingDir="/app"),
                     lambda x: x["Config"].update(Healthcheck={"Test": ["CMD", "node", "app.js"]})]
        for mutate in mutations:
            changed = copy.deepcopy(value); mutate(changed)
            with self.assertRaises(ValueError): scanner.isolation_evidence(changed, inputs, runner)
        modern_runner = {**runner, "container_image_id": "sha256:" + "b" * 64,
                         "archive": {"manifest_descriptor": {"digest": "sha256:" + "c" * 64,
                            "mediaType": "application/vnd.oci.image.manifest.v1+json", "size": 123}}}
        modern = copy.deepcopy(value); modern["Image"] = modern_runner["container_image_id"]
        modern["ImageManifestDescriptor"] = copy.deepcopy(modern_runner["archive"]["manifest_descriptor"])
        scanner.isolation_evidence(modern, inputs, modern_runner)
        for change in [lambda x: x.update(Image=scanner.RUNNER_CONFIG_DIGEST),
                       lambda x: x["ImageManifestDescriptor"].update(digest=scanner.RUNNER_CONFIG_DIGEST)]:
            invalid = copy.deepcopy(modern); change(invalid)
            with self.assertRaises(ValueError): scanner.isolation_evidence(invalid, inputs, modern_runner)
        command = scanner.isolated_container_command("owned-container", inputs, runner)
        self.assertNotIn(image, command)
        self.assertIn(runner["execution_reference"], command)
        self.assertIn("--no-healthcheck", command)
        self.assertNotIn("/var/run/docker.sock", " ".join(command))
        self.assertEqual(command.count("--mount"), 5)


class DownloadWorkerTests(unittest.TestCase):
    def test_isolated_script_worker_route_refuses_invalid_slot_before_network(self):
        import subprocess
        result = subprocess.run([sys.executable, '-E', '-s', '-S', str(Path(scanner.__file__).resolve()),
                                 '--download-worker', 'invalid', '0', 'https://github.com/file', '1', '-'],
                                capture_output=True, timeout=5, check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(b'fixed approved input slot', result.stderr)
        self.assertEqual(result.stdout, b'')

    def test_redirect_closes_actual_response_without_draining_or_following_forbidden_origin(self):
        import http.client
        import io
        import urllib.request
        class Stream(io.BytesIO):
            def __init__(self, raw): super().__init__(raw); self.body_reads = 0
            def read(self, *args): self.body_reads += 1; return super().read(*args)
        class Socket:
            def __init__(self, stream): self.stream = stream
            def makefile(self, *_args, **_kwargs): return self.stream
        for target, accepted in [('https://github.com/next', True), ('https://evil.invalid/next', False)]:
            with self.subTest(target=target):
                raw = (f'HTTP/1.1 302 Found\r\nLocation: {target}\r\nContent-Length: 7\r\n\r\n'.encode() + b'payload')
                stream = Stream(raw); response = http.client.HTTPResponse(Socket(stream)); response.begin()
                handler = scanner.TrustedRedirects({'github.com'}); followed = []
                class Parent:
                    def open(self, request, timeout):
                        self.assertion()
                        followed.append(request.full_url)
                        return 'followed'
                    def assertion(self):
                        if not response.isclosed(): raise AssertionError('old response remains open')
                handler.parent = Parent()
                request = urllib.request.Request('https://github.com/start'); request.timeout = 30
                if accepted:
                    self.assertEqual(handler.http_error_302(request, response, 302, 'Found', response.headers), 'followed')
                    self.assertEqual(followed, [target]); self.assertEqual(stream.body_reads, 0)
                else:
                    with self.assertRaises(ValueError): handler.http_error_302(request, response, 302, 'Found', response.headers)
                    self.assertEqual(followed, []); self.assertEqual(stream.body_reads, 0); self.assertTrue(response.isclosed())

    def test_forbidden_redirect_preserves_primary_error_if_response_close_fails(self):
        from unittest.mock import Mock
        response = Mock(); response.close.side_effect = OSError('close fixture')
        handler = scanner.TrustedRedirects({'github.com'})
        with self.assertRaisesRegex(ValueError, 'trusted HTTPS') as raised:
            handler.redirect_request(None, response, 302, 'Found', {}, 'https://evil.invalid/next')
        self.assertIn('close fixture', raised.exception.__notes__[0])
        response.close.assert_called_once()

    def test_redirect_close_propagates_fresh_cancellation(self):
        from unittest.mock import Mock
        cancellation = KeyboardInterrupt('close cancelled'); response = Mock(); response.close.side_effect = cancellation
        handler = scanner.TrustedRedirects({'github.com'})
        with self.assertRaises(KeyboardInterrupt) as raised:
            handler.redirect_request(None, response, 302, 'Found', {}, 'https://evil.invalid/next')
        self.assertIs(raised.exception, cancellation)

    def test_worker_readback_success_and_refuses_size_checksum_or_unsafe_slot(self):
        from unittest.mock import patch
        payload=b'inert download'; checksum=hashlib.sha256(payload).hexdigest()
        url='https://grype.anchore.io/databases/v6/vulnerability-db_v6.1.10_fixture.tar.zst'
        for scenario in ('ok', 'oversize', 'checksum'):
            with self.subTest(scenario=scenario), tempfile.TemporaryDirectory() as directory:
                path=Path(directory)/'destination'; fd=os.open(path,os.O_RDWR|os.O_CREAT|os.O_EXCL,0o600); closed=[]
                class Response:
                    def __init__(self): self.pending=(b'x'*(1024*1024+1)) if scenario=='oversize' else payload
                    def __enter__(self): return self
                    def __exit__(self,*_): closed.append(True)
                    def read(self,_size): value=self.pending; self.pending=b''; return value
                class Opener:
                    def open(self,*_args,**_kwargs): return Response()
                slot='manifest' if scenario=='oversize' else 'database'; chosen_url=scanner.DB_MANIFEST_URL if scenario=='oversize' else url
                maximum=1024*1024 if scenario=='oversize' else 1024**3
                expected=None if scenario=='oversize' else ('0'*64 if scenario=='checksum' else checksum)
                try:
                    with patch.object(scanner.urllib.request,'build_opener',return_value=Opener()):
                        if scenario=='ok':
                            receipt=scanner.download_worker(slot,fd,chosen_url,maximum,expected)
                            self.assertEqual((receipt['bytes'],receipt['sha256']),(len(payload),checksum))
                        else:
                            with self.assertRaises(ValueError): scanner.download_worker(slot,fd,chosen_url,maximum,expected)
                    self.assertEqual(closed,[True])
                finally: os.close(fd)
        with self.assertRaises(ValueError): scanner.download_contract('database','https://other.invalid/file',1024**3,checksum)

    def test_parent_fixed_slot_passes_owned_fd_and_refuses_forged_receipt(self):
        from unittest.mock import patch
        for forged in (False, True):
            with self.subTest(forged=forged), tempfile.TemporaryDirectory() as directory:
                runner=Path(directory).resolve(); root=runner/'image-security'; reports=root/'reports'; reports.mkdir(parents=True)
                payload=b'inert'; calls=[]
                def worker(command, timeout, maximum, stderr_maximum, pass_fds):
                    calls.append((command,timeout,pass_fds)); fd=pass_fds[0]; os.write(fd,payload)
                    identity=list(intake.stable_identity(os.fstat(fd)))
                    if forged: identity[1] += 1
                    receipt={'kind':'download-worker-v1','url':scanner.DB_MANIFEST_URL,'sha256':hashlib.sha256(payload).hexdigest(),
                             'bytes':len(payload),'started_utc':'start','finished_utc':'finish','identity':identity}
                    return 0,json.dumps(receipt).encode(),b'',None
                with patch.dict(os.environ,{'RUNNER_TEMP':str(runner)}), patch.object(scanner,'bounded_process',side_effect=worker):
                    deadline=time.monotonic()+2
                    if forged:
                        with self.assertRaisesRegex(ValueError,'identity changed'):
                            scanner.download(scanner.DB_MANIFEST_URL,reports/'database-manifest.json',1024*1024,deadline=deadline)
                    else:
                        receipt=scanner.download(scanner.DB_MANIFEST_URL,reports/'database-manifest.json',1024*1024,deadline=deadline)
                        self.assertEqual(receipt['bytes'],len(payload))
                    self.assertEqual(len(calls),1); self.assertLessEqual(calls[0][1],2)
                    self.assertEqual(calls[0][0][1:4],['-E','-s','-S'])
                    self.assertEqual((reports/'database-manifest.json').read_bytes(),payload)
                    with self.assertRaises(ValueError): scanner.download(scanner.DB_MANIFEST_URL,root/'outside',1024*1024,deadline=deadline)

    def test_parent_kills_and_reaps_inert_blocked_or_trickling_children(self):
        for scenario in ('blocked-open', 'blocked-read', 'trickle'):
            with self.subTest(scenario=scenario), tempfile.TemporaryDirectory() as directory:
                path=Path(directory)/'owned'; fd=os.open(path,os.O_RDWR|os.O_CREAT|os.O_EXCL,0o600)
                script=("import os,sys,time; f=int(sys.argv[1]); print(os.getpid(),flush=True); "
                        + ("os.write(f,b'partial'); " if scenario != 'blocked-open' else '')
                        + ("exec(" + repr("while True:\n print('x',flush=True); time.sleep(0.01)") + ")" if scenario=='trickle' else "time.sleep(5)"))
                try:
                    started=time.monotonic()
                    status, stdout, stderr, error=scanner.bounded_process([sys.executable,'-c',script,str(fd)],0.15,maximum=4096,pass_fds=(fd,))
                    self.assertIsNone(status); self.assertIn('deadline',error); self.assertLess(time.monotonic()-started,2)
                    pid=int(stdout.splitlines()[0])
                    with self.assertRaises(ProcessLookupError): os.kill(pid,0)
                    self.assertEqual(path.read_bytes(),b'' if scenario=='blocked-open' else b'partial')
                finally: os.close(fd)



class BoundedCaptureTests(unittest.TestCase):
    def test_successful_child_does_not_treat_callers_exception_as_its_primary(self):
        from unittest.mock import Mock, patch
        child = Mock(); child.stdout.close.side_effect = OSError('fixture close failure')
        with patch.object(scanner.subprocess, 'Popen', return_value=child), patch.object(scanner, 'capture_process', return_value=None):
            try: raise RuntimeError('unrelated caller exception')
            except RuntimeError as caller:
                with self.assertRaisesRegex(ValueError, 'Pipe close UNKNOWN'):
                    scanner.bounded_process(['inert'], 1)
                self.assertFalse(hasattr(caller, '__notes__'))
        child.stdout.close.assert_called_once(); child.stderr.close.assert_called_once()

    def test_pipe_close_attempts_both_and_preserves_primary_or_capture_error(self):
        from unittest.mock import Mock, patch
        for side in ('stdout', 'stderr'):
            for state in ('success', 'bounded', 'primary', 'cancel'):
                child = Mock(); close_error = OSError('close fixture')
                getattr(child, side).close.side_effect = close_error
                primary = KeyboardInterrupt('cancel') if state == 'cancel' else OSError('primary')
                capture = primary if state in ('primary', 'cancel') else None
                with self.subTest(side=side, state=state), patch.object(scanner.subprocess, 'Popen', return_value=child), \
                        patch.object(scanner, 'capture_process', side_effect=capture, return_value='bounded capture' if state == 'bounded' else None):
                    if state == 'success':
                        with self.assertRaisesRegex(ValueError, 'Pipe close UNKNOWN'):
                            scanner.bounded_process(['inert'], 1)
                    elif state == 'bounded':
                        result = scanner.bounded_process(['inert'], 1)
                        self.assertIn('bounded capture; Pipe close UNKNOWN', result[3])
                    else:
                        with self.assertRaises(type(primary)) as raised:
                            scanner.bounded_process(['inert'], 1)
                        self.assertIs(raised.exception, primary)
                        self.assertIn('Pipe close UNKNOWN', primary.__notes__[0])
                child.stdout.close.assert_called_once(); child.stderr.close.assert_called_once()

        for side in ('stdout', 'stderr'):
            child = Mock(); cancellation = KeyboardInterrupt('close cancelled')
            getattr(child, side).close.side_effect = cancellation
            with self.subTest(cancelled_side=side), patch.object(scanner.subprocess, 'Popen', return_value=child), \
                    patch.object(scanner, 'capture_process', return_value=None):
                with self.assertRaises(KeyboardInterrupt) as raised:
                    scanner.bounded_process(['inert'], 1)
                self.assertIs(raised.exception, cancellation)
            child.stdout.close.assert_called_once(); child.stderr.close.assert_called_once()

    def test_size_error_is_retained_when_child_reap_is_unknown(self):
        from unittest.mock import Mock, patch
        child = Mock(); child.wait.side_effect = subprocess.TimeoutExpired('fixture', 1)
        event = Mock(); event.fd = 17
        class Selector:
            def __enter__(self): return self
            def __exit__(self, *_): pass
            def register(self, *_): pass
            def get_map(self): return True
            def select(self, _timeout): return [(event, None)]
        with patch.object(scanner.selectors, 'DefaultSelector', return_value=Selector()), \
                patch.object(scanner.os, 'read', return_value=b'x'), \
                patch.object(scanner, 'collect_process_chunk', return_value=(0, 'combined size exceeded')), \
                patch.object(scanner, 'terminate_process', return_value=False):
            result = scanner.capture_process(child, time.monotonic() + 1, 1, None, None, [bytearray(), bytearray()])
        self.assertEqual(result, 'combined size exceeded; child reap UNKNOWN')

    def test_cleanup_error_preserves_primary_and_fresh_cancellation_propagates(self):
        import io
        from unittest.mock import patch
        cases = ((OSError('capture failure'), OSError('cleanup failure')),
                 (KeyboardInterrupt(), OSError('cleanup failure')),
                 (SystemExit(), OSError('cleanup failure')),
                 (OSError('capture failure'), KeyboardInterrupt()),
                 (OSError('capture failure'), SystemExit()))
        for original, cleanup in cases:
            with self.subTest(original=type(original).__name__, cleanup=type(cleanup).__name__):
                class Child:
                    def __init__(self): self.stdout = io.BytesIO(); self.stderr = io.BytesIO(); self.killed = False
                    def kill(self): self.killed = True
                    def wait(self, timeout=None):
                        if timeout is None: raise AssertionError('unbounded wait')
                        raise cleanup
                    def __exit__(self, *_): raise AssertionError('context fallback')
                child = Child()
                with patch.object(scanner.subprocess, 'Popen', return_value=child), \
                        patch.object(scanner, 'capture_process', side_effect=original):
                    expected = type(original) if isinstance(cleanup, Exception) else type(cleanup)
                    with self.assertRaises(expected) as raised:
                        scanner.bounded_process(['inert'], 0.01)
                if isinstance(cleanup, Exception):
                    self.assertIs(raised.exception, original)
                    self.assertIn('UNKNOWN', original.__notes__[0])
                else:
                    self.assertIs(raised.exception, cleanup)
                self.assertTrue(child.killed)
                self.assertTrue(child.stdout.closed); self.assertTrue(child.stderr.closed)

    def test_unreapable_child_has_bounded_wait_and_preserves_original_error(self):
        import io
        import subprocess
        from unittest.mock import patch
        failure = OSError('selector failed')
        class Unreapable:
            def __init__(self): self.stdout = io.BytesIO(); self.stderr = io.BytesIO(); self.waits = []; self.killed = False
            def kill(self): self.killed = True
            def wait(self, timeout=None):
                self.waits.append(timeout)
                raise subprocess.TimeoutExpired('inert', timeout)
            def __exit__(self, *_): raise AssertionError('Popen context fallback must not run')
        child = Unreapable()
        with patch.object(scanner.subprocess, 'Popen', return_value=child), \
                patch.object(scanner, 'capture_process', side_effect=failure):
            with self.assertRaises(OSError) as raised:
                scanner.bounded_process(['inert'], 0.01)
        self.assertIs(raised.exception, failure); self.assertTrue(child.killed)
        self.assertEqual(len(child.waits), 1); self.assertIsNotNone(child.waits[0])
        self.assertLessEqual(child.waits[0], 0.1)
        self.assertIn('UNKNOWN', raised.exception.__notes__[0])
        self.assertTrue(child.stdout.closed); self.assertTrue(child.stderr.closed)

    def test_selector_failure_and_cancellation_kill_and_reap_owned_child(self):
        from unittest.mock import patch
        import subprocess
        for failure in (OSError('selector failure'), KeyboardInterrupt()):
            with self.subTest(failure=type(failure).__name__), tempfile.TemporaryDirectory() as directory:
                class BrokenSelector:
                    def __enter__(self): return self
                    def __exit__(self, *_): pass
                    def register(self, *_args): pass
                    def get_map(self): return True
                    def select(self, _timeout): raise failure
                original = subprocess.Popen; children = []
                def spawn(*args, **kwargs):
                    child = original(*args, **kwargs); children.append(child); return child
                with patch.object(scanner.selectors, 'DefaultSelector', return_value=BrokenSelector()), \
                        patch.object(scanner.subprocess, 'Popen', side_effect=spawn):
                    with self.assertRaises(type(failure)) as raised:
                        scanner.bounded_process([sys.executable, '-c',
                                                 'import pathlib,sys,time; time.sleep(5); pathlib.Path(sys.argv[1]).write_text("late")',
                                                 str(Path(directory) / 'late')], 2)
                self.assertIs(raised.exception, failure)
                self.assertEqual(len(children), 1)
                self.assertIsNotNone(children[0].poll())
                with self.assertRaises(ProcessLookupError): os.kill(children[0].pid, 0)
                self.assertFalse((Path(directory) / 'late').exists())

    def test_child_output_is_stopped_before_host_capture_can_grow_unbounded(self):
        status, stdout, stderr, error = scanner.bounded_process(
            [sys.executable, "-c", "import sys;sys.stdout.write('x'*100000)"], 5, maximum=1024)
        self.assertIsNone(status)
        self.assertIn("bounded capture", error)
        self.assertLessEqual(len(stdout) + len(stderr), 1024)

    def test_streamed_archive_output_is_bounded_on_disk(self):
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / "image.tar"
            status, stdout, stderr, error = scanner.bounded_process(
                [sys.executable, "-c", "import sys;sys.stdout.buffer.write(b'x'*100000)"], 5,
                maximum=1024, stdout_path=destination)
            self.assertIsNone(status)
            self.assertIn("bounded capture", error)
            self.assertLessEqual(destination.stat().st_size, 1024)
            self.assertEqual(stdout, b"")

    def test_normal_nonzero_exit_keeps_actual_output_and_status(self):
        status, stdout, stderr, error = scanner.bounded_process(
            [sys.executable, "-c", "import sys;print('finding');sys.exit(2)"], 5)
        self.assertEqual((status, stdout, stderr, error), (2, b"finding\n", b"", None))


class ScannerEnvelopeTests(unittest.TestCase):
    def test_database_probe_preserves_failure_and_refuses_unknown_reap(self):
        from unittest.mock import patch, Mock
        header = tarfile.TarInfo('vulnerability.db'); header.size = 1; raw = header.tobuf()
        archive = Path('fixture')
        class Selector:
            def __enter__(self): return self
            def __exit__(self, *_): pass
            def register(self, *_): pass
            def select(self, _timeout): return [True]
        for scenario in ('success', 'unreaped', 'read-error', 'read-error-unreaped', 'read-error-close-error', 'success-close-error', 'read-error-cleanup-cancel'):
            child = Mock(); child.stdout.fileno.return_value = 17
            child.wait.side_effect = subprocess.TimeoutExpired('fixture', 5) if 'unreaped' in scenario else None
            failure = OSError('fixture read failed')
            close_error = OSError('fixture close failed')
            cancellation = KeyboardInterrupt('fixture cancellation')
            if 'close-error' in scenario: child.stdout.close.side_effect = close_error
            if scenario == 'read-error-cleanup-cancel': child.kill.side_effect = cancellation
            read = failure if scenario.startswith('read-error') else raw
            with self.subTest(scenario=scenario), patch.object(scanner.subprocess, 'Popen', return_value=child) as popen, \
                    patch.object(scanner.selectors, 'DefaultSelector', return_value=Selector()), patch.object(scanner.os, 'read', side_effect=read if isinstance(read, OSError) else None, return_value=raw):
                if scenario == 'success':
                    result = scanner.database_payload_bytes(archive)
                    self.assertEqual(result['declared_payload_bytes'], 1)
                elif scenario == 'unreaped':
                    with self.assertRaisesRegex(ValueError, 'cleanup UNKNOWN'):
                        scanner.database_payload_bytes(archive)
                elif scenario == 'success-close-error':
                    with self.assertRaises(OSError) as raised:
                        scanner.database_payload_bytes(archive)
                    self.assertIs(raised.exception, close_error)
                elif scenario == 'read-error-cleanup-cancel':
                    with self.assertRaises(KeyboardInterrupt) as raised:
                        scanner.database_payload_bytes(archive)
                    self.assertIs(raised.exception, cancellation)
                else:
                    with self.assertRaises(OSError) as raised:
                        scanner.database_payload_bytes(archive)
                    self.assertIs(raised.exception, failure)
                    if scenario.endswith('unreaped'): self.assertIn('UNKNOWN', failure.__notes__[0])
                    if scenario.endswith('close-error'): self.assertIn('close UNKNOWN', failure.__notes__[0])
                self.assertEqual(popen.call_args.kwargs['stdin'], subprocess.DEVNULL)
                child.stdout.close.assert_called_once(); child.kill.assert_called_once()
                if scenario != 'read-error-cleanup-cancel': self.assertIsNotNone(child.wait.call_args.kwargs['timeout'])

    def test_partial_or_empty_retained_arguments_refuse_before_output_preparation(self):
        from unittest.mock import patch
        for extra in (['--target-attempt', '0'], ['--retained-intake', '']):
            with self.subTest(extra=extra), patch.object(sys, 'argv', ['scanner', '/fixture', *extra]), \
                    patch.object(scanner, 'trusted_work_root') as work, patch.object(scanner, 'prepare_scanner_output') as prepare:
                with self.assertRaisesRegex(ValueError, 'Complete retained intake'):
                    scanner.main()
                work.assert_not_called(); prepare.assert_not_called()

    def test_fixed_producer_names_are_written_and_untrusted_names_refuse_before_any_write(self):
        with tempfile.TemporaryDirectory() as directory:
            reports = Path(directory)
            def envelope(files): return json.dumps({'kind': 'grype-offline-envelope-v1', 'exit_code': 0, 'files': files}).encode()
            files = {'version.stdout': 'ok', 'db-import-receipt.json': '{}', 'application-image-vulnerabilities.json': '{}'}
            self.assertEqual(scanner.persist_scanner_envelope(envelope(files), 0, reports), 0)
            self.assertEqual({p.name for p in reports.iterdir()}, set(files))
        for name in ('-version.stdout', '../outside.json', 'offline-provenance.json', 'scanner-owned-intent.json'):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as directory:
                reports = Path(directory)
                raw = envelope({'version.stdout': 'ok', name: 'bad'})
                with self.assertRaises(ValueError):
                    scanner.persist_scanner_envelope(raw, 0, reports)
                self.assertEqual(list(reports.iterdir()), [])
        with tempfile.TemporaryDirectory() as directory:
            reports = Path(directory)
            raw = envelope({'version.stdout': 1})
            with self.assertRaises(ValueError): scanner.persist_scanner_envelope(raw, 0, reports)
            self.assertEqual(list(reports.iterdir()), [])

    def test_runner_archive_uses_independent_cap_for_export_verification_and_failure_receipt(self):
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); inputs = root / 'inputs'; reports = root / 'reports'; inputs.mkdir(); reports.mkdir()
            selected = {'store_id': 'sha256:' + 'a' * 64, 'descriptor': None}; calls = []
            def run(_command, _label, _timeout, *, stdout_path, maximum):
                calls.append(maximum); stdout_path.write_bytes(b'archive'); return 0, b''
            with patch.object(scanner, 'RUNNER_MAX_BYTES', 1234), patch.object(scanner, 'verify_trusted_image', side_effect=ValueError('fixture')) as verify:
                with self.assertRaisesRegex(ValueError, 'fixture'):
                    scanner.save_verified_archive('runner', selected, 'runner', run, reports, inputs, {})
                self.assertEqual(calls, [1234 + 128 * 1024 ** 2])
                self.assertEqual(verify.call_args.args[3], 1234)
                receipt = json.loads((reports / 'runner-archive-verification-failure.json').read_text())
                self.assertEqual(receipt['unpacked_admission_cap_bytes'], 1234)


class McpScannerCapacityTests(unittest.TestCase):
    def test_measured_payload_fits_proposed_public_runner_but_4g_vm_is_refused(self):
        admission = scanner.capacity_admission(712633849, 12 * scanner.GIB, 6 * scanner.GIB)
        self.assertLess(admission["target_and_scratch_required_bytes"], 6 * scanner.GIB)
        self.assertEqual(admission["memory_limit_bytes"], 8 * scanner.GIB)
        for size, ram, disk in [(2 * scanner.GIB, 12 * scanner.GIB, 6 * scanner.GIB),
                                (712633849, 3 * scanner.GIB, 6 * scanner.GIB),
                                (712633849, 12 * scanner.GIB, scanner.GIB)]:
            with self.assertRaises(ValueError): scanner.capacity_admission(size, ram, disk)

    def test_database_header_bounds_raw_payload_before_import(self):
        header = tarfile.TarInfo("vulnerability.db"); header.size = 2541993984
        self.assertEqual(scanner.db_payload_header(header.tobuf()), 2541993984)
        header.size = 3 * scanner.GIB
        encoded_header = header.tobuf()
        with self.assertRaises(ValueError): scanner.db_payload_header(encoded_header)
        header.size = 1024; header.name = "unexpected-payload"
        encoded_header = header.tobuf()
        with self.assertRaises(ValueError): scanner.db_payload_header(encoded_header)

class OwnedScannerCleanupTests(unittest.TestCase):
    def setUp(self):
        self.inputs = Path('/owned/inputs')
        self.owner = {'name': 'beta-offline-scan-123', 'nonce': 'f' * 32}
        self.runner = {'execution_reference': scanner.RUNNER_REF, 'container_image_id': scanner.RUNNER_CONFIG_DIGEST,
                       'index_digest': scanner.RUNNER_REF.removeprefix('node@'),
                       'manifest_digest': 'sha256:c83040f7e24bacea68e58a0b96a484ba430bf24abb2973eab7ba4701144b7b63',
                       'config_digest': scanner.RUNNER_CONFIG_DIGEST}
        plan = scanner.isolated_container_command(self.owner['name'], self.inputs, self.runner, self.owner['nonce'])
        self.value = {'Id': 'a' * 64, 'Name': '/' + self.owner['name'], 'Image': self.runner['container_image_id'],
            'Config': {'Image': scanner.RUNNER_REF, 'User': '65532:65532', 'Entrypoint': ['/usr/bin/env'],
                'Cmd': plan[plan.index(scanner.RUNNER_REF)+1:], 'WorkingDir': '/work', 'Healthcheck': {'Test': ['NONE']},
                'Labels': {'org.dollhousemcp.scanner-owner': self.owner['nonce']}},
            'Mounts': [{'Type': 'bind', 'Destination': '/inputs/' + name, 'Source': str(self.inputs / name), 'RW': False}
                       for name in ['grype', 'grype.yaml', 'database.tar.zst', 'image.tar', 'grype-offline-runner.mjs']],
            'HostConfig': {'NetworkMode': 'none', 'ReadonlyRootfs': True, 'Privileged': False, 'CapDrop': ['ALL'],
                'SecurityOpt': ['no-new-privileges=true'], 'NanoCpus': 2000000000, 'Memory': scanner.CONTAINER_MEMORY_BYTES,
                'MemorySwap': scanner.CONTAINER_MEMORY_BYTES, 'PidsLimit': 64,
                'Tmpfs': {'/work': 'rw,noexec,nosuid,nodev,size=6g,mode=1777', '/tmp': 'rw,noexec,nosuid,nodev,size=128m,mode=1777'}}}

    def execute(self, value, expected=None, inspect_status=0, rm_status=0):
        from unittest.mock import patch
        calls = []
        def fake(command, timeout, *args, **kwargs):
            calls.append((command, timeout))
            return (inspect_status, json.dumps([value]).encode(), b'', None) if len(calls) == 1 else (rm_status, b'', b'', None)
        with patch.object(scanner, 'bounded_process', side_effect=fake):
            report = scanner.cleanup_owned_scanner(self.owner, self.inputs, self.runner, expected)
        return report, calls

    def test_lost_receipt_resolves_only_exact_name_and_removes_verified_full_id(self):
        report, calls = self.execute(self.value)
        self.assertEqual(report['status'], 'verified-owned-container-removed')
        self.assertEqual(report['verified_identity']['runner_container_image_id'], self.runner['container_image_id'])
        self.assertEqual(calls, [(['docker', 'inspect', self.owner['name']], 10),
                                 (['docker', 'rm', '--force', '--volumes', 'a' * 64], 20)])

    def test_mismatch_and_missing_resolution_remain_unknown_without_removal(self):
        mutations = [lambda v: v.update(Id='a'*63), lambda v: v.update(Name='/other'),
                     lambda v: v['Config']['Labels'].update({'org.dollhousemcp.scanner-owner': 'other'}),
                     lambda v: v.update(Image='sha256:'+'b'*64), lambda v: v['Mounts'][0].update(RW=True),
                     lambda v: v['Config']['Cmd'].append('unexpected')]
        for mutate in mutations:
            value = copy.deepcopy(self.value); mutate(value)
            report, calls = self.execute(value)
            self.assertEqual(report['status'], 'UNKNOWN'); self.assertEqual(len(calls), 1)
        for kwargs in ({'expected': 'b'*64}, {'inspect_status': 1}):
            report, calls = self.execute(self.value, **kwargs)
            self.assertEqual(report['status'], 'UNKNOWN'); self.assertEqual(len(calls), 1)
        report, _ = self.execute(self.value, rm_status=1)
        self.assertEqual(report['status'], 'UNKNOWN')


class OwnedScannerOrchestrationTests(OwnedScannerCleanupTests):
    def test_create_failure_modes_always_resolve_before_reporting(self):
        from unittest.mock import patch
        import time
        scenarios = ['nonzero', 'timeout', 'empty', 'malformed', 'cancel', 'disk']
        for scenario in scenarios:
            with self.subTest(scenario=scenario), tempfile.TemporaryDirectory() as directory:
                events = []
                def run(command, label, *args, **kwargs):
                    events.append(label)
                    if label == 'container-create':
                        if scenario == 'cancel': raise KeyboardInterrupt()
                        if scenario == 'disk': raise OSError('receipt persistence failed')
                        return {'nonzero': (1, b''), 'timeout': (None, b''), 'empty': (0, b''), 'malformed': (0, b'partial')}[scenario]
                    raise AssertionError(label)
                def process(command, timeout, *args, **kwargs):
                    events.append(command[1]); return (0, json.dumps([self.value]).encode(), b'', None) if command[1] == 'inspect' else (0, b'', b'', None)
                reports = Path(directory); deadline = time.monotonic() + 240
                with patch.object(scanner, 'bounded_process', side_effect=process):
                    with self.assertRaises((ValueError, KeyboardInterrupt, OSError)):
                        scanner.execute_owned_scanner(self.owner['name'], self.owner['nonce'], self.inputs, self.runner,
                                                      run, reports, {}, deadline)
                self.assertEqual(events, ['container-create', 'inspect', 'rm'])
                self.assertEqual(json.loads((Path(directory) / 'scanner-cleanup.json').read_text())['status'], 'verified-owned-container-removed')

    def test_success_and_failed_full_receipt_are_bound_to_cleanup(self):
        from unittest.mock import patch
        import time
        for status, receipt in [(0, 'a'*64), (1, 'a'*64), (1, 'b'*64)]:
            with self.subTest(status=status, receipt=receipt), tempfile.TemporaryDirectory() as directory:
                calls = []
                def run(command, label, *args, **kwargs):
                    calls.append(label)
                    if label == 'container-create': return status, receipt.encode()
                    if label == 'container-inspect': return 0, json.dumps([self.value]).encode()
                    if label == 'container-start': return 0, json.dumps({'kind':'grype-offline-envelope-v1', 'exit_code':0, 'files':{}}).encode()
                    raise AssertionError(label)
                def process(command, timeout, *args, **kwargs):
                    calls.append(command[1]); return (0, json.dumps([self.value]).encode(), b'', None) if command[1] == 'inspect' else (0, b'', b'', None)
                reports = Path(directory); deadline = time.monotonic() + 240
                with patch.object(scanner, 'bounded_process', side_effect=process):
                    if status == 0:
                        self.assertEqual(scanner.execute_owned_scanner(self.owner['name'], self.owner['nonce'], self.inputs, self.runner, run, Path(directory), {}, time.monotonic()+240), 0)
                    else:
                        with self.assertRaises(ValueError): scanner.execute_owned_scanner(self.owner['name'], self.owner['nonce'], self.inputs, self.runner, run, reports, {}, deadline)
                self.assertEqual(calls[-1], 'inspect' if receipt.startswith('b') else 'rm')
                self.assertEqual('container-start' in calls, status == 0)

    def test_cleanup_refuses_runner_graph_and_descriptor_changes(self):
        from unittest.mock import patch
        for key in ('index_digest', 'manifest_digest', 'config_digest'):
            runner = dict(self.runner); runner[key] = 'sha256:' + 'f'*64
            with patch.object(scanner, 'bounded_process', return_value=(0, json.dumps([self.value]).encode(), b'', None)) as process:
                result = scanner.cleanup_owned_scanner(self.owner, self.inputs, runner)
                self.assertEqual(result['status'], 'UNKNOWN'); self.assertEqual(process.call_count, 1)
        runner = dict(self.runner); runner['archive'] = {'manifest_descriptor': {'digest':'sha256:'+'c'*64, 'mediaType':'fixture', 'size': 12}}
        value = copy.deepcopy(self.value); value['ImageManifestDescriptor'] = {'digest':'sha256:'+'d'*64, 'mediaType':'fixture', 'size':12}
        with patch.object(scanner, 'bounded_process', return_value=(0, json.dumps([value]).encode(), b'', None)) as process:
            self.assertEqual(scanner.cleanup_owned_scanner(self.owner, self.inputs, runner)['status'], 'UNKNOWN')
            self.assertEqual(process.call_count, 1)

    def test_persistence_failure_occurs_after_cleanup_and_emits_terminal_summary(self):
        from unittest.mock import patch
        import time
        events = []; real_write = Path.write_text
        def run(*args, **kwargs): raise ValueError('create failed')
        def process(command, timeout, *args, **kwargs):
            events.append(command[1]); return (0, json.dumps([self.value]).encode(), b'', None) if command[1] == 'inspect' else (0, b'', b'', None)
        def write(path, *args, **kwargs):
            if path.name == 'scanner-cleanup.json': raise OSError('full disk')
            return real_write(path, *args, **kwargs)
        with tempfile.TemporaryDirectory() as directory, patch.object(scanner, 'bounded_process', side_effect=process), patch.object(Path, 'write_text', write), patch.object(scanner.sys, 'stderr', new_callable=io.StringIO) as stderr:
            reports = Path(directory); deadline = time.monotonic() + 240
            with self.assertRaises(OSError):
                scanner.execute_owned_scanner(self.owner['name'], self.owner['nonce'], self.inputs, self.runner,
                                              run, reports, {}, deadline)
            self.assertEqual(events, ['inspect', 'rm'])
            self.assertIn('incomplete-summary-persistence', stderr.getvalue())


if __name__ == "__main__":
    unittest.main()
