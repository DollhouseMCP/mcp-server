"""Bounded local admin access for one immutable running Caddy container.

The module returns configuration data only to its caller; it never logs it.
It does not authorize a transition or mutate a startup file by itself.
"""
import json
import hashlib
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile
import time

SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))
sys.dont_write_bytecode = True
from caddy_clone_action import docker_run
from caddy_image_admission import scanner
from caddy_recovery_receipt import private_directory, read_private, write_exclusive
from caddy_volume_migration import check_local_daemon, docker_json, inspect_one
from image_scan_intake import unique_object

NSENTER = '/usr/bin/nsenter'
CURL = '/usr/bin/curl'
DOCKER = '/usr/bin/docker'
LIMIT = 1024 * 1024
IDENTIFIER = re.compile(r'[0-9a-f]{64}\Z')
PROC = '/proc/'


def system_docker(command, timeout, maximum):
    if not command or command[0] != 'docker':
        raise ValueError('unsupported Docker observation')
    return docker_run([DOCKER, *command[1:]], timeout, maximum)


def executable(path):
    resolved = Path(path).resolve(strict=True)
    info = resolved.stat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022 or not info.st_mode & 0o111:
        raise ValueError('required system control tool is unsafe')
    return path


def bounded_input(command, payload=b'', pass_fds=(), timeout=15, env=None):
    if not isinstance(payload, bytes) or len(payload) > LIMIT:
        raise ValueError('control input exceeds its limit')
    if timeout <= 3:
        raise ValueError('private Caddy control requires a cleanup reserve')
    deadline = time.monotonic() + timeout
    work_deadline = deadline - 3
    with tempfile.TemporaryFile() as source:
        source.write(payload)
        source.seek(0)
        child = subprocess.Popen(command, stdin=source, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                 pass_fds=pass_fds, env=env)
        buffers = [bytearray(), bytearray()]
        primary = None
        error = None
        try:
            error = scanner.capture_process(child, work_deadline, LIMIT, 65536, None, buffers)
            if error or child.returncode != 0 or child.poll() is None:
                raise ValueError('bounded private Caddy control failed or is UNKNOWN')
            return bytes(buffers[0])
        except BaseException as issue:
            primary = issue
            if not scanner.terminate_process(child, deadline):
                issue.add_note('private Caddy control child cleanup is UNKNOWN')
            raise
        finally:
            scanner.close_child_pipes(child, primary, error)


def canonical(data):
    def invalid_constant(_value):
        raise ValueError('invalid JSON number')
    if not isinstance(data, bytes) or len(data) > LIMIT:
        raise ValueError('active Caddy configuration exceeds its limit')
    value = json.loads(data, object_pairs_hook=unique_object, parse_constant=invalid_constant)
    if not isinstance(value, dict):
        raise ValueError('active Caddy configuration must be an object')
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False).encode('utf-8')


def write_bound_contents(fd, directory, expected, replacement, identity, bound_pid):
    if bound_pid is not None:
        if type(bound_pid) is not int or bound_pid <= 0:
            raise ValueError('invalid Caddy PID')
        mounted = os.stat(PROC + str(bound_pid) + '/root/etc/caddy/Caddyfile')
        if identity != (mounted.st_dev, mounted.st_ino):
            raise ValueError('Caddy startup file is not the bound inode')
    current = bytearray()
    while len(current) <= LIMIT:
        chunk = os.read(fd, min(65536, LIMIT + 1 - len(current)))
        if not chunk:
            break
        current.extend(chunk)
    if bytes(current) != expected or os.fstat(fd).st_size != len(expected):
        raise ValueError('Caddy startup file content changed')
    os.lseek(fd, 0, os.SEEK_SET)
    os.ftruncate(fd, 0)
    offset = 0
    while offset < len(replacement):
        count = os.write(fd, replacement[offset:])
        if count <= 0:
            raise ValueError('Caddy startup file write was incomplete')
        offset += count
    os.fsync(fd)
    os.lseek(fd, 0, os.SEEK_SET)
    if os.read(fd, LIMIT + 1) != replacement:
        raise ValueError('Caddy startup file readback differs')
    linked = os.stat('Caddyfile', dir_fd=directory, follow_symlinks=False)
    if (linked.st_dev, linked.st_ino) != identity:
        raise ValueError('Caddy startup file was replaced')
    if bound_pid is not None:
        mounted = os.stat(PROC + str(bound_pid) + '/root/etc/caddy/Caddyfile')
        if identity != (mounted.st_dev, mounted.st_ino):
            raise ValueError('Caddy startup bind changed during write')


