#!/usr/bin/env python3
"""Scan the job's local application image with exact reviewed release bytes."""
import datetime
import argparse
import sys
# Keep imports from creating untracked files in the validated scanner checkout.
sys.dont_write_bytecode = True
import contextlib
import hashlib
import json
import os
import re
import selectors
import shutil
import time
import urllib.parse
import uuid
from image_archive_identity import verify_fixed_runner
from image_scan_intake import validate_intake, trusted_work_root, verify_trusted_image, prepare_scanner_output, write_failure_report
from pathlib import Path
import subprocess
import tarfile
import urllib.request

ARCHIVE_NAME = "grype_0.120.1_linux_amd64.tar.gz"
ARCHIVE_URL = "https://github.com/anchore/grype/releases/download/v0.120.1/" + ARCHIVE_NAME
ARCHIVE_SHA256 = "0a9ee97ef5ae2ee953b0a80098105052e846cdbe319a57d808b519c33cd1343d"
GRYPE_HOST = "grype.anchore.io"
WORK_DIR = "/work"
GRYPE_CONFIG = "grype.yaml"
DATABASE_ARCHIVE = "database.tar.zst"
IMAGE_ARCHIVE = "image.tar"
OFFLINE_RUNNER = "grype-offline-runner.mjs"


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


DB_MANIFEST_URL = "https://grype.anchore.io/databases/v6/latest.json"
# Protected beta88efb60c docker/Dockerfile:5, not candidate-controlled Dockerfile input.
RUNNER_REF = "node@sha256:173f125896c3b47ddf056734c7ea789d04595a6a08769a8f78e0df642781fb66"
RUNNER_CONFIG_DIGEST = "sha256:04f59b17d8d39a8fdeb138fecb8fcbaa6e208ed7b6db929c7e98ad9005e0a52f"
SUPPORTED_DB_SCHEMA = "v6.1.10"  # Inspected official manifest and existing validated DB.

GIB = 1024 ** 3
TARGET_MAX_BYTES = GIB
RAW_DB_MAX_BYTES = 5 * GIB // 2
HYDRATED_DB_RESERVE_BYTES = 7 * GIB // 2
SCRATCH_RESERVE_BYTES = GIB // 2
WORK_TMPFS_BYTES = 6 * GIB
CONTAINER_MEMORY_BYTES = 8 * GIB
HOST_MEMORY_HEADROOM_BYTES = GIB


class TrustedRedirects(urllib.request.HTTPRedirectHandler):
    def __init__(self, hosts):
        self.hosts = hosts

    def redirect_request(self, request, fp, code, message, headers, url):
        validate_public_url(url, self.hosts)
        return super().redirect_request(request, fp, code, message, headers, url)


def validate_public_url(url, allowed_hosts=None):
    value = urllib.parse.urlsplit(url)
    if (value.scheme != "https" or value.port not in (None, 443) or value.username or
            value.password or value.hostname not in (allowed_hosts or
            {"github.com", "release-assets.githubusercontent.com", GRYPE_HOST})):
        raise ValueError("Download redirects must remain on the bounded trusted HTTPS origins")


def download(url, destination, maximum, expected=None):
    validate_public_url(url)
    request = urllib.request.Request(url, headers={"User-Agent": "dollhouse-offline-scanner-review/2026-10-28"})
    digest = hashlib.sha256()
    count = 0
    started = time.monotonic()
    started_utc = datetime.datetime.now(datetime.timezone.utc).isoformat()
    hosts = {GRYPE_HOST} if urllib.parse.urlsplit(url).hostname == GRYPE_HOST else {"github.com", "release-assets.githubusercontent.com"}
    with urllib.request.build_opener(TrustedRedirects(hosts)).open(request, timeout=30) as response, destination.open("wb") as output:
        while chunk := response.read(1024 * 1024):
            count += len(chunk)
            if count > maximum or time.monotonic() - started > 180:
                raise ValueError("Download exceeds bounded size or time")
            digest.update(chunk)
            output.write(chunk)
    if expected and digest.hexdigest() != expected:
        raise ValueError("Downloaded artifact does not match its reviewed checksum")
    return {"url": url, "sha256": digest.hexdigest(), "bytes": count,
            "started_utc": started_utc, "finished_utc": datetime.datetime.now(datetime.timezone.utc).isoformat()}


