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
import stat
import shutil
import time
import urllib.parse
import uuid
from image_archive_identity import verify_fixed_runner, RUNNER_INDEX_DIGEST, RUNNER_MANIFEST_DIGEST, RUNNER_CONFIG_DIGEST
from image_scan_intake import (validate_intake, trusted_work_root, verify_trusted_image, prepare_scanner_output,
                               write_failure_report, TrustedTree, bounded_hash, stable_identity, unique_object, validate_intake_arguments, stage_verified)
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
RUNNER_REF = 'node@' + RUNNER_INDEX_DIGEST
SUPPORTED_DB_SCHEMA = "v6.1.10"  # Inspected official manifest and existing validated DB.

GIB = 1024 ** 3
TARGET_MAX_BYTES = GIB
RUNNER_MAX_BYTES = GIB
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
        try: validate_public_url(url, self.hosts)
        except ValueError as error:
            try: fp.close()
            except Exception as cleanup:
                error.add_note('Redirect response close failed: ' + str(cleanup))
            raise
        next_request = super().redirect_request(request, fp, code, message, headers, url)
        if next_request is not None:
            fp.close()
        return next_request


def validate_public_url(url, allowed_hosts=None):
    value = urllib.parse.urlsplit(url)
    if (value.scheme != "https" or value.port not in (None, 443) or value.username or
            value.password or value.hostname not in (allowed_hosts or
            {"github.com", "release-assets.githubusercontent.com", GRYPE_HOST})):
        raise ValueError("Download redirects must remain on the bounded trusted HTTPS origins")


def download_contract(slot, url, maximum, expected):
    validate_public_url(url)
    if slot == 'scanner':
        valid = url == ARCHIVE_URL and maximum == 100 * 1024 * 1024 and expected == ARCHIVE_SHA256
    elif slot == 'manifest':
        valid = url == DB_MANIFEST_URL and maximum == 1024 * 1024 and expected is None
    elif slot == 'database':
        valid = (maximum == 1024 * 1024 * 1024 and isinstance(expected, str) and
                 re.fullmatch(r'[a-f0-9]{64}', expected) is not None and
                 re.fullmatch(r'https://grype[.]anchore[.]io/databases/v6/vulnerability-db_v6[.]1[.]10_[A-Za-z0-9:_-]+[.]tar[.]zst', url) is not None)
    else:
        valid = False
    if not valid: raise ValueError('Download does not match the fixed approved input slot')


def verify_download_readback(output, fd, count, digest, expected):
    output.flush(); written = os.fstat(fd)
    if written.st_size != count: raise ValueError('Downloaded output size differs from receipt')
    output.seek(0); actual_hash = bounded_hash(output, count)
    if actual_hash != digest.hexdigest() or (expected and actual_hash != expected):
        raise ValueError('Downloaded artifact does not match its reviewed checksum or readback')
    if stable_identity(written) != stable_identity(os.fstat(fd)):
        raise ValueError('Downloaded output changed during readback')
    return actual_hash, written


def download_worker(slot, fd, url, maximum, expected):
    """Child writes only the inherited owned FD; no destination path is accepted."""
    download_contract(slot, url, maximum, expected)
    initial = os.fstat(fd)
    if (not stat.S_ISREG(initial.st_mode) or initial.st_uid != os.getuid() or initial.st_nlink != 1 or
            stat.S_IMODE(initial.st_mode) != 0o600 or initial.st_size != 0):
        raise ValueError('Worker destination FD is not a fresh owned regular file')
    request = urllib.request.Request(url, headers={"User-Agent": "dollhouse-offline-scanner-review/2026-10-28"})
    hosts = {GRYPE_HOST} if urllib.parse.urlsplit(url).hostname == GRYPE_HOST else {"github.com", "release-assets.githubusercontent.com"}
    started_utc = datetime.datetime.now(datetime.timezone.utc).isoformat()
    digest = hashlib.sha256(); count = 0
    with os.fdopen(fd, 'r+b', closefd=False) as output, urllib.request.build_opener(TrustedRedirects(hosts)).open(request, timeout=30) as response:
        while chunk := response.read(1024 * 1024):
            count += len(chunk)
            if count > maximum: raise ValueError('Download exceeds bounded size')
            digest.update(chunk); output.write(chunk)
        actual_hash, written = verify_download_readback(output, fd, count, digest, expected)
    return {'kind': 'download-worker-v1', 'url': url, 'sha256': actual_hash, 'bytes': count,
            'started_utc': started_utc, 'finished_utc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
            'identity': list(stable_identity(written))}


