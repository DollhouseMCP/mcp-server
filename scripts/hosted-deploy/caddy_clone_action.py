"""Offline clone of the stopped hosted proxy's two named volumes."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import stat
import sys
import time

SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))
sys.dont_write_bytecode = True
from caddy_bundle_identity import bundle_identity
from caddy_image_admission import scanner, qualify
from caddy_hardened_profile import validate_hardened_profile
from caddy_legacy_profile import legacy_mounts, legacy_network, validate_legacy_profile
from caddy_recovery_receipt import create_receipt, read_current_caddyfile
from caddy_service_guard import unique_proxy
from caddy_volume_guard import refuse_writers
from caddy_volume_migration import (check_local_daemon, check_stopped_proxy, create_destinations,
                                    inspect_one, inspect_volumes, migrate_volumes,
                                    require_helper_image, running_containers)
from image_scan_intake import unique_object

NAME = re.compile(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\Z')
INSTANCE = re.compile(r'[a-z0-9][a-z0-9_-]{0,62}\Z')
STOP_FENCE = '.caddy-offline-stop-issued'


def refuse_stop_fence(root):
    try:
        (root / STOP_FENCE).lstat()
    except FileNotFoundError:
        return
    raise ValueError('an earlier Caddy stop has an unknown outcome; operator reconciliation is required')


def docker_run(command, timeout, maximum):
    started = time.monotonic()
    status, stdout, stderr, error = scanner.bounded_process(command, timeout, maximum, stderr_maximum=65536)
    if status != 0 or error:
        # Emit before run_owned_helper starts cleanup; the protected operator
        # log retains the original outcome even if subsequent cleanup fails.
        # Never log argv: other callers may pass sensitive configuration.
        diagnostic = {'event': 'caddy-docker-refusal', 'operation': command[1] if len(command) > 1 else 'unknown',
                      'exit_code': status, 'error': error, 'timeout_seconds': timeout,
                      'elapsed_seconds': round(time.monotonic() - started, 6),
                      'stderr': stderr.decode('utf-8', errors='replace')}
        encoded = json.dumps(diagnostic, sort_keys=True)
        print(encoded, file=sys.stderr, flush=True)
        raise ValueError('bounded Docker operation failed or is UNKNOWN: ' + encoded)
    return stdout


def validate_request(value):
    if not isinstance(value, dict) or set(value) != {'deploy_dir', 'instance', 'data_volume', 'config_volume'}:
        raise ValueError('invalid clone request')
    root, instance = value['deploy_dir'], value['instance']
    if not isinstance(root, str) or not os.path.isabs(root) or os.path.normpath(root) != root:
        raise ValueError('deployment directory must be absolute')
    if not isinstance(instance, str) or not INSTANCE.fullmatch(instance):
        raise ValueError('invalid deployment instance')
    for key in ('data_volume', 'config_volume'):
        if not isinstance(value[key], str) or not NAME.fullmatch(value[key]):
            raise ValueError('invalid destination volume name')
    if value['data_volume'] == value['config_volume']:
        raise ValueError('destination volumes must be distinct')
    path = Path(root)
    st = path.lstat()
    if not stat.S_ISDIR(st.st_mode) or st.st_uid != os.geteuid() or st.st_mode & 0o022 or path.resolve(strict=True) != path:
        raise ValueError('deployment directory is not protected and canonical')
    return path


def acquire_lock(root, allow_control=False):
    inherited = os.environ.get('HOSTED_CADDY_LOCK_FD')
    if inherited:
        if not inherited.isdigit():
            raise ValueError('invalid inherited deployment lock')
        fd = os.dup(int(inherited))
        expected = (root / '.caddy-deploy.lock').lstat()
        actual = os.fstat(fd)
        if (not stat.S_ISREG(actual.st_mode) or actual.st_uid != os.geteuid() or actual.st_nlink != 1
                or actual.st_mode & 0o077 or (actual.st_dev, actual.st_ino) != (expected.st_dev, expected.st_ino)):
            os.close(fd)
            raise ValueError('inherited deployment lock is unsafe')
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            refuse_stop_fence(root)
            if not allow_control:
                from caddy_transition_state import refuse_control
                refuse_control(root)
        except BaseException:
            os.close(fd)
            raise
        return fd
    flags = os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK
    fd = os.open(root / '.caddy-deploy.lock', flags, 0o600)
    st = os.fstat(fd)
    if not stat.S_ISREG(st.st_mode) or st.st_uid != os.geteuid() or st.st_nlink != 1 or st.st_mode & 0o077:
        os.close(fd)
        raise ValueError('deployment lock is unsafe')
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        refuse_stop_fence(root)
        if not allow_control:
            from caddy_transition_state import refuse_control
            refuse_control(root)
    except BaseException:
        os.close(fd)
        raise
    return fd


def prepare_recovery_directory(root):
    path = root / '.caddy-recovery'
    try:
        path.mkdir(mode=0o700)
    except FileExistsError:
        pass
    st = path.lstat()
    if not stat.S_ISDIR(st.st_mode) or st.st_uid != os.geteuid() or stat.S_IMODE(st.st_mode) != 0o700:
        raise ValueError('recovery root is unsafe')
    return path


def capture_profile(run, root, instance, admit=qualify, expected_running=False):
    selected = unique_proxy(run, instance)
    container = inspect_one(run, 'container', selected)
    state = container.get('State')
    if not isinstance(state, dict) or state.get('Running') is not expected_running:
        raise ValueError('Caddy proxy state differs from the required profile')
    image = inspect_one(run, 'image', container.get('Image'))
    config = container.get('Config')
    if isinstance(config, dict) and config.get('User') == '1001:1001':
        if stat.S_IMODE((root / 'Caddyfile').lstat().st_mode) != 0o644:
            raise ValueError('hardened proxy requires its existing public Caddyfile mode')
        reference = config.get('Image')
        admission = admit(reference)
        names = legacy_mounts(container.get('Mounts'), str(root / 'Caddyfile'))
        ports, _ = legacy_network(container, container.get('HostConfig', {}), instance + '_default')
        return validate_hardened_profile(container, image, admission, instance, str(root / 'Caddyfile'), names, ports)
    return validate_legacy_profile(container, image, str(root / 'Caddyfile'), instance + '_default')


def clone(value, run=docker_run, admit=qualify):
    root = validate_request(value)
    lock = acquire_lock(root)
    try:
        return clone_locked(value, root, run, admit)
    finally:
        os.close(lock)


def clone_locked(value, root, run, admit=qualify):
    docker_host = os.environ.get('DOCKER_HOST')
    check_local_daemon(run, docker_host)
    require_helper_image(run)
    current = root / 'server'
    original = bundle_identity(current)
    caddyfile = read_current_caddyfile(root)
    profile = capture_profile(run, root, value['instance'], admit)
    source_names = [profile['data_volume'], profile['config_volume']]
    targets = [value['data_volume'], value['config_volume']]
    if len(set(source_names + targets)) != 4:
        raise ValueError('source and destination volumes must be distinct')
    sources = inspect_volumes(run, source_names)
    refuse_writers(running_containers(run), sources)
    check_stopped_proxy(run, profile, str(root / 'Caddyfile'), admit)
    token = secrets.token_hex(16)
    previous = root / ('server.prev-' + token)
    if previous.exists() or previous.is_symlink():
        raise ValueError('previous source destination already exists')
    recovery_root = prepare_recovery_directory(root)
    create_destinations(run, source_names, targets, token)
    helper = Path(__file__).with_name('caddy_volume_copy.mjs')
    copied = migrate_volumes(run, profile, sources, targets, token, helper, str(root / 'Caddyfile'), docker_host, admit)
    if bundle_identity(current) != original or read_current_caddyfile(root) != caddyfile:
        raise ValueError('source bundle or Caddyfile changed during cloning')
    record = {'schema': 1, 'bundle': str(previous), 'bundle_identity': original,
              'caddyfile_sha256': hashlib.sha256(caddyfile).hexdigest(), 'profile': profile, 'clone': copied}
    return create_receipt(recovery_root, record, caddyfile)


def main():
    raw = sys.stdin.buffer.read(65537)
    if len(raw) > 65536:
        raise ValueError('clone request exceeds its size limit')
    request = json.loads(raw, object_pairs_hook=unique_object)
    print(clone(request))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('Caddy volume migration refused: ' + str(error), file=sys.stderr)
        for note in getattr(error, '__notes__', ()):
            print(note, file=sys.stderr)
        sys.exit(1)