def database_manifest(document, now):
    checksum = document.get("checksum", "")
    name = document.get("path", "")
    built = datetime.datetime.fromisoformat(document.get("built", "").replace("Z", "+00:00"))
    age = (now - built).total_seconds()
    if (document.get("status") != "active" or document.get("schemaVersion") != SUPPORTED_DB_SCHEMA or
            not re.fullmatch(r"sha256:[a-f0-9]{64}", checksum) or
            not re.fullmatch(r"vulnerability-db_v6[.]1[.]10_[A-Za-z0-9:_-]+[.]tar[.]zst", name) or
            not 0 <= age <= 120 * 60 * 60):
        raise ValueError("Official DB manifest is unsupported, malformed or stale")
    return "https://grype.anchore.io/databases/v6/" + name, checksum[7:]


def capacity_admission(target_size, available_memory, free_disk):
    if type(target_size) is not int or not 0 < target_size <= TARGET_MAX_BYTES:
        raise ValueError("Job-built image uncompressed Size exceeds the explicit 1 GiB admission cap")
    work_required = HYDRATED_DB_RESERVE_BYTES + 2 * target_size + SCRATCH_RESERVE_BYTES
    # Inputs: Docker archive plus metadata, compressed DB, binary, reports and disk margin.
    disk_required = target_size + 128 * 1024 ** 2 + TARGET_MAX_BYTES + 128 * 1024 ** 2 + GIB + 100 * 1024 ** 2 + 64 * 1024 ** 2 + GIB
    if work_required > WORK_TMPFS_BYTES or available_memory < CONTAINER_MEMORY_BYTES + HOST_MEMORY_HEADROOM_BYTES or free_disk < disk_required:
        raise ValueError("Host RAM/disk or bounded work-space prerequisites are insufficient; scanner will not start")
    return {"target_uncompressed_size_bytes": target_size, "target_max_bytes": TARGET_MAX_BYTES,
            "hydrated_db_reserve_bytes": HYDRATED_DB_RESERVE_BYTES,
            "target_and_scratch_required_bytes": work_required,
            "work_tmpfs_bytes": WORK_TMPFS_BYTES, "memory_limit_bytes": CONTAINER_MEMORY_BYTES,
            "available_memory_bytes": available_memory, "memory_required_bytes": CONTAINER_MEMORY_BYTES + HOST_MEMORY_HEADROOM_BYTES,
            "free_disk_bytes": free_disk, "disk_required_bytes": disk_required}


def db_payload_header(header):
    entry = tarfile.TarInfo.frombuf(header, "utf-8", "strict")
    if entry.name != "vulnerability.db" or not entry.isfile() or not 0 < entry.size <= RAW_DB_MAX_BYTES:
        raise ValueError("DB archive payload is unexpected or exceeds its explicit 2.5 GiB admission cap")
    return entry.size


def database_payload_bytes(archive):
    # Existing Ubuntu system zstd only; no installation or network/Go execution.
    command = ["/usr/bin/zstd", "--decompress", "--stdout", str(archive)]
    with subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL) as child:
        try:
            data = bytearray()
            with selectors.DefaultSelector() as ready:
                ready.register(child.stdout, selectors.EVENT_READ)
                deadline = time.monotonic() + 5
                while len(data) < 512:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0 or not ready.select(remaining):
                        raise ValueError("DB payload header probe exceeded its five-second bound")
                    chunk = os.read(child.stdout.fileno(), 512 - len(data))
                    if not chunk: raise ValueError("DB payload header is missing")
                    data.extend(chunk)
            return {"command": command, "declared_payload_bytes": db_payload_header(bytes(data)),
                    "terminated_after_header": True, "maximum_probe_seconds": 5}
        finally:
            child.kill()
            child.wait(timeout=5)