def download_receipt(stdout, url, maximum, expected):
    receipt = json.loads(stdout, object_pairs_hook=unique_object)
    keys = {'kind', 'url', 'sha256', 'bytes', 'started_utc', 'finished_utc', 'identity'}
    if (not isinstance(receipt, dict) or set(receipt) != keys or receipt['kind'] != 'download-worker-v1' or
            receipt['url'] != url or type(receipt['bytes']) is not int or not 0 < receipt['bytes'] <= maximum or
            not isinstance(receipt['sha256'], str) or not re.fullmatch(r'[a-f0-9]{64}', receipt['sha256']) or
            (expected and receipt['sha256'] != expected) or
            any(not isinstance(receipt[key], str) or len(receipt[key]) > 64 for key in ('started_utc', 'finished_utc'))):
        raise ValueError('Download worker receipt is missing or inconsistent')
    return receipt


def check_download_identity(fd, parent, name, receipt):
    actual = os.fstat(fd); selected = os.stat(name, dir_fd=parent, follow_symlinks=False)
    if (not stat.S_ISREG(actual.st_mode) or actual.st_uid != os.getuid() or actual.st_nlink != 1 or
            stat.S_IMODE(actual.st_mode) != 0o600 or actual.st_size != receipt['bytes'] or
            list(stable_identity(actual)) != receipt['identity'] or stable_identity(actual) != stable_identity(selected)):
        raise ValueError('Download output identity changed after child completion')


def download_slot(destination):
    runner = os.environ.get('RUNNER_TEMP') or ''
    work = trusted_work_root(os.path.join(runner, 'image-security'))
    slots = {'scanner': ('inputs', ARCHIVE_NAME), 'manifest': ('reports', 'database-manifest.json'),
             'database': ('inputs', DATABASE_ARCHIVE)}
    matches = [key for key, (directory, name) in slots.items() if Path(destination) == work / directory / name]
    if len(matches) != 1: raise ValueError('Download destination is not a fixed trusted input slot')
    slot = matches[0]
    return work, slot, *slots[slot]


