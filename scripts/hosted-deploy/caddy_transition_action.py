"""Durable hosted transition actions, called while the deployment lock is held."""
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import sys

SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))
sys.dont_write_bytecode = True
from caddy_bundle_identity import bundle_identity
from caddy_clone_action import acquire_lock, docker_run, validate_request
from caddy_fresh_recheck import verify as verify_fresh
from caddy_recover_action import recovery_directory, recovery_kind
from caddy_recovery_receipt import MAX_RECORD, private_directory, read_private
from caddy_transition_state import begin, bind_admission, finish, mark_staged, read_state, write_state
from caddy_service_guard import unique_proxy
from caddy_volume_migration import check_local_daemon
from image_scan_intake import unique_object


def receipt_hash(path):
    directory = private_directory(path)
    try:
        return hashlib.sha256(read_private(directory, 'receipt.json', MAX_RECORD)).hexdigest()
    finally:
        os.close(directory)


def sync_root(root):
    directory = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def validate_values(value):
    keys = {'deploy_dir', 'instance', 'data_volume', 'config_volume', 'image', 'previous', 'token', 'admission'}
    if not isinstance(value, dict) or set(value) != keys:
        raise ValueError('invalid Caddy transition request')
    root = validate_request({key: value[key] for key in ('deploy_dir', 'instance', 'data_volume', 'config_volume')})
    return root


def pending_base(value, kind):
    return {'kind': kind, 'token': secrets.token_hex(16), 'image': value['image'],
            'volumes': [value['data_volume'], value['config_volume']], 'previous': None,
            'receipt': None, 'receipt_sha256': None, 'source': None, 'staged_source': None,
            'phase': 'prepared', 'admission': None}


def begin_update(value, root):
    previous = Path(value['previous'])
    if previous.parent != root or not re.fullmatch(r'server\.prev-[0-9a-f]{32}', previous.name):
        raise ValueError('invalid previous source destination')
    identity = bundle_identity(root / 'server')
    matches = []
    for directory, kind in (('.caddy-recovery', 'legacy'), ('.caddy-hardened-recovery', 'hardened')):
        matches.extend(recovery_directory(root / directory, kind, root, previous, identity))
    if len(matches) != 1:
        raise ValueError('exactly one receipt must bind the pending source transition')
    kind, record, path = matches[0]
    names = [value['data_volume'], value['config_volume']]
    if kind == 'legacy' and [item['name'] for item in record['clone']['volumes'][2:]] != names:
        raise ValueError('pending clone volumes differ from the selected volumes')
    if kind == 'hardened':
        profile = record['profile']
        if profile['reference'] != value['image'] or [profile['data_volume'], profile['config_volume']] != names:
            raise ValueError('pending hardened proxy differs from the selected image or volumes')
    pending = pending_base(value, 'update')
    pending.update({'previous': str(previous), 'receipt': str(path), 'receipt_sha256': receipt_hash(path),
                    'source': record['bundle_identity']})
    if kind == 'hardened':
        pending['admission'] = record['profile']['admission']
        pending['phase'] = 'admitted'
    begin(root, pending)
    return pending['token']


def no_running_services(run, instance):
    for service, name in (('dollhousemcp', instance), ('postgres', instance + '-postgres')):
        for field in ('label=com.docker.compose.project=' + instance, 'name=^/' + name + '$'):
            args = ['docker', 'ps', '--all', '--no-trunc', '--filter', field]
            if field.startswith('label='):
                args.extend(['--filter', 'label=com.docker.compose.service=' + service])
            args.extend(['--format', '{{.ID}}'])
            if run(args, 15, 65536).strip():
                raise ValueError('an existing app or PostgreSQL container prevents fresh-install retry')