def isolated_container_command(name, inputs, runner, nonce=None):
    command = ["docker", "create", "--name", name, "--pull", "never", "--platform", "linux/amd64",
               "--network", "none", "--read-only", "--no-healthcheck", "--workdir", WORK_DIR, "--cap-drop", "ALL",
               "--security-opt", "no-new-privileges=true", "--user", "65532:65532",
               "--cpus", "2", "--memory", "8g", "--memory-swap", "8g", "--pids-limit", "64",
               "--tmpfs", "/work:rw,noexec,nosuid,nodev,size=6g,mode=1777",
               "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=128m,mode=1777"]
    if nonce is not None:
        command += ["--label", "org.dollhousemcp.scanner-owner=" + nonce]
    for source, target in [("grype", "grype"), (GRYPE_CONFIG, GRYPE_CONFIG),
                           (DATABASE_ARCHIVE, DATABASE_ARCHIVE), (IMAGE_ARCHIVE, IMAGE_ARCHIVE),
                           (OFFLINE_RUNNER, OFFLINE_RUNNER)]:
        command += ["--mount", f"type=bind,src={inputs / source},dst=/inputs/{target},readonly"]
    env = scanner_environment({}, Path(WORK_DIR))
    env.update(PATH="/usr/local/bin:/usr/bin:/bin", HOME="/work/home", TMPDIR="/work/tmp")
    return command + ["--entrypoint", "/usr/bin/env", runner["execution_reference"], "-i"] + [
        f"{key}={value}" for key, value in sorted(env.items())
    ] + ["/usr/local/bin/node", "/inputs/grype-offline-runner.mjs"]


def isolation_evidence(value, inputs, runner):
    host = value["HostConfig"]
    mounts = value["Mounts"]
    targets = {"/inputs/" + name for name in ["grype", GRYPE_CONFIG, DATABASE_ARCHIVE, IMAGE_ARCHIVE, OFFLINE_RUNNER]}
    plan = isolated_container_command("review-only", inputs, runner)
    expected_command = plan[plan.index(runner["execution_reference"]) + 1:]
    expected_tmpfs = {WORK_DIR: "rw,noexec,nosuid,nodev,size=6g,mode=1777",
                      "/tmp": "rw,noexec,nosuid,nodev,size=128m,mode=1777"}
    expected_manifest = runner.get("archive", {}).get("manifest_descriptor")
    actual_manifest = value.get("ImageManifestDescriptor")
    if expected_manifest and (not actual_manifest or any(
            actual_manifest.get(key) != expected_manifest.get(key) for key in ["digest", "mediaType", "size"])):
        raise ValueError("Container selected manifest differs from the verified runner graph")
    if (value["Image"] != runner["container_image_id"] or value["Config"]["Image"] != runner["execution_reference"] or value["Config"]["User"] != "65532:65532" or
            host["NetworkMode"] != "none" or host["ReadonlyRootfs"] is not True or host["Privileged"] or
            host.get("CapDrop") != ["ALL"] or "no-new-privileges=true" not in host.get("SecurityOpt", []) or
            host["NanoCpus"] != 2000000000 or host["Memory"] != CONTAINER_MEMORY_BYTES or
            host["MemorySwap"] != CONTAINER_MEMORY_BYTES or host["PidsLimit"] != 64 or
            host.get("Tmpfs") != expected_tmpfs or host.get("CapAdd") or
            host.get("PidMode") or host.get("Devices") or host.get("DeviceRequests") or
            value["Config"]["WorkingDir"] != WORK_DIR or
            value["Config"].get("Healthcheck", {}).get("Test") != ["NONE"] or
            value["Config"]["Entrypoint"] != ["/usr/bin/env"] or value["Config"]["Cmd"] != expected_command or
            {m["Destination"] for m in mounts} != targets or len(mounts) != len(targets) or
            any(m["Type"] != "bind" or m["RW"] is not False or
                m["Source"] != str(inputs / Path(m["Destination"]).name) for m in mounts)):
        raise ValueError("Actual container isolation does not match the owned offline plan")
    return {"runner_ref": RUNNER_REF, "runner_container_image_id": value["Image"],
            "runner_execution_reference": value["Config"]["Image"], "runner_manifest_descriptor": actual_manifest, "user": value["Config"]["User"],
            "working_dir": value["Config"]["WorkingDir"], "healthcheck": value["Config"]["Healthcheck"],
            "entrypoint": value["Config"]["Entrypoint"], "command": value["Config"]["Cmd"],
            "host_config": {key: host[key] for key in ["NetworkMode", "ReadonlyRootfs", "Privileged", "CapDrop", "SecurityOpt", "NanoCpus", "Memory", "MemorySwap", "PidsLimit", "Tmpfs"]},
            "mounts": mounts}