def download(url, destination, maximum, expected=None, *, deadline=None):
    """Supervise one trusted download child within the original wall ceiling."""
    work, slot, directory, name = download_slot(destination)
    download_contract(slot, url, maximum, expected)
    end = min(time.monotonic() + 180, deadline if deadline is not None else float('inf'))
    if end <= time.monotonic(): raise ValueError('Scanner deadline exhausted before download')
    with TrustedTree(work) as tree:
        parent = tree.directory(tree.workfd, directory)
        if os.fstat(parent).st_uid != os.getuid(): raise ValueError('Download directory is not runner-owned')
        fd = os.open(name, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
        tree.stack.callback(os.close, fd)
        source = str(Path(__file__).resolve())
        command = [sys.executable, '-E', '-s', '-S', source, '--download-worker', slot, str(fd), url, str(maximum), expected or '-']
        remaining = end - time.monotonic()
        if remaining <= 0: raise ValueError('Scanner deadline exhausted before download child')
        status, stdout, _, capture_error = bounded_process(command, remaining, maximum=65536, stderr_maximum=32768, pass_fds=(fd,))
        if status != 0 or capture_error: raise ValueError('Download worker failed or exceeded its bound: ' + str(capture_error))
        receipt = download_receipt(stdout, url, maximum, expected)
        check_download_identity(fd, parent, name, receipt)
        tree.check_directories()
        if time.monotonic() > end: raise ValueError('Download exceeded its bounded wall deadline')
        return {key: receipt[key] for key in ('url', 'sha256', 'bytes', 'started_utc', 'finished_utc')}


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
    disk_required = target_size + 128 * 1024 ** 2 + RUNNER_MAX_BYTES + 128 * 1024 ** 2 + GIB + 100 * 1024 ** 2 + 64 * 1024 ** 2 + GIB
    if work_required > WORK_TMPFS_BYTES or available_memory < CONTAINER_MEMORY_BYTES + HOST_MEMORY_HEADROOM_BYTES or free_disk < disk_required:
        raise ValueError("Host RAM/disk or bounded work-space prerequisites are insufficient; scanner will not start")
    return {"target_uncompressed_size_bytes": target_size, "target_max_bytes": TARGET_MAX_BYTES, "runner_max_bytes": RUNNER_MAX_BYTES,
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


def read_db_payload_header(child):
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
    return db_payload_header(bytes(data))


def database_payload_bytes(archive):
    # Existing Ubuntu system zstd only; no installation or network/Go execution.
    command = ["/usr/bin/zstd", "--decompress", "--stdout", str(archive)]
    child = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    failure = None
    try:
        try:
            payload = read_db_payload_header(child)
        except BaseException as original:
            try:
                if not terminate_process(child, time.monotonic() + 5): original.add_note('DB probe cleanup UNKNOWN')
            except Exception as cleanup:
                original.add_note('DB probe cleanup UNKNOWN: ' + str(cleanup))
            raise
        if not terminate_process(child, time.monotonic() + 5):
            raise ValueError('DB probe cleanup UNKNOWN')
        return {"command": command, "declared_payload_bytes": payload,
                "terminated_after_header": True, "maximum_probe_seconds": 5}
    except BaseException as original:
        failure = original
        raise
    finally:
        try: child.stdout.close()
        except Exception as cleanup:
            if failure is None: raise
            failure.add_note('DB probe stdout close UNKNOWN: ' + str(cleanup))


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
            runner.get("manifest_digest") != RUNNER_MANIFEST_DIGEST or
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


def capture_process(child, limit, maximum, stderr_maximum, sink, buffers):
    error = None; count = 0
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
            error = error or "process deadline exceeded"
            if not terminate_process(child, limit):
                error += "; child reap UNKNOWN"
    return error


def terminate_process(child, limit):
    try: child.kill()
    except ProcessLookupError: pass
    try: child.wait(timeout=max(0.1, limit - time.monotonic()))
    except subprocess.TimeoutExpired: return False
    return True


def close_child_pipes(child, primary, error):
    failures = []
    def close(pipe):
        try: pipe.close()
        except Exception as issue: failures.append(issue)
    try: close(child.stdout)
    finally: close(child.stderr)
    if failures:
        detail = 'Pipe close UNKNOWN: ' + '; '.join(str(issue) for issue in failures)
        if primary is not None: primary.add_note(detail)
        elif error: error += '; ' + detail
        else: raise ValueError(detail) from failures[0]
    return error


def bounded_process(command, timeout, maximum=64 * 1024 * 1024, stdout_path=None, stderr_maximum=None, pass_fds=()):
    buffers = [bytearray(), bytearray()]
    limit = time.monotonic() + timeout
    with (stdout_path.open("wb") if stdout_path else contextlib.nullcontext(None)) as sink:
        child = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, pass_fds=pass_fds)
        error = None; primary = None
        try:
            try:
                error = capture_process(child, limit, maximum, stderr_maximum, sink, buffers)
            except BaseException as original:
                try:
                    if not terminate_process(child, limit): original.add_note("Child reap UNKNOWN after bounded cleanup")
                except Exception as cleanup:
                    original.add_note("Child cleanup UNKNOWN: " + str(cleanup))
                raise
        except BaseException as active:
            primary = active
            raise
        finally:
            error = close_child_pipes(child, primary, error)
        return (None if error else child.returncode, bytes(buffers[0]), bytes(buffers[1]), error)


def persist_scanner_envelope(stdout, status, reports):
    envelope = json.loads(stdout)
    if envelope.get("kind") != "grype-offline-envelope-v1" or envelope.get("exit_code") != status:
        raise ValueError("Offline scanner output is missing or incomplete")
    labels = ('version', 'help', 'effective-config', 'db-import-help', 'db-import', 'db-status', 'scan')
    allowed = {name + suffix for name in labels for suffix in ('.stdout', '.stderr', '-receipt.json')}
    allowed.update(('failure.json', 'application-image-vulnerabilities.json'))
    if not isinstance(envelope.get('files'), dict) or any(
            name not in allowed or not isinstance(data, str) for name, data in envelope['files'].items()):
        raise ValueError('Unexpected offline scanner output file')
    for filename, data in envelope["files"].items():
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

class FrozenArgumentsError(ValueError):
    pass


def validate_frozen_arguments(manifest_hash, binary_hash, retained):
    values = (manifest_hash, binary_hash)
    if not any(value is not None for value in values): return None
    if not all(isinstance(value, str) and re.fullmatch(r'[a-f0-9]{64}', value) for value in values):
        raise FrozenArgumentsError('Frozen inputs require both SHA256 values and complete retained intake')
    try: validate_intake_arguments(retained, retained[8])
    except ValueError as error: raise FrozenArgumentsError('Frozen inputs require both SHA256 values and complete retained intake') from error
    if not all(retained): raise FrozenArgumentsError('Frozen inputs require both SHA256 values and complete retained intake')
    return {'manifest': manifest_hash, 'binary': binary_hash}


def frozen_copy(root, source_name, maximum, expected, output_dir, output_name, deadline):
    if time.monotonic() >= deadline: raise ValueError('Scanner deadline exhausted before frozen admission')
    started = datetime.datetime.now(datetime.timezone.utc).isoformat()
    with TrustedTree(root) as tree:
        admitted = tree.directory(tree.workfd, 'admitted')
        stream, identity = tree.file(admitted, source_name, maximum)
        if bounded_hash(stream, identity[5], deadline=deadline) != expected: raise ValueError('Frozen input SHA256 mismatch')
        tree.check_file(stream, identity, admitted, source_name)
        stage_verified(tree, stream, identity[5], expected, identity, admitted, source_name,
                       output_dir=output_dir, output_name=output_name, deadline=deadline)
    if time.monotonic() >= deadline: raise ValueError('Scanner deadline exhausted during frozen admission')
    return {'url': None, 'sha256': expected, 'bytes': identity[5], 'started_utc': started,
            'finished_utc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
            'origin': 'frozen-admitted', 'source_slot': source_name}


def extract_frozen_binary(root, expected_binary, deadline):
    with TrustedTree(root) as tree:
        inputs = tree.directory(tree.workfd, 'inputs')
        stream, identity = tree.file(inputs, ARCHIVE_NAME, 100 * 1024 * 1024)
        if bounded_hash(stream, identity[5], deadline=deadline) != ARCHIVE_SHA256: raise ValueError('Frozen Grype archive SHA256 mismatch')
        stream.seek(0)
        with tarfile.open(fileobj=stream, mode='r:gz') as bundle:
            members = [member for member in bundle.getmembers() if member.name == 'grype']
            if len(members) != 1 or not members[0].isfile() or not 0 < members[0].size <= 100 * 1024 * 1024:
                raise ValueError('Expected exactly one bounded regular grype binary')
            fd = os.open('grype', os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=inputs)
            tree.stack.callback(os.close, fd)
            with bundle.extractfile(members[0]) as source, os.fdopen(fd, 'w+b', closefd=False) as output:
                count = 0
                while count < members[0].size:
                    if time.monotonic() >= deadline: raise ValueError('Scanner deadline exhausted during extraction')
                    chunk = source.read(min(65536, members[0].size - count))
                    if not chunk: raise ValueError('Truncated Grype binary')
                    output.write(chunk); count += len(chunk)
                output.flush(); before_readback = stable_identity(os.fstat(fd)); output.seek(0)
                if bounded_hash(output, count, deadline=deadline) != expected_binary: raise ValueError('Frozen Grype binary SHA256 mismatch')
                actual = os.fstat(fd); selected = os.stat('grype', dir_fd=inputs, follow_symlinks=False)
                if (not stat.S_ISREG(actual.st_mode) or actual.st_uid != os.getuid() or actual.st_nlink != 1 or
                        stat.S_IMODE(actual.st_mode) != 0o600 or stable_identity(actual) != before_readback or
                        stable_identity(actual) != stable_identity(selected)):
                    raise ValueError('Frozen Grype binary identity changed')
                tree.check_file(stream, identity, inputs, ARCHIVE_NAME)
                os.fchmod(fd, 0o555)
                final = os.fstat(fd)
                if stat.S_IMODE(final.st_mode) != 0o555 or stable_identity(final) != stable_identity(os.stat('grype', dir_fd=inputs, follow_symlinks=False)):
                    raise ValueError('Frozen Grype binary changed during chmod')
                tree.check_directories()
                if time.monotonic() >= deadline: raise ValueError('Scanner deadline exhausted during extraction')
    return count


def prepare_frozen_inputs(root, hashes, deadline):
    binary = frozen_copy(root, ARCHIVE_NAME, 100 * 1024 * 1024, ARCHIVE_SHA256, 'inputs', ARCHIVE_NAME, deadline)
    binary['binary_bytes'] = extract_frozen_binary(root, hashes['binary'], deadline)
    binary['binary_sha256'] = hashes['binary']
    frozen_copy(root, 'database-manifest.json', 1024 * 1024, hashes['manifest'], 'reports', 'database-manifest.json', deadline)
    with TrustedTree(root) as tree:
        reports = tree.directory(tree.workfd, 'reports')
        stream, identity = tree.file(reports, 'database-manifest.json', 1024 * 1024)
        data = stream.read(identity[5] + 1)
        tree.check_file(stream, identity, reports, 'database-manifest.json')
        if len(data) != identity[5] or hashlib.sha256(data).hexdigest() != hashes['manifest']:
            raise ValueError('Frozen manifest changed')
        manifest = json.loads(data, object_pairs_hook=unique_object)
    url, checksum = database_manifest(manifest, datetime.datetime.now(datetime.timezone.utc))
    database = frozen_copy(root, DATABASE_ARCHIVE, GIB, checksum, 'inputs', DATABASE_ARCHIVE, deadline)
    database['url'] = url  # Provenance origin; origin records that no download occurred.
    return binary, manifest, database


def verify_frozen_mounts(root, hashes, database_sha256, deadline):
    with TrustedTree(root) as tree:
        inputs = tree.directory(tree.workfd, 'inputs')
        for name, maximum, expected in (('grype', 100 * 1024 * 1024, hashes['binary']),
                                        (DATABASE_ARCHIVE, GIB, database_sha256)):
            stream, identity = tree.file(inputs, name, maximum)
            if bounded_hash(stream, identity[5], deadline=deadline) != expected:
                raise ValueError('Frozen mounted input changed before scanner creation')
            tree.check_file(stream, identity, inputs, name)
    if time.monotonic() >= deadline: raise ValueError('Scanner deadline exhausted before scanner creation')


def prepare_offline_inputs(inputs, reports, scanner_config, offline_runner, runner_reference, run, inspect_image, save_verified, deadline, frozen=None):
    if frozen is not None:
        binary_receipt, manifest, db_receipt = prepare_frozen_inputs(inputs.parent, frozen, deadline)
        (reports / "scanner-download.json").write_text(json.dumps(binary_receipt, indent=2))
        (reports / "database-download.json").write_text(json.dumps(db_receipt, indent=2))
    else:
        binary_receipt, manifest, db_receipt = prepare_downloaded_inputs(inputs, reports, deadline)
    status, _ = run(["/usr/bin/zstd", "--version"], "db-payload-tool-version", 5)
    if status != 0: raise ValueError("Existing system zstd is unavailable; DB payload cannot be admitted")
    payload = database_payload_bytes(inputs / DATABASE_ARCHIVE)
    (reports / "database-payload-probe.json").write_text(json.dumps(payload, indent=2))
    for source, target in [(scanner_config, GRYPE_CONFIG), (offline_runner, OFFLINE_RUNNER)]:
        shutil.copyfile(source, inputs / target)
    selected_runner = inspect_image(RUNNER_REF, "runner-inspect")
    if selected_runner is None and frozen is None:
        status, _ = run(["docker", "pull", "--platform", "linux/amd64", RUNNER_REF], "runner-pull", 120)
        if status != 0: raise ValueError("Exact protected runner base is unavailable")
        selected_runner = inspect_image(RUNNER_REF, "runner-inspect-after-pull")
    if not selected_runner: raise ValueError("Unable to inspect exact runner reference")
    runner_graph = save_verified(RUNNER_REF, selected_runner, "runner")
    runner = verify_fixed_runner(runner_graph, runner_reference)
    (reports / "runner-reference-identity.json").write_text(json.dumps(runner, indent=2))
    return payload, binary_receipt, manifest, db_receipt, runner

def prepare_downloaded_inputs(inputs, reports, deadline):
    binary_archive = inputs / ARCHIVE_NAME
    binary_receipt = download(ARCHIVE_URL, binary_archive, 100 * 1024 * 1024, ARCHIVE_SHA256, deadline=deadline)
    (reports / "scanner-download.json").write_text(json.dumps(binary_receipt, indent=2))
    extract_verified_binary(binary_archive, inputs / "grype")
    (inputs / "grype").chmod(0o555)
    download(DB_MANIFEST_URL, reports / "database-manifest.json", 1024 * 1024, deadline=deadline)
    manifest = json.loads((reports / "database-manifest.json").read_text())
    url, checksum = database_manifest(manifest, datetime.datetime.now(datetime.timezone.utc))
    db_receipt = download(url, inputs / DATABASE_ARCHIVE, 1024 * 1024 * 1024, checksum, deadline=deadline)
    (reports / "database-download.json").write_text(json.dumps(db_receipt, indent=2))
    return binary_receipt, manifest, db_receipt


def confirm_target_archive(root, image_id, target_graph, target_descriptor, target, args, retained, admitted_hash):
    final_graph, archive_hash = verify_trusted_image(root, "target", image_id, TARGET_MAX_BYTES, target_descriptor, include_hash=True,
                                                      platform="linux/" + target["architecture"],
                                                      expected_source=args.target_source if retained else None)
    if final_graph != target_graph or archive_hash != admitted_hash:
        raise ValueError("Target archive identity or admitted bytes changed before scanner creation")
    return archive_hash


def save_verified_archive(reference, selected, label, run, reports, inputs, archive_hashes):
    if label not in ('target', 'runner'): raise ValueError('Unknown archive role')
    cap = TARGET_MAX_BYTES if label == 'target' else RUNNER_MAX_BYTES
    destination = inputs / (IMAGE_ARCHIVE if label == "target" else "runner.tar")
    status, _ = run(["docker", "image", "save", reference], label + "-save", 180,
                    stdout_path=destination, maximum=cap + 128 * 1024 ** 2)
    if status != 0:
        raise ValueError(label + " archive export exceeded budget or failed; inspect export receipt")
    observations = {**selected, "archive_bytes": destination.stat().st_size}
    (reports / (label + "-archive-observations.json")).write_text(json.dumps(observations, indent=2))
    try:
        if label == "target":
            evidence, archive_hashes[label] = verify_trusted_image(inputs.parent, label, selected["store_id"], cap, selected["descriptor"], include_hash=True)
        else:
            evidence = verify_trusted_image(inputs.parent, label, selected["store_id"], cap, selected["descriptor"])
    except Exception as error:
        (reports / (label + "-archive-verification-failure.json")).write_text(json.dumps({
            **observations, "unpacked_admission_cap_bytes": cap,
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
    parser.add_argument('--frozen-db-manifest-sha256')
    parser.add_argument('--frozen-grype-binary-sha256')
    args = parser.parse_args()
    supplied = [args.retained_intake, args.intake_sha256, args.scanner_head, args.scanner_tree, args.retained_archive, args.target_source, args.target_tree, args.target_run_id, args.target_attempt, args.runtime_receipt_sha256]
    frozen = validate_frozen_arguments(args.frozen_db_manifest_sha256, args.frozen_grype_binary_sha256, supplied)
    validate_intake_arguments(supplied, args.target_attempt)
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
    payload, binary_receipt, manifest, db_receipt, runner = prepare_offline_inputs(inputs, reports, scanner_config, offline_runner, runner_reference, run, inspect_image, save_verified, deadline, frozen=frozen)
    for path in inputs.iterdir():
        if path.name != "grype": path.chmod(0o444)
    image_archive_hash = confirm_target_archive(root, image_id, target_graph, target_descriptor, target, args, retained, admitted_hash)
    if frozen is not None: verify_frozen_mounts(root, frozen, db_receipt['sha256'], deadline)
    provenance = {"capacity_admission": admission, "database_payload": payload, "scanner_archive": binary_receipt,
                  "database": {**db_receipt, "manifest": manifest}, "target": target_graph,
                  "image_archive_sha256": image_archive_hash, "runner": runner}
    return execute_owned_scanner("beta-offline-scan-" + uuid.uuid4().hex[:12], uuid.uuid4().hex,
                                 inputs, runner, run, reports, provenance, deadline)


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == '--download-worker':
        try:
            if len(sys.argv) != 7: raise ValueError('Malformed download worker arguments')
            result = download_worker(sys.argv[2], int(sys.argv[3]), sys.argv[4], int(sys.argv[5]), None if sys.argv[6] == '-' else sys.argv[6])
            print(json.dumps(result))
            sys.exit(0)
        except Exception as error:
            print(str(error), file=sys.stderr)
            sys.exit(1)
    try:
        sys.exit(main())
    except Exception as error:
        if len(sys.argv) > 1 and not isinstance(error, FrozenArgumentsError):
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
