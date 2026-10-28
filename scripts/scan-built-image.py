#!/usr/bin/env python3
"""Scan the job's local application image with exact reviewed release bytes."""
import datetime
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import urllib.request

ARCHIVE_NAME = "grype_0.121.0_linux_amd64.tar.gz"
ARCHIVE_URL = "https://github.com/anchore/grype/releases/download/v0.121.0/" + ARCHIVE_NAME
ARCHIVE_SHA256 = "64e07133d3486115de647a66581461dccf5c732748a0a3119077395565f15519"


def extract_verified_binary(archive, destination, expected_sha256=ARCHIVE_SHA256):
    if hashlib.sha256(archive.read_bytes()).hexdigest() != expected_sha256:
        raise ValueError("Grype archive does not match the reviewed release SHA256")
    with tarfile.open(archive, "r:gz") as bundle:
        members = [member for member in bundle.getmembers() if member.name == "grype"]
        if len(members) != 1 or not members[0].isfile():
            raise ValueError("Expected exactly one regular grype binary")
        # Never extract paths, symlinks, hardlinks, permissions or other members.
        with bundle.extractfile(members[0]) as source:
            binary = source.read()
    destination.write_bytes(binary)
    destination.chmod(0o700)


def scanner_environment(inherited, root):
    # Neither Grype nor its embedded Syft cataloger may inherit suppression,
    # distro, source or database policy from the runner environment.
    env = {key: value for key, value in inherited.items()
           if not key.startswith(("GRYPE_", "SYFT_"))}
    env.update(GRYPE_DB_CACHE_DIR=str(root / "db"), GRYPE_DB_AUTO_UPDATE="false",
               GRYPE_CHECK_FOR_APP_UPDATE="false", GRYPE_DB_VALIDATE_AGE="true",
               GRYPE_DB_VALIDATE_BY_HASH_ON_START="true",
               GRYPE_DB_MAX_ALLOWED_BUILT_AGE="120h",
               GRYPE_DB_UPDATE_URL="https://grype.anchore.io/databases",
               XDG_CACHE_HOME=str(root / "cache"))
    return env


def main():
    root = Path(sys.argv[1]).resolve()
    reports = root / "reports"
    reports.mkdir(parents=True, exist_ok=True)
    archive = root / ARCHIVE_NAME
    binary = root / "grype"
    config = Path(".github/grype-image-scan.yaml").resolve()
    download = {"url": ARCHIVE_URL, "expected_sha256": ARCHIVE_SHA256,
                "started_utc": datetime.datetime.now(datetime.timezone.utc).isoformat()}
    with urllib.request.urlopen(ARCHIVE_URL, timeout=120) as response:
        data = response.read(100 * 1024 * 1024 + 1)
    if len(data) > 100 * 1024 * 1024:
        raise ValueError("Grype archive exceeds bounded download size")
    archive.write_bytes(data)
    extract_verified_binary(archive, binary)
    download["verified_sha256"] = hashlib.sha256(data).hexdigest()
    (reports / "download.json").write_text(json.dumps(download, indent=2))
    env = scanner_environment(os.environ, root)

    def run(args, name, timeout):
        command = [str(binary), "--config", str(config)] + args
        receipt = {"command": command, "timeout_seconds": timeout,
                   "started_utc": datetime.datetime.now(datetime.timezone.utc).isoformat()}
        try:
            child = subprocess.run(command, cwd=root, env=env, capture_output=True,
                                   timeout=timeout, check=False)
            stdout, stderr = child.stdout, child.stderr
            receipt["exit_code"] = child.returncode
        except subprocess.TimeoutExpired as error:
            stdout, stderr = error.stdout or b"", error.stderr or b""
            receipt.update(exit_code=None, timed_out=True)
        (reports / (name + ".stdout")).write_bytes(stdout)
        (reports / (name + ".stderr")).write_bytes(stderr)
        receipt["finished_utc"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        (reports / (name + "-receipt.json")).write_text(json.dumps(receipt, indent=2))
        print(json.dumps(receipt), flush=True)
        return receipt["exit_code"], stdout

    for args, name in [(["version", "-o", "json"], "version"), (["--help"], "help"),
                       (["config", "--load"], "effective-config"),
                       (["db", "update"], "db-update")]:
        status, _ = run(args, name, 180)
        if status != 0:
            return 1
    status, stdout = run(["db", "status", "-o", "json"], "db-status", 30)
    if status != 0 or json.loads(stdout).get("valid") is not True:
        raise ValueError("Fresh validated Grype database is unavailable")
    status, _ = run(["docker:dollhousemcp:latest-linux-amd64", "--output", "json",
                     "--file", str(reports / "application-image-vulnerabilities.json"),
                     "--fail-on", "high"], "scan", 180)
    return status if status in (0, 2) else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        if len(sys.argv) > 1:
            reports = Path(sys.argv[1]).resolve() / "reports"
            reports.mkdir(parents=True, exist_ok=True)
            (reports / "failure.json").write_text(json.dumps({
                "error": str(error),
                "timestamp_utc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                "status": "unavailable; no clean image-security claim",
            }, indent=2))
        print(str(error), file=sys.stderr)
        sys.exit(1)