def cleanup_owned_scanner(owner, inputs, runner, expected_id=None):
    """Resolve one exact name; ambiguity never authorizes removal."""
    report = {"status": "UNKNOWN", "owned_name": owner["name"], "removal_invoked": False, "receipts": []}
    def call(command, timeout):
        status, out, err, error = bounded_process(command, timeout, 1024 * 1024, stderr_maximum=32768)
        report["receipts"].append({"command": command, "timeout_seconds": timeout, "exit_code": status,
                                   "capture_error": error, "stdout_sha256": hashlib.sha256(out).hexdigest(),
                                   "stderr": err.decode("utf-8", "replace")})
        return status, out
    try:
        status, raw = call(["docker", "inspect", owner["name"]], 10)
        if status != 0: raise ValueError("Exact owned-name resolve failed; late or missing create remains unknown")
        values = json.loads(raw)
        if not isinstance(values, list) or len(values) != 1: raise ValueError("Ambiguous owned-name resolve")
        value = values[0]; resolved_id = value.get("Id", "")
        if not re.fullmatch(r"[a-f0-9]{64}", resolved_id): raise ValueError("Invalid full container ID")
        if expected_id and resolved_id != expected_id: raise ValueError("Create receipt ID mismatch")
        if value.get("Name") != "/" + owner["name"] or value.get("Config", {}).get("Labels", {}).get("org.dollhousemcp.scanner-owner") != owner["nonce"]:
            raise ValueError("Owned name or nonce mismatch")
        if (runner.get("index_digest") != RUNNER_REF.removeprefix("node@") or
            runner.get("manifest_digest") != "sha256:c83040f7e24bacea68e58a0b96a484ba430bf24abb2973eab7ba4701144b7b63" or
            runner.get("config_digest") != RUNNER_CONFIG_DIGEST):
            raise ValueError("Runner graph mismatch")
        report["verified_identity"] = isolation_evidence(value, inputs, runner)
        report["resolved_id"] = resolved_id; report["removal_invoked"] = True
        status, _ = call(["docker", "rm", "--force", "--volumes", resolved_id], 20)
        if status != 0: raise ValueError("Verified owned-ID removal failed")
        report["status"] = "verified-owned-container-removed"
    except Exception as error:
        report["reason"] = str(error)
    return report


def collect_process_chunk(event, chunk, ready, child, buffers, sink, count, maximum, stderr_maximum):
    if not chunk:
        ready.unregister(event.fileobj)
    elif event.data == 1 and stderr_maximum is not None and len(buffers[1]) + len(chunk) > stderr_maximum:
        child.kill(); return count, "stderr exceeds bounded capture size"
    elif count + len(chunk) > maximum:
        child.kill(); return count, "combined stdout/stderr exceeds bounded capture size"
    else:
        count += len(chunk)
        if sink and event.data == 0: sink.write(chunk)
        else: buffers[event.data].extend(chunk)
    return count, None