def check_fresh_absence(value, root, run):
    for name in ('DEPLOYED_REVISION', 'DEPLOYED_AT'):
        path = root / name
        if path.exists() or path.is_symlink():
            raise ValueError('deployment markers forbid a fresh-install retry')
    check_local_daemon(run, os.environ.get('DOCKER_HOST'))
    no_running_services(run, value['instance'])
    if unique_proxy(run, value['instance'], required=False) is not None:
        raise ValueError('a Caddy service prevents a fresh-install retry')
    existing = run(['docker', 'ps', '--all', '--no-trunc', '--filter',
                    'name=^/' + value['instance'] + '-caddy$', '--format', '{{.ID}}'], 15, 65536)
    if existing.strip():
        raise ValueError('a Caddy container prevents a fresh-install retry')


def retry_fresh(value, root, run):
    state = read_state(root)
    pending = state['pending']
    names = [value['data_volume'], value['config_volume']]
    if not isinstance(pending, dict) or pending['kind'] != 'fresh' or pending['image'] != value['image'] or pending['volumes'] != names:
        raise ValueError('pending fresh install differs from this request')
    check_fresh_absence(value, root, run)
    source = root / 'server'
    if source.exists() or source.is_symlink():
        if pending['staged_source'] is None or bundle_identity(source) != pending['staged_source']:
            raise ValueError('unstarted source does not match its pending identity')
        verify_fresh({key: value[key] for key in ('deploy_dir', 'instance', 'data_volume', 'config_volume', 'image')}, run)
    elif pending['staged_source'] is not None:
        raise ValueError('pending staged source is missing; operator recovery is required')
    return pending['token']


def retain_unstarted(root, token):
    state = read_state(root)
    pending = state['pending']
    if not isinstance(pending, dict) or pending['kind'] != 'fresh' or pending['token'] != token or pending['staged_source'] is None:
        raise ValueError('unstarted source is not bound to this fresh transition')
    source = root / 'server'
    if bundle_identity(source) != pending['staged_source']:
        raise ValueError('unstarted source changed before retention')
    destination = root / ('server.unstarted-' + secrets.token_hex(16))
    if destination.exists() or destination.is_symlink():
        raise ValueError('unstarted source destination already exists')
    os.rename(source, destination)
    sync_root(root)
    if bundle_identity(destination) != pending['staged_source']:
        raise ValueError('retained unstarted source identity changed')
    pending['staged_source'] = None
    pending['phase'] = 'admitted'
    write_state(root, state)
    return destination


def complete(root, token):
    state = read_state(root)
    pending = state['pending']
    if not isinstance(pending, dict) or pending['token'] != token or pending['staged_source'] is None:
        raise ValueError('no staged transition matches the completion request')
    if pending['kind'] == 'rollback' and pending['staged_source'] != pending['source']:
        raise ValueError('rollback source differs from the selected bundle')
    if bundle_identity(root / 'server') != pending['staged_source']:
        raise ValueError('current source differs from staged transition')
    if pending['kind'] == 'update':
        previous = Path(pending['previous'])
        if bundle_identity(previous) != pending['source']:
            raise ValueError('previous source differs from transition')
        if receipt_hash(Path(pending['receipt'])) != pending['receipt_sha256']:
            raise ValueError('transition receipt changed')
        kind, _, path = recovery_kind(root, previous)
        if str(path) != pending['receipt'] or kind not in ('legacy', 'hardened'):
            raise ValueError('transition receipt is no longer uniquely selected')
    return finish(root, token)


def selected(root, allow_pending=False):
    state = read_state(root)
    pending = state['pending']
    if pending is not None:
        if not allow_pending or pending['kind'] not in ('update', 'rollback'):
            raise ValueError('a Caddy transition is pending; automatic rollback is refused')
        chosen = {key: pending[key] for key in ('previous', 'receipt', 'receipt_sha256', 'source')}
    else:
        chosen = state['completed']
    if chosen is None:
        raise ValueError('no completed Caddy transition is available')
    previous = Path(chosen['previous'])
    if bundle_identity(previous) != chosen['source'] or receipt_hash(Path(chosen['receipt'])) != chosen['receipt_sha256']:
        raise ValueError('selected previous source or receipt changed')
    _, _, path = recovery_kind(root, previous)
    if str(path) != chosen['receipt']:
        raise ValueError('selected previous receipt is ambiguous')
    return previous


