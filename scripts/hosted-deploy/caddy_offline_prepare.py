"""Stop one verified proxy and create an offline clone preparation receipt.

This action deliberately leaves ingress closed. It neither replaces the proxy nor
creates a completed deployment or a recovery source bundle.
"""
import json
import hashlib
import os
from pathlib import Path
import sys

SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))
sys.dont_write_bytecode = True
from caddy_bundle_identity import bundle_identity
from caddy_clone_action import STOP_FENCE, acquire_lock, capture_profile, clone_locked, docker_run, validate_request
from caddy_image_admission import REFERENCE, qualify
from caddy_prepared_action import verify as verify_prepared_action
from caddy_recovery_receipt import read_current_caddyfile
from caddy_service_guard import unique_proxy
from caddy_transition_state import read_state
from caddy_unchanged_action import no_other_writers
from caddy_volume_guard import overlapping
from caddy_volume_migration import check_local_daemon, inspect_one, inspect_volumes, require_helper_image
from image_scan_intake import unique_object


def proxy_boot(run, identifier, running):
    proxy = inspect_one(run, 'container', identifier)
    state = proxy.get('State')
    if proxy.get('Id') != identifier or not isinstance(state, dict):
        raise ValueError('proxy identity or state is unavailable')
    if state.get('Running') is not running or state.get('Restarting') is not False or state.get('OOMKilled') is not False:
        raise ValueError('proxy lifecycle is not stable')
    started = state.get('StartedAt')
    restarts = proxy.get('RestartCount')
    if not isinstance(started, str) or not started or type(restarts) is not int or restarts < 0:
        raise ValueError('proxy boot identity is unavailable')
    if not running and state.get('ExitCode') != 0:
        raise ValueError('proxy did not stop cleanly')
    return {'started_at': started, 'restart_count': restarts}


def destination_absent(run, names):
    raw = run(['docker', 'volume', 'ls', '--format', '{{.Name}}'], 15, 1024 * 1024)
    existing = raw.decode('utf-8').splitlines()
    if len(existing) != len(set(existing)) or any(name in existing for name in names):
        raise ValueError('destination volumes must be new and unambiguous')


def require_normal_stop(run, identifier):
    proxy = inspect_one(run, 'container', identifier)
    config = proxy.get('Config')
    if not isinstance(config, dict) or config.get('StopSignal') not in (None, '', 'SIGTERM', 'TERM', '15'):
        raise ValueError('proxy stop signal is unsupported')
    help_text = run(['docker', 'stop', '--help'], 15, 65536).decode('utf-8')
    if '--signal' not in help_text or '--timeout' not in help_text:
        raise ValueError('Docker stop does not support the required signal and timeout controls')


def create_stop_fence(root, identifier, boot, profile):
    directory = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        fd = os.open(STOP_FENCE, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory)
        try:
            profile_bytes = json.dumps(profile, sort_keys=True, separators=(',', ':')).encode('utf-8')
            content = json.dumps({'proxy_id': identifier, 'boot': boot, 'signal': 'SIGTERM',
                                  'profile_sha256': hashlib.sha256(profile_bytes).hexdigest()},
                                 sort_keys=True, separators=(',', ':')).encode('utf-8')
            if os.write(fd, content) != len(content):
                raise ValueError('stop fence write was incomplete')
            os.fsync(fd)
            info = os.fstat(fd)
            os.fsync(directory)
            return (info.st_dev, info.st_ino)
        finally:
            os.close(fd)
    finally:
        os.close(directory)


def clear_stop_fence(root, identity):
    directory = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        current = os.stat(STOP_FENCE, dir_fd=directory, follow_symlinks=False)
        if (current.st_dev, current.st_ino) != identity:
            raise ValueError('stop fence changed; operator reconciliation is required')
        os.unlink(STOP_FENCE, dir_fd=directory)
        os.fsync(directory)
    finally:
        os.close(directory)