def bounded_process(command, timeout, maximum=64 * 1024 * 1024, stdout_path=None, stderr_maximum=None):
    buffers = [bytearray(), bytearray()]
    error = None; count = 0
    limit = time.monotonic() + timeout
    with (stdout_path.open("wb") if stdout_path else contextlib.nullcontext(None)) as sink, \
            subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE) as child:
        with selectors.DefaultSelector() as ready:
            ready.register(child.stdout, selectors.EVENT_READ, 0)
            ready.register(child.stderr, selectors.EVENT_READ, 1)
            while ready.get_map():
                remaining = limit - time.monotonic()
                if remaining <= 0:
                    error = "process deadline exceeded"; child.kill(); break
                for event, _ in ready.select(min(remaining, 1)):
                    chunk = os.read(event.fd, 65536)
                    count, error = collect_process_chunk(event, chunk, ready, child, buffers, sink, count, maximum, stderr_maximum)
                    if error: break
                if error: break
            try: child.wait(timeout=max(0.1, limit - time.monotonic()))
            except subprocess.TimeoutExpired:
                error = "process deadline exceeded"; child.kill(); child.wait()
        return (None if error else child.returncode, bytes(buffers[0]), bytes(buffers[1]), error)


def persist_scanner_envelope(stdout, status, reports):
    envelope = json.loads(stdout)
    if envelope.get("kind") != "grype-offline-envelope-v1" or envelope.get("exit_code") != status:
        raise ValueError("Offline scanner output is missing or incomplete")
    for filename, data in envelope["files"].items():
        if not re.fullmatch(r"[a-z-]+[.](?:json|stdout|stderr)", filename) or not isinstance(data, str):
            raise ValueError("Unexpected offline scanner output file")
        (reports / filename).write_text(data)
    return status if status in (0, 2) else 1

def execute_owned_scanner(name, nonce, inputs, runner, run, reports, provenance, deadline):
    container = None
    command = isolated_container_command(name, inputs, runner, nonce)
    owner = {"name": name, "nonce": nonce, "runner": runner, "create_command": command}
    (reports / "scanner-owned-intent.json").write_text(json.dumps(owner, indent=2))
    attempted = False
    if deadline - time.monotonic() < 125:
        raise ValueError("Insufficient bounded job budget; no scanner container will be created")
    try:
        attempted = True
        status, stdout = run(command, "container-create", 30)
        receipt = stdout.decode("ascii", "replace").strip()
        container = receipt if re.fullmatch(r"[a-f0-9]{64}", receipt) else None
        if status != 0 or not container: raise ValueError("Unable to obtain exact owned scanner create receipt")
        status, stdout = run(["docker", "inspect", container], "container-inspect", 30, retain_stdout=False)
        if status != 0: raise ValueError("Unable to inspect actual scanner isolation")
        # Persist only selected isolation fields; never image environment/credentials.
        inspected = json.loads(stdout)
        if (not isinstance(inspected, list) or len(inspected) != 1 or inspected[0].get("Id") != container or
                inspected[0].get("Name") != "/" + name or
                inspected[0].get("Config", {}).get("Labels", {}).get("org.dollhousemcp.scanner-owner") != nonce):
            raise ValueError("Scanner inspection ownership mismatch")
        provenance["isolation"] = isolation_evidence(inspected[0], inputs, runner)
        status, stdout = run(["docker", "start", "--attach", container], "container-start", 120)
        return persist_scanner_envelope(stdout, status, reports)
    finally:
        cleanup = cleanup_owned_scanner(owner, inputs, runner, container) if attempted else {"status": "not-attempted"}
        try:
            (reports / "scanner-cleanup.json").write_text(json.dumps(cleanup, indent=2))
            (reports / "offline-provenance.json").write_text(json.dumps(provenance, indent=2))
        except OSError:
            print(json.dumps({"status": "incomplete-summary-persistence", "cleanup": {k: cleanup.get(k) for k in ("status", "owned_name", "resolved_id", "removal_invoked", "reason")}}), file=sys.stderr, flush=True)
            raise
        if attempted and cleanup["status"] != "verified-owned-container-removed":
            raise ValueError("Owned scanner cleanup is UNKNOWN; inspect retained receipt")


