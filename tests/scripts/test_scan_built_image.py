"""No network/execution: checksum and hostile archive extraction boundaries."""
import hashlib
import datetime
import json
import copy
import importlib.util
import io
from pathlib import Path
import tarfile
import tempfile
import unittest
import sys

spec = importlib.util.spec_from_file_location(
    "scan_built_image", Path(__file__).resolve().parents[2] / "scripts/scan-built-image.py")
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

    def test_image_archive_id_comes_from_actual_config_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            archive = Path(directory) / "image.tar"
            config = b'{"architecture":"amd64","rootfs":{"type":"layers","diff_ids":[]}}'
            manifest = json.dumps([{"Config": "owned.json", "Layers": []}]).encode()
            with tarfile.open(archive, "w") as bundle:
                for name, data in [("manifest.json", manifest), ("owned.json", config)]:
                    member = tarfile.TarInfo(name); member.size = len(data)
                    bundle.addfile(member, io.BytesIO(data))
            self.assertEqual(scanner.image_archive_identity(archive), "sha256:" + hashlib.sha256(config).hexdigest())

    def test_actual_isolation_rejects_network_socket_mounts_and_inherited_app_startup(self):
        inputs = Path("/owned/inputs")
        image = "sha256:" + "a" * 64
        names = ["grype", "grype.yaml", "database.tar.zst", "image.tar", "grype-offline-runner.mjs"]
        value = {"Image": scanner.RUNNER_IMAGE_ID, "Config": {"Image": scanner.RUNNER_REF, "User": "65532:65532", "Entrypoint": ["/usr/bin/env"],
                 "Cmd": ["-i"], "WorkingDir": "/work", "Healthcheck": {"Test": ["NONE"]}},
                 "Mounts": [{"Type": "bind", "Destination": "/inputs/" + name,
                             "Source": str(inputs / name), "RW": False} for name in names],
                 "HostConfig": {"NetworkMode": "none", "ReadonlyRootfs": True, "Privileged": False,
                 "CapDrop": ["ALL"], "SecurityOpt": ["no-new-privileges=true"], "NanoCpus": 2000000000,
                 "Memory": 3221225472, "MemorySwap": 3221225472, "PidsLimit": 64,
                 "Tmpfs": {"/work": "rw,noexec,nosuid,nodev,size=2g,mode=1777",
                           "/tmp": "rw,noexec,nosuid,nodev,size=128m,mode=1777"}}}
        plan = scanner.isolated_container_command("fixture", inputs)
        value["Config"]["Cmd"] = plan[plan.index(scanner.RUNNER_REF) + 1:]
        self.assertEqual(scanner.isolation_evidence(value, inputs)["user"], "65532:65532")
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
            with self.assertRaises(ValueError): scanner.isolation_evidence(changed, inputs)
        command = scanner.isolated_container_command("owned-container", inputs)
        self.assertNotIn(image, command)
        self.assertIn(scanner.RUNNER_REF, command)
        self.assertIn("--no-healthcheck", command)
        self.assertNotIn("/var/run/docker.sock", " ".join(command))
        self.assertEqual(command.count("--mount"), 5)


class BoundedCaptureTests(unittest.TestCase):
    def test_child_output_is_stopped_before_host_capture_can_grow_unbounded(self):
        status, stdout, stderr, error = scanner.bounded_process(
            [sys.executable, "-c", "import sys;sys.stdout.write('x'*100000)"], 5, maximum=1024)
        self.assertIsNone(status)
        self.assertIn("bounded capture", error)
        self.assertLessEqual(len(stdout) + len(stderr), 1024)

    def test_normal_nonzero_exit_keeps_actual_output_and_status(self):
        status, stdout, stderr, error = scanner.bounded_process(
            [sys.executable, "-c", "import sys;print('finding');sys.exit(2)"], 5)
        self.assertEqual((status, stdout, stderr, error), (2, b"finding\n", b"", None))


if __name__ == "__main__":
    unittest.main()
