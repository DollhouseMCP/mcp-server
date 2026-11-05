"""Validate retained-image identity. This record does not grant execution authority."""
import hashlib
import json
import os
import stat
from contextlib import ExitStack
import re
import subprocess
from pathlib import Path
from image_archive_identity import verify_saved_image

DIGEST = re.compile(r'sha256:[0-9a-f]{64}')
HEX = re.compile(r'[0-9a-f]{64}')
COMMIT = re.compile(r'[0-9a-f]{40}')


MAX_ARCHIVE = 1024**3 + 128 * 1024**2
NO_INSPECT_DESCRIPTOR = object()

def trusted_work_root(argument, *, create=False):
    runner = os.environ.get('RUNNER_TEMP')
    if not runner or not os.path.isabs(runner) or '..' in Path(runner).parts:
        raise ValueError('Absolute trusted RUNNER_TEMP is required')
    expected = os.path.join(runner, 'image-security')
    if not isinstance(argument, (str, os.PathLike)) or os.fspath(argument) != expected or '..' in Path(argument).parts:
        raise ValueError('Work root must be the fixed trusted image-security path')
    canonical_runner = Path(os.path.realpath(runner))
    with TrustedTree(canonical_runner) as tree:
        if create:
            try: os.mkdir('image-security', mode=0o700, dir_fd=tree.workfd)
            except FileExistsError: pass
        tree.directory(tree.workfd, 'image-security')
        tree.check_directories()
    return canonical_runner / 'image-security'


def directory_identity(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_uid)


def stable_identity(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_nlink,
            info.st_size, info.st_mtime_ns, info.st_ctime_ns)


class TrustedTree:
    def __init__(self, work_root):
        self.work_root = work_root; self.stack = ExitStack(); self.links = []

    def __enter__(self):
        try:
            self.rootfd = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            self.stack.callback(os.close, self.rootfd)
            parent = self.rootfd
            for component in self.work_root.parts[1:]: parent = self.directory(parent, component)
            self.workfd = parent
            return self
        except BaseException:
            self.stack.close(); raise

    def __exit__(self, *exc): return self.stack.__exit__(*exc)

    def directory(self, parent, name):
        before = os.stat(name, dir_fd=parent, follow_symlinks=False)
        if (not stat.S_ISDIR(before.st_mode) or before.st_uid not in (0, os.getuid()) or
                (before.st_mode & 0o022 and not (before.st_uid == 0 and before.st_mode & stat.S_ISVTX))):
            raise ValueError('Untrusted intake directory')
        fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
        self.stack.callback(os.close, fd); actual = os.fstat(fd)
        if directory_identity(before) != directory_identity(actual): raise ValueError('Intake directory changed during open')
        self.links.append((parent, name, fd, directory_identity(actual)))
        return fd

    def check_directories(self):
        for parent, name, fd, identity in self.links:
            if directory_identity(os.fstat(fd)) != identity or directory_identity(os.stat(name, dir_fd=parent, follow_symlinks=False)) != identity:
                raise ValueError('Intake directory changed during verification')

    def file(self, parent, name, maximum):
        before = os.stat(name, dir_fd=parent, follow_symlinks=False)
        if (not stat.S_ISREG(before.st_mode) or before.st_uid != os.getuid() or before.st_nlink != 1 or
                before.st_mode & 0o022 or not 0 < before.st_size <= maximum):
            raise ValueError('Untrusted or oversized intake file')
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        stream = self.stack.enter_context(os.fdopen(fd, 'rb')); actual = os.fstat(fd)
        if stable_identity(before) != stable_identity(actual): raise ValueError('Intake file changed during open')
        return stream, stable_identity(actual)

    def check_file(self, stream, identity, parent, name):
        if stable_identity(os.fstat(stream.fileno())) != identity or stable_identity(os.stat(name, dir_fd=parent, follow_symlinks=False)) != identity:
            raise ValueError('Intake file changed during verification')
        self.check_directories()


def fixed_slot(document, archive, work_root, staged):
    for arch in ('amd64', 'arm64'):
        doc = work_root / 'retained' / arch / 'intake.json'
        data = work_root / ('inputs/image.tar' if staged else 'retained/' + arch + '/production-' + arch + '.docker.tar')
        if os.fspath(document) == str(doc) and os.fspath(archive) == str(data): return arch
    raise ValueError('Intake paths must match the trusted fixed slot')