def scanner_source_paths():
    """Source-controlled inputs come from this script's checkout, never caller CWD."""
    root = Path(__file__).resolve().parent.parent
    return root, root / '.github/grype-image-scan.yaml', root / 'scripts/grype-offline-runner.mjs', root / '.github/grype-runner-reference'


def select_scanner_target(supplied, args, source_root, approved_target, inspect_image):
    retained = all(supplied)
    if retained:
        record, _ = validate_intake(args.retained_intake, args.intake_sha256, args.retained_archive,
                                                args.scanner_head, args.scanner_tree, os.environ.get('GITHUB_SHA'), source_root, approved_target)
        target = {"store_id": record['store_id'], "architecture": record['platform'].split('/')[1], "os": "linux"}
        image_id = target['store_id']
        target_descriptor = record['descriptor']
    else:
        target = inspect_image("dollhousemcp:latest-linux-amd64", "target-inspect")
        if not target or target["architecture"] != "amd64" or target["os"] != "linux":
            raise ValueError("The exact job-built linux/amd64 target is unavailable")
        image_id = target["store_id"]
        target_descriptor = target["descriptor"]
    return retained, target, image_id, target_descriptor

def prepare_offline_inputs(inputs, reports, scanner_config, offline_runner, runner_reference, run, inspect_image, save_verified):
    binary_archive = inputs / ARCHIVE_NAME
    binary_receipt = download(ARCHIVE_URL, binary_archive, 100 * 1024 * 1024, ARCHIVE_SHA256)
    (reports / "scanner-download.json").write_text(json.dumps(binary_receipt, indent=2))
    extract_verified_binary(binary_archive, inputs / "grype")
    (inputs / "grype").chmod(0o555)
    download(DB_MANIFEST_URL, reports / "database-manifest.json", 1024 * 1024)
    manifest = json.loads((reports / "database-manifest.json").read_text())
    url, checksum = database_manifest(manifest, datetime.datetime.now(datetime.timezone.utc))
    db_receipt = download(url, inputs / DATABASE_ARCHIVE, 1024 * 1024 * 1024, checksum)
    (reports / "database-download.json").write_text(json.dumps(db_receipt, indent=2))
    status, _ = run(["/usr/bin/zstd", "--version"], "db-payload-tool-version", 5)
    if status != 0: raise ValueError("Existing system zstd is unavailable; DB payload cannot be admitted")
    payload = database_payload_bytes(inputs / DATABASE_ARCHIVE)
    (reports / "database-payload-probe.json").write_text(json.dumps(payload, indent=2))
    for source, target in [(scanner_config, GRYPE_CONFIG),
                           (offline_runner, OFFLINE_RUNNER)]:
        shutil.copyfile(source, inputs / target)
    selected_runner = inspect_image(RUNNER_REF, "runner-inspect")
    if selected_runner is None:
        status, _ = run(["docker", "pull", "--platform", "linux/amd64", RUNNER_REF], "runner-pull", 120)
        if status != 0: raise ValueError("Exact protected runner base is unavailable")
        selected_runner = inspect_image(RUNNER_REF, "runner-inspect-after-pull")
    if not selected_runner: raise ValueError("Unable to inspect exact runner reference")
    runner_graph = save_verified(RUNNER_REF, selected_runner, "runner")
    runner = verify_fixed_runner(runner_graph, runner_reference)
    (reports / "runner-reference-identity.json").write_text(json.dumps(runner, indent=2))
    return payload, binary_receipt, manifest, db_receipt, runner

def confirm_target_archive(root, image_id, target_graph, target_descriptor, target, args, retained, admitted_hash):
    final_graph, archive_hash = verify_trusted_image(root, "target", image_id, TARGET_MAX_BYTES, target_descriptor, include_hash=True,
                                                      platform="linux/" + target["architecture"],
                                                      expected_source=args.target_source if retained else None)
    if final_graph != target_graph or archive_hash != admitted_hash:
        raise ValueError("Target archive identity or admitted bytes changed before scanner creation")
    return archive_hash