def write_startup_file(root, expected, replacement, bound_pid=None):
    """Change only the validated bound inode, preserving it across restart."""
    if any(not isinstance(value, bytes) or len(value) > LIMIT for value in (expected, replacement)):
        raise ValueError('Caddyfile content exceeds its limit')
    root_info = Path(root).lstat()
    if not stat.S_ISDIR(root_info.st_mode) or root_info.st_uid != os.geteuid() or root_info.st_mode & 0o022:
        raise ValueError('deployment directory is unsafe')
    directory = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        opened_root = os.fstat(directory)
        if (opened_root.st_dev, opened_root.st_ino) != (root_info.st_dev, root_info.st_ino):
            raise ValueError('deployment directory changed')
        fd = os.open('Caddyfile', os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        try:
            info = os.fstat(fd)
            linked = os.stat('Caddyfile', dir_fd=directory, follow_symlinks=False)
            identity = (info.st_dev, info.st_ino)
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_nlink != 1
                    or info.st_mode & 0o022 or info.st_size > LIMIT or identity != (linked.st_dev, linked.st_ino)):
                raise ValueError('Caddy startup file is unsafe or changed')
            write_bound_contents(fd, directory, expected, replacement, identity, bound_pid)
            os.fsync(directory)
            return identity
        finally:
            os.close(fd)
    finally:
        os.close(directory)


def snapshot_files(root, token, normal, verification):
    if not isinstance(token, str) or not re.fullmatch(r'[0-9a-f]{32}', token):
        raise ValueError('invalid Caddy verification token')
    if any(not isinstance(value, bytes) or len(value) > LIMIT for value in (normal, verification)):
        raise ValueError('Caddy verification file exceeds its limit')
    root = Path(root)
    parent = root / '.caddy-verification'
    try:
        parent.mkdir(mode=0o700)
    except FileExistsError:
        pass
    root_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(root_fd)
    finally:
        os.close(root_fd)
    parent_fd = private_directory(parent)
    try:
        name = 'control-' + token
        os.mkdir(name, 0o700, dir_fd=parent_fd)
        directory = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent_fd)
        try:
            os.fchmod(directory, 0o700)
            write_exclusive(directory, 'normal', normal)
            write_exclusive(directory, 'verification', verification)
            os.fsync(directory)
        finally:
            os.close(directory)
        os.fsync(parent_fd)
        return {'normal_sha256': hashlib.sha256(normal).hexdigest(),
                'verification_sha256': hashlib.sha256(verification).hexdigest()}
    finally:
        os.close(parent_fd)


def read_snapshots(root, token, hashes):
    if not isinstance(token, str) or not re.fullmatch(r'[0-9a-f]{32}', token):
        raise ValueError('invalid Caddy verification token')
    directory = private_directory(Path(root) / '.caddy-verification' / ('control-' + token))
    try:
        if set(os.listdir(directory)) != {'normal', 'verification'}:
            raise ValueError('Caddy verification snapshot is incomplete or ambiguous')
        normal = read_private(directory, 'normal', LIMIT)
        verification = read_private(directory, 'verification', LIMIT)
    finally:
        os.close(directory)
    if (hashlib.sha256(normal).hexdigest() != hashes.get('normal_sha256')
            or hashlib.sha256(verification).hexdigest() != hashes.get('verification_sha256')):
        raise ValueError('Caddy verification snapshot changed')
    return normal, verification


def validate_system(run=system_docker):
    if sys.platform != 'linux':
        raise ValueError('private Caddy control requires Linux')
    executable(NSENTER)
    executable(CURL)
    executable(DOCKER)
    check_local_daemon(run, os.environ.get('DOCKER_HOST'))
    info = docker_json(run, ['info', '--format', '{{json .}}'])
    if not isinstance(info, dict):
        raise ValueError('private Caddy daemon observation is unavailable')
    options = info.get('SecurityOptions')
    if info.get('OSType') != 'linux' or not isinstance(options, list) or any(
            not isinstance(value, str) or value.split(',', 1)[0] == 'name=rootless' for value in options):
        raise ValueError('private Caddy control requires a rootful Linux daemon')
    help_text = run(['docker', 'stop', '--help'], 15, 65536).decode('utf-8')
    if '--signal' not in help_text or '--timeout' not in help_text:
        raise ValueError('Docker stop does not support the required signal and timeout controls')
    fd = os.open('/proc/self/ns/net', os.O_RDONLY | os.O_CLOEXEC)
    try:
        bounded_input([NSENTER, '--net=/proc/self/fd/' + str(fd), '--', '/usr/bin/true'], pass_fds=(fd,))
    finally:
        os.close(fd)