def bounded_hash(stream, expected_size):
    digest = hashlib.sha256(); count = 0
    while count <= expected_size:
        chunk = stream.read(min(65536, expected_size + 1 - count))
        if not chunk: break
        count += len(chunk); digest.update(chunk)
    if count != expected_size: raise ValueError('Archive size changed during bounded read')
    return digest.hexdigest()


def stage_verified(tree, stream, expected_size, expected_hash, identity, parent, name):
    inputs = tree.directory(tree.workfd, 'inputs')
    fd = os.open('image.tar', os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=inputs)
    created = os.fstat(fd); owned = (created.st_dev, created.st_ino, created.st_uid)
    try:
        with os.fdopen(fd, 'w+b') as target:
            digest = hashlib.sha256(); count = 0; stream.seek(0)
            while count <= expected_size:
                chunk = stream.read(min(65536, expected_size + 1 - count))
                if not chunk: break
                count += len(chunk)
                if count > expected_size: raise ValueError('Staged archive exceeds admitted size')
                digest.update(chunk); target.write(chunk)
            target.flush()
            if count != expected_size or digest.hexdigest() != expected_hash: raise ValueError('Staged archive changed')
            tree.check_file(stream, identity, parent, name)
            actual = os.fstat(target.fileno())
            selected = os.stat('image.tar', dir_fd=inputs, follow_symlinks=False)
            if (not stat.S_ISREG(actual.st_mode) or (actual.st_dev, actual.st_ino, actual.st_uid) != owned or
                    actual.st_uid != os.getuid() or actual.st_nlink != 1 or stat.S_IMODE(actual.st_mode) != 0o600 or
                    actual.st_size != expected_size or stable_identity(actual) != stable_identity(selected)):
                raise ValueError('Staged archive identity mismatch')
            target.seek(0)
            if bounded_hash(target, expected_size) != expected_hash: raise ValueError('Staged archive hash mismatch')
            if stable_identity(actual) != stable_identity(os.fstat(target.fileno())) or stable_identity(actual) != stable_identity(os.stat('image.tar', dir_fd=inputs, follow_symlinks=False)):
                raise ValueError('Staged archive changed during verification')
            tree.check_directories()
    except BaseException as error:
        try:
            current = os.stat('image.tar', dir_fd=inputs, follow_symlinks=False)
            if (current.st_dev, current.st_ino, current.st_uid) != owned:
                raise ValueError('Staged cleanup UNKNOWN: destination identity changed') from error
            os.unlink('image.tar', dir_fd=inputs)
        except FileNotFoundError:
            raise ValueError('Staged cleanup UNKNOWN: destination absent') from error
        raise


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result: raise ValueError('Duplicate intake field')
        result[key] = value
    return result


def validate_record(record, approved_target):
    fields = {'schema', 'source', 'tree', 'run_id', 'attempt', 'runtime_receipt_sha256', 'archive_sha256',
              'archive_bytes', 'platform', 'store_id', 'store_id_role', 'root_digest', 'manifest_digest',
              'config_digest', 'diff_ids', 'descriptor'}
    if not isinstance(record, dict) or set(record) != fields or record['schema'] != 'retained-image-intake-v1':
        raise ValueError('Unexpected or missing intake fields')
    if (set(approved_target) != {'source', 'tree', 'run_id', 'attempt', 'runtime_receipt_sha256'} or
        any(record[k] != approved_target[k] for k in approved_target) or
        not COMMIT.fullmatch(record['source']) or not COMMIT.fullmatch(record['tree']) or
        not isinstance(record['run_id'], str) or not re.fullmatch(r'[1-9]\d*', record['run_id'], flags=re.ASCII) or
        type(record['attempt']) is not int or record['attempt'] < 1):
        raise ValueError('Target approved source, run, attempt or receipt mismatch')
    if (not HEX.fullmatch(record['runtime_receipt_sha256']) or not HEX.fullmatch(record['archive_sha256']) or
        type(record['archive_bytes']) is not int or not 0 < record['archive_bytes'] <= 1024**3 + 128 * 1024**2 or
        record['platform'] not in ('linux/amd64', 'linux/arm64') or record['store_id_role'] not in ('index', 'manifest', 'config') or
        not DIGEST.fullmatch(record['store_id']) or not DIGEST.fullmatch(record['config_digest']) or
        any(x is not None and not DIGEST.fullmatch(x) for x in (record['root_digest'], record['manifest_digest'])) or
        not isinstance(record['diff_ids'], list) or not record['diff_ids'] or len(record['diff_ids']) > 256 or
        any(not isinstance(x, str) or not DIGEST.fullmatch(x) for x in record['diff_ids'])):
        raise ValueError('Malformed target identity tuple')
    return record