def save_verified_archive(reference, selected, label, run, reports, inputs, archive_hashes):
    destination = inputs / (IMAGE_ARCHIVE if label == "target" else "runner.tar")
    status, _ = run(["docker", "image", "save", reference], label + "-save", 180,
                    stdout_path=destination, maximum=TARGET_MAX_BYTES + 128 * 1024 ** 2)
    if status != 0:
        raise ValueError(label + " archive export exceeded budget or failed; inspect export receipt")
    observations = {**selected, "archive_bytes": destination.stat().st_size}
    (reports / (label + "-archive-observations.json")).write_text(json.dumps(observations, indent=2))
    try:
        if label == "target":
            evidence, archive_hashes[label] = verify_trusted_image(inputs.parent, label, selected["store_id"], TARGET_MAX_BYTES, selected["descriptor"], include_hash=True)
        else:
            evidence = verify_trusted_image(inputs.parent, label, selected["store_id"], TARGET_MAX_BYTES, selected["descriptor"])
    except Exception as error:
        (reports / (label + "-archive-verification-failure.json")).write_text(json.dumps({
            **observations, "unpacked_admission_cap_bytes": TARGET_MAX_BYTES,
            "complete_graph_verified": False, "error": str(error)}, indent=2))
        raise
    (reports / (label + "-archive-identity.json")).write_text(json.dumps(evidence, indent=2))
    return evidence


def scanner_operations(reports, inputs, deadline, receipts, archive_hashes):
    def run(command, name, timeout=180, retain_stdout=True, stdout_path=None, maximum=64 * 1024 * 1024):
        if name != "container-cleanup":
            timeout = min(timeout, max(1, int(deadline - time.monotonic())))
        started = datetime.datetime.now(datetime.timezone.utc).isoformat()
        status, stdout, stderr, capture_error = bounded_process(command, timeout, maximum, stdout_path)
        if retain_stdout: (reports / (name + ".stdout")).write_bytes(stdout)
        (reports / (name + ".stderr")).write_bytes(stderr)
        receipts[name] = {"command": command, "started_utc": started, "exit_code": status,
                          "finished_utc": datetime.datetime.now(datetime.timezone.utc).isoformat(), "timeout_seconds": timeout, "capture_error": capture_error, "capture_max_bytes": maximum, "streamed_archive_bytes": stdout_path.stat().st_size if stdout_path else None}
        (reports / (name + "-receipt.json")).write_text(json.dumps(receipts[name], indent=2))
        return status, stdout

    def inspect_image(reference, label):
        status, stdout = run(["docker", "image", "inspect", reference], label, 30, retain_stdout=False)
        if status != 0: return None
        value = json.loads(stdout)[0]
        selected = {"store_id": value["Id"], "descriptor": value.get("Descriptor"),
                    "architecture": value.get("Architecture"), "os": value.get("Os"),
                    "inspect_size_hint_bytes": value.get("Size")}
        (reports / (label + "-selected.json")).write_text(json.dumps(selected, indent=2))
        return selected

    def save_verified(reference, selected, label):
        return save_verified_archive(reference, selected, label, run, reports, inputs, archive_hashes)

    return run, inspect_image, save_verified

