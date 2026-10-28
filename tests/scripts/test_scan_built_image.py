"""No network/execution: checksum and hostile archive extraction boundaries."""
import hashlib
import importlib.util
import io
from pathlib import Path
import tarfile
import tempfile
import unittest

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


if __name__ == "__main__":
    unittest.main()