def prepare(value, run=docker_run, admit=qualify):
    keys = {'deploy_dir', 'instance', 'data_volume', 'config_volume', 'image'}
    if not isinstance(value, dict) or set(value) != keys:
        raise ValueError('invalid offline preparation request')
    image = value['image']
    if not isinstance(image, str) or not REFERENCE.fullmatch(image):
        raise ValueError('invalid qualified replacement image reference')
    request = {key: value[key] for key in ('deploy_dir', 'instance', 'data_volume', 'config_volume')}
    root = validate_request(request)
    lock = acquire_lock(root)
    try:
        return prepare_locked(value, request, root, run, admit)
    finally:
        os.close(lock)


def prepare_locked(value, request, root, run, admit):
    check_local_daemon(run, os.environ.get('DOCKER_HOST'))
    if read_state(root)['pending'] is not None:
        raise ValueError('an existing Caddy transition requires recovery first')
    require_helper_image(run)
    admission = admit(value['image'])
    source = bundle_identity(root / 'server')
    caddyfile = read_current_caddyfile(root)
    profile = capture_profile(run, root, value['instance'], admit, expected_running=True)
    identifier = profile['container_id']
    boot = proxy_boot(run, identifier, True)
    old_names = [profile['data_volume'], profile['config_volume']]
    new_names = [value['data_volume'], value['config_volume']]
    if len(set(old_names + new_names)) != 4:
        raise ValueError('source and destination volumes must be distinct')
    volumes = inspect_volumes(run, old_names)
    if ((volumes[0]['device'], volumes[0]['inode']) == (volumes[1]['device'], volumes[1]['inode'])
            or overlapping(volumes[0]['mountpoint'], volumes[1]['mountpoint'])):
        raise ValueError('source volume identities overlap')
    no_other_writers(run, identifier, volumes)
    destination_absent(run, new_names)
    require_normal_stop(run, identifier)
    if (unique_proxy(run, value['instance']) != identifier
            or capture_profile(run, root, value['instance'], admit, expected_running=True) != profile
            or proxy_boot(run, identifier, True) != boot
            or inspect_volumes(run, old_names) != volumes
            or bundle_identity(root / 'server') != source or read_current_caddyfile(root) != caddyfile
            or admit(value['image']) != admission):
        raise ValueError('proxy, source or admission changed before stop')
    no_other_writers(run, identifier, volumes)
    destination_absent(run, new_names)
    fence = create_stop_fence(root, identifier, boot, profile)
    # Docker's infinite grace avoids its default SIGKILL fallback. A client
    # timeout is UNKNOWN; never retry or automatically restart the old proxy.
    run(['docker', 'stop', '--signal', 'SIGTERM', '--timeout', '-1', identifier], 60, 65536)
    if (unique_proxy(run, value['instance']) != identifier
            or proxy_boot(run, identifier, False) != boot
            or capture_profile(run, root, value['instance'], admit) != profile
            or inspect_volumes(run, old_names) != volumes
            or bundle_identity(root / 'server') != source or read_current_caddyfile(root) != caddyfile):
        raise ValueError('stopped proxy or source changed before cloning')
    clear_stop_fence(root, fence)
    receipt = clone_locked(request, root, run, admit)
    previous, verified = verify_prepared_action(request, run, admit)
    if receipt != verified:
        raise ValueError('prepared clone receipt changed during verification')
    return {'receipt': str(receipt), 'previous_bundle': str(previous), 'proxy_id': identifier,
            'ingress': 'closed', 'recovery_bundle': 'not-yet-staged'}


def main():
    raw = sys.stdin.buffer.read(65537)
    if len(raw) > 65536:
        raise ValueError('offline preparation request exceeds its size limit')
    request = json.loads(raw, object_pairs_hook=unique_object)
    print(json.dumps(prepare(request), sort_keys=True, separators=(',', ':')))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('Offline Caddy preparation refused; ingress may be closed: ' + str(error), file=sys.stderr)
        sys.exit(1)