def main():
    source_root, scanner_config, offline_runner, runner_reference = scanner_source_paths()
    parser = argparse.ArgumentParser()
    parser.add_argument('root')
    parser.add_argument('--retained-intake')
    parser.add_argument('--intake-sha256')
    parser.add_argument('--scanner-head')
    parser.add_argument('--scanner-tree')
    parser.add_argument('--target-source')
    parser.add_argument('--target-tree')
    parser.add_argument('--target-run-id')
    parser.add_argument('--target-attempt', type=int)
    parser.add_argument('--runtime-receipt-sha256')
    parser.add_argument('--retained-archive')
    args = parser.parse_args()
    supplied = [args.retained_intake, args.intake_sha256, args.scanner_head, args.scanner_tree, args.retained_archive, args.target_source, args.target_tree, args.target_run_id, args.target_attempt, args.runtime_receipt_sha256]
    if any(supplied) and not all(supplied): raise ValueError('Complete retained intake arguments required')
    approved_target = {'source': args.target_source, 'tree': args.target_tree, 'run_id': args.target_run_id, 'attempt': args.target_attempt, 'runtime_receipt_sha256': args.runtime_receipt_sha256}
    root = trusted_work_root(args.root, create=True)
    reports, inputs = prepare_scanner_output(root)
    receipts = {}; archive_hashes = {}
    deadline = time.monotonic() + 240

    run, inspect_image, save_verified = scanner_operations(reports, inputs, deadline, receipts, archive_hashes)

    retained, target, image_id, target_descriptor = select_scanner_target(supplied, args, source_root, approved_target, inspect_image)
    memory = {line.split(":", 1)[0]: int(line.split()[1]) * 1024
              for line in Path("/proc/meminfo").read_text().splitlines() if line.startswith(("MemTotal:", "MemAvailable:"))}
    disk_free = shutil.disk_usage(root).free
    (reports / "host-capacity-observation.json").write_text(json.dumps({
        **target, "inspect_size_is_not_admission_size": True,
        "host_total_memory_bytes": memory["MemTotal"], "host_available_memory_bytes": memory["MemAvailable"],
        "disk_free_bytes": disk_free, "required_available_memory_bytes": CONTAINER_MEMORY_BYTES + HOST_MEMORY_HEADROOM_BYTES,
    }, indent=2))
    # Admit worst-case bounded export first; later replace with cryptographically counted layer bytes.
    capacity_admission(TARGET_MAX_BYTES, memory["MemAvailable"], disk_free)

    if retained:
        record, target_graph = validate_intake(args.retained_intake, args.intake_sha256, args.retained_archive,
                                                args.scanner_head, args.scanner_tree, os.environ.get('GITHUB_SHA'), source_root, approved_target, stage=True)
        (reports / "target-archive-identity.json").write_text(json.dumps(target_graph, indent=2))
        admitted_hash = record["archive_sha256"]
    else:
        target_graph = save_verified(image_id, target, "target")
        admitted_hash = archive_hashes["target"]
    admission = capacity_admission(target_graph["unpacked_layer_bytes"], memory["MemAvailable"], shutil.disk_usage(root).free)
    admission["host_total_memory_bytes"] = memory["MemTotal"]
    (reports / "capacity-admission.json").write_text(json.dumps(admission, indent=2))
    payload, binary_receipt, manifest, db_receipt, runner = prepare_offline_inputs(inputs, reports, scanner_config, offline_runner, runner_reference, run, inspect_image, save_verified)
    for path in inputs.iterdir():
        if path.name != "grype": path.chmod(0o444)
    image_archive_hash = confirm_target_archive(root, image_id, target_graph, target_descriptor, target, args, retained, admitted_hash)
    provenance = {"capacity_admission": admission, "database_payload": payload, "scanner_archive": binary_receipt,
                  "database": {**db_receipt, "manifest": manifest}, "target": target_graph,
                  "image_archive_sha256": image_archive_hash, "runner": runner}
    return execute_owned_scanner("beta-offline-scan-" + uuid.uuid4().hex[:12], uuid.uuid4().hex,
                                 inputs, runner, run, reports, provenance, deadline)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        if len(sys.argv) > 1:
            try:
                root = trusted_work_root(sys.argv[1])
                write_failure_report(root, {
                    "error": str(error),
                    "timestamp_utc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                    "status": "unavailable; no clean image-security claim",
                })
            except (ValueError, OSError):
                pass
        print(str(error), file=sys.stderr)
        sys.exit(1)