def boot(run, identifier):
    if not isinstance(identifier, str) or not IDENTIFIER.fullmatch(identifier):
        raise ValueError('invalid Caddy container identity')
    container = inspect_one(run, 'container', identifier)
    state = container.get('State')
    if container.get('Id') != identifier or not isinstance(state, dict) or state.get('Running') is not True:
        raise ValueError('Caddy container is not uniquely running')
    pid, started, restarts = state.get('Pid'), state.get('StartedAt'), container.get('RestartCount')
    if type(pid) is not int or pid <= 0 or not isinstance(started, str) or not started or type(restarts) is not int or restarts < 0:
        raise ValueError('Caddy boot identity is unavailable')
    return {'id': identifier, 'pid': pid, 'started_at': started, 'restart_count': restarts}


class ActiveConfig:
    def __init__(self, identifier, run=system_docker):
        self.run = run
        self.identity = boot(run, identifier)
        self.fd = os.open(PROC + str(self.identity['pid']) + '/ns/net', os.O_RDONLY | os.O_CLOEXEC)
        try:
            namespace = os.fstat(self.fd)
            self.namespace = (namespace.st_dev, namespace.st_ino)
            self.recheck()
        except BaseException:
            os.close(self.fd)
            raise

    def close(self):
        os.close(self.fd)

    def recheck(self):
        if boot(self.run, self.identity['id']) != self.identity:
            raise ValueError('Caddy boot changed during private control')
        path = PROC + str(self.identity['pid']) + '/ns/net'
        opened, current = os.fstat(self.fd), os.stat(path)
        if (opened.st_dev, opened.st_ino) != self.namespace or (current.st_dev, current.st_ino) != self.namespace:
            raise ValueError('Caddy network namespace changed during private control')

    def request(self, method, endpoint, data=b''):
        if (method, endpoint) not in (('GET', '/config/'), ('POST', '/load')):
            raise ValueError('unsupported private Caddy endpoint')
        self.recheck()
        command = [NSENTER, '--net=/proc/self/fd/' + str(self.fd), '--', CURL, '--disable', '--noproxy', '*',
                   '--proto', '=http', '--silent', '--show-error', '--fail', '--max-time', '10',
                   '--max-filesize', str(LIMIT), '--request', method]
        if method == 'POST':
            command.extend(['--header', 'Content-Type: application/json', '--data-binary', '@-'])
        command.append('http://127.0.0.1:2019' + endpoint)
        try:
            result = bounded_input(command, data, (self.fd,))
        except BaseException as error:
            try:
                self.recheck()
            except Exception:
                error.add_note('Caddy control state is UNKNOWN after the failed request')
            raise
        else:
            self.recheck()
        return result

    def adapt(self, caddyfile):
        self.recheck()
        try:
            raw = bounded_input([DOCKER, 'exec', '--interactive', self.identity['id'], '/usr/bin/caddy',
                                 'adapt', '--config', '-', '--adapter', 'caddyfile'], caddyfile)
        except BaseException as error:
            try:
                self.recheck()
            except Exception:
                error.add_note('Caddy control state is UNKNOWN after the failed adaptation')
            raise
        else:
            self.recheck()
        return canonical(raw)

    def read(self):
        return canonical(self.request('GET', '/config/'))

    def load(self, data):
        canonical_data = canonical(data)
        self.request('POST', '/load', canonical_data)
        if self.read() != canonical_data:
            raise ValueError('active Caddy configuration differs after load')

    def stop_after_release_failure(self):
        self.recheck()
        self.run(['docker', 'stop', '--signal', 'SIGTERM', '--timeout', '-1', self.identity['id']], 15, 65536)
        observed = inspect_one(self.run, 'container', self.identity['id'])
        state = observed.get('State')
        if (observed.get('Id') != self.identity['id'] or observed.get('RestartCount') != self.identity['restart_count']
                or not isinstance(state, dict) or state.get('StartedAt') != self.identity['started_at']
                or state.get('Running') is not False or state.get('Restarting') is not False
                or state.get('OOMKilled') is not False or state.get('ExitCode') != 0):
            raise ValueError('post-release proxy stop is UNKNOWN')