def validate_checkout(scanner_head, scanner_tree, github_sha, checkout):
    if not COMMIT.fullmatch(scanner_head) or not COMMIT.fullmatch(scanner_tree):
        raise ValueError('Invalid independent scanner source binding')
    if Path(__file__).resolve().parent != Path(checkout).resolve() / 'scripts':
        raise ValueError('Intake helper does not belong to scanner checkout')
    def git(*args):
        return subprocess.run(['git', '-C', str(checkout), *args], check=True, stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE, timeout=10).stdout.decode().strip()
    if github_sha != scanner_head or git('rev-parse', 'HEAD') != scanner_head or git('rev-parse', 'HEAD^{tree}') != scanner_tree:
        raise ValueError('Scanner source head/tree/GITHUB_SHA mismatch')
    if git('status', '--porcelain', '--untracked-files=all'):
        raise ValueError('Scanner checkout has modified or untracked files')


def validate_intake(document, expected_hash, archive, scanner_head, scanner_tree, github_sha, checkout, approved_target, *, staged=False, stage=False, inspect_descriptor=NO_INSPECT_DESCRIPTOR):
    if not HEX.fullmatch(expected_hash) or (staged and stage):
        raise ValueError('Invalid independent intake binding')
    runner = os.environ.get('RUNNER_TEMP') or ''
    work_root = trusted_work_root(os.path.join(runner, 'image-security'))
    arch = fixed_slot(document, archive, work_root, staged)
    with TrustedTree(work_root) as tree:
        retained = tree.directory(tree.workfd, 'retained')
        slot = tree.directory(retained, arch)
        doc, doc_identity = tree.file(slot, 'intake.json', 1024 * 1024)
        raw = doc.read(1024 * 1024 + 1)
        tree.check_file(doc, doc_identity, slot, 'intake.json')
        if len(raw) > 1024 * 1024 or hashlib.sha256(raw).hexdigest() != expected_hash:
            raise ValueError('Intake hash or size mismatch')
        record = validate_record(json.loads(raw, object_pairs_hook=unique_object), approved_target)
        if record['platform'] != 'linux/' + arch: raise ValueError('Intake platform differs from trusted slot')
        validate_checkout(scanner_head, scanner_tree, github_sha, checkout)
        parent = tree.directory(tree.workfd, 'inputs') if staged else slot
        name = 'image.tar' if staged else 'production-' + arch + '.docker.tar'
        stream, identity = tree.file(parent, name, MAX_ARCHIVE)
        if os.fstat(stream.fileno()).st_size != record['archive_bytes']:
            raise ValueError('Archive size mismatch')
        if bounded_hash(stream, record['archive_bytes']) != record['archive_sha256']:
            raise ValueError('Archive hash mismatch')
        tree.check_file(stream, identity, parent, name)
        stream.seek(0)
        graph = verify_saved_image(Path(archive), record['store_id'], 1024**3, record['descriptor'],
                                   platform=record['platform'], expected_source=record['source'], fileobj=stream)
        tree.check_file(stream, identity, parent, name)
        tree.check_file(doc, doc_identity, slot, 'intake.json')
        if inspect_descriptor is not NO_INSPECT_DESCRIPTOR:
            stream.seek(0)
            inspected_graph = verify_saved_image(Path(archive), record['store_id'], 1024**3, inspect_descriptor,
                                                platform=record['platform'], expected_source=record['source'], fileobj=stream)
            tree.check_file(stream, identity, parent, name)
            if inspected_graph != graph: raise ValueError('Materialized image descriptor differs from admitted graph')
        for field in ('store_id', 'store_id_role', 'root_digest', 'manifest_digest', 'config_digest'):
            if graph[field] != record[field]: raise ValueError('Typed archive identity mismatch: ' + field)
        if [x['diff_id'] for x in graph['layers']] != record['diff_ids']:
            raise ValueError('Ordered DiffIDs mismatch')
        if stage:
            stage_verified(tree, stream, record['archive_bytes'], record['archive_sha256'], identity, parent, name)
        tree.check_file(doc, doc_identity, slot, 'intake.json')
        return record, graph