def validate_staged_proxy_source(root, pending, previous):
    if (bundle_identity(previous) != pending['source']
            or bundle_identity(root / 'server') != pending['staged_source']
            or receipt_hash(Path(pending['receipt'])) != pending['receipt_sha256']):
        raise ValueError('pending proxy source or receipt changed')


def validate_unmoved_proxy_source(root, pending):
    if pending['staged_source'] is not None or bundle_identity(root / 'server') != pending['source']:
        raise ValueError('pending proxy source is ambiguous; operator recovery is required')
    if receipt_hash(Path(pending['receipt'])) != pending['receipt_sha256']:
        raise ValueError('pending proxy receipt changed')


def selected_proxy(root):
    state = read_state(root)
    pending = state['pending']
    if isinstance(pending, dict) and pending['kind'] in ('update', 'rollback'):
        previous = Path(pending['previous'])
        if pending['phase'] == 'staged':
            validate_staged_proxy_source(root, pending, previous)
            return '@current'
        if not previous.exists() and not previous.is_symlink():
            validate_unmoved_proxy_source(root, pending)
            return '@current'
    return str(selected(root, allow_pending=True))


def begin_rollback(value, root, admit):
    previous = selected(root)
    state = read_state(root)
    pending = pending_base(value, 'rollback')
    pending.update(state['completed'])
    pending['admission'] = admit(value['image'])
    pending['phase'] = 'admitted'
    if pending['previous'] != str(previous):
        raise ValueError('completed rollback selection changed')
    begin(root, pending)
    return pending['token']


def begin_fresh(value, root, run):
    current = read_state(root)
    if current['completed'] is not None:
        raise ValueError('a previous completed deployment forbids a fresh install')
    for name in ('.caddy-recovery', '.caddy-hardened-recovery', '.caddy-fresh'):
        path = root / name
        if path.exists() or path.is_symlink():
            raise ValueError('existing Caddy evidence forbids an unbound fresh install')
    check_fresh_absence(value, root, run)
    pending = pending_base(value, 'fresh')
    begin(root, pending)
    return pending['token']


def dispatch(action, value, run=docker_run, admit=None):
    root = validate_values(value)
    if action == 'status':
        pending = read_state(root)['pending']
        return 'none' if pending is None else pending['kind']
    if action == 'begin-update':
        return begin_update(value, root)
    if action == 'begin-fresh':
        return begin_fresh(value, root, run)
    if action == 'retry-fresh':
        return retry_fresh(value, root, run)
    if action == 'bind-admission':
        bind_admission(root, value['token'], value['admission'])
        return 'admitted'
    if action == 'retain-unstarted':
        return str(retain_unstarted(root, value['token']))
    if action == 'stage':
        sync_root(root)
        mark_staged(root, value['token'], bundle_identity(root / 'server'))
        return 'staged'
    if action == 'finish':
        complete(root, value['token'])
        return 'complete'
    if action == 'select-rollback':
        return str(selected(root))
    if action == 'select-proxy':
        return selected_proxy(root)
    if action == 'begin-rollback':
        if admit is None:
            from caddy_image_admission import qualify
            admit = qualify
        return begin_rollback(value, root, admit)
    raise ValueError('unsupported Caddy transition action')


def main():
    if len(sys.argv) != 2:
        raise ValueError('one fixed transition action is required')
    raw = sys.stdin.buffer.read(65537)
    if len(raw) > 65536:
        raise ValueError('Caddy transition request exceeds its size limit')
    value = json.loads(raw, object_pairs_hook=unique_object)
    action = sys.argv[1]
    if action in ('status', 'select-rollback', 'select-proxy'):
        print(dispatch(action, value))
        return
    lock = acquire_lock(validate_values(value))
    try:
        print(dispatch(action, value))
    finally:
        os.close(lock)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('Caddy transition refused: ' + str(error), file=sys.stderr)
        for note in getattr(error, '__notes__', ()):
            print(note, file=sys.stderr)
        sys.exit(1)
