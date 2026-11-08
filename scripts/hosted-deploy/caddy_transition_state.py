"""Protected last-completed and in-flight hosted Caddy transition state."""
import json
import os
from pathlib import Path
import re
import secrets
import stat

from caddy_image_admission import REFERENCE
from caddy_recovery_receipt import MAX_RECORD, SHA256, VOLUME, read_private, unique_object, write_exclusive

PREVIOUS = re.compile(r'server\.prev-[0-9a-f]{32}\Z')


STATE_DIRECTORY = '.caddy-state'
STATE_FILE = 'state.json'


def validate_identity(value, optional=False):
    if optional and value is None:
        return
    if not isinstance(value, dict) or set(value) != {'sha256', 'entries', 'bytes'}:
        raise ValueError('invalid source identity in Caddy state')
    if not isinstance(value['sha256'], str) or not SHA256.fullmatch(value['sha256']):
        raise ValueError('invalid source hash in Caddy state')
    for key in ('entries', 'bytes'):
        if isinstance(value[key], bool) or not isinstance(value[key], int) or value[key] < 0:
            raise ValueError('invalid source size in Caddy state')


def validate_previous(value, root):
    if not isinstance(value, str):
        raise ValueError('invalid previous bundle in Caddy state')
    path = Path(value)
    if path.parent != root or not PREVIOUS.fullmatch(path.name):
        raise ValueError('previous bundle is outside the deployment')


def validate_admission(value, image):
    if not isinstance(value, dict) or value.get('reference') != image:
        raise ValueError('transition admission does not bind its image')
    path = Path(__file__).with_name('caddy-qualified-native-graphs.json')
    approved = json.loads(path.read_bytes(), object_pairs_hook=unique_object)
    platform = value.get('platform')
    if platform not in ('linux/amd64', 'linux/arm64'):
        raise ValueError('transition admission platform is unsupported')
    expected = approved['architectures'][platform.split('/')[1]]
    if value.get('config_digest') != expected['config_digest'] or value.get('diff_ids') != expected['diff_ids']:
        raise ValueError('transition admission differs from qualified Caddy content')
    for key, source in (('tested_checkout', 'tested_checkout'), ('source_head', 'source_head'),
                        ('workflow_run', 'workflow_run'), ('workflow_attempt', 'attempt')):
        if value.get(key) != approved[source]:
            raise ValueError('transition admission source identity differs')
    role = value.get('store_id_role')
    roles = {'config': value.get('config_digest'), 'manifest': value.get('manifest_digest'), 'index': value.get('root_digest')}
    store_id = value.get('store_id')
    if not isinstance(store_id, str) or not re.fullmatch(r'sha256:[0-9a-f]{64}', store_id) or role not in roles or store_id != roles[role]:
        raise ValueError('transition admission store role differs')


def validate_completed(value, root):
    if value is None:
        return
    if not isinstance(value, dict) or set(value) != {'previous', 'receipt', 'receipt_sha256', 'source'}:
        raise ValueError('invalid completed Caddy state')
    validate_previous(value['previous'], root)
    receipt = value['receipt']
    if not isinstance(receipt, str) or Path(receipt).parent.parent != root:
        raise ValueError('invalid receipt path in Caddy state')
    if Path(receipt).parent.name not in ('.caddy-recovery', '.caddy-hardened-recovery') or not re.fullmatch(r'proxy-[0-9a-f]{32}', Path(receipt).name):
        raise ValueError('invalid receipt selection in Caddy state')
    if not isinstance(value['receipt_sha256'], str) or not SHA256.fullmatch(value['receipt_sha256']):
        raise ValueError('invalid receipt hash in Caddy state')
    validate_identity(value['source'])


def validate_transition_phase(value):
    validate_identity(value['staged_source'], optional=True)
    if value['phase'] not in ('prepared', 'admitted', 'staged'):
        raise ValueError('invalid Caddy transition phase')
    if value['phase'] == 'prepared':
        if value['admission'] is not None or value['staged_source'] is not None:
            raise ValueError('unadmitted transition has unexpected evidence')
    else:
        validate_admission(value['admission'], value['image'])
        if (value['phase'] == 'staged') != (value['staged_source'] is not None):
            raise ValueError('transition source phase is inconsistent')


def validate_pending(value, root):
    if value is None:
        return
    fields = {'kind', 'token', 'image', 'volumes', 'previous', 'receipt', 'receipt_sha256', 'source', 'staged_source', 'phase', 'admission'}
    if not isinstance(value, dict) or set(value) != fields or value['kind'] not in ('fresh', 'update', 'rollback'):
        raise ValueError('invalid pending Caddy state')
    if not isinstance(value['token'], str) or not re.fullmatch(r'[0-9a-f]{32}', value['token']):
        raise ValueError('invalid transition token')
    if not isinstance(value['image'], str) or not REFERENCE.fullmatch(value['image']):
        raise ValueError('invalid transition image')
    volumes = value['volumes']
    if not isinstance(volumes, list) or len(volumes) != 2 or not all(isinstance(name, str) and VOLUME.fullmatch(name) for name in volumes) or volumes[0] == volumes[1]:
        raise ValueError('invalid transition volumes')
    validate_transition_phase(value)
    if value['kind'] == 'fresh':
        if any(value[key] is not None for key in ('previous', 'receipt', 'receipt_sha256', 'source')):
            raise ValueError('invalid fresh transition binding')
    else:
        validate_completed({key: value[key] for key in ('previous', 'receipt', 'receipt_sha256', 'source')}, root)


def validate_state(value, root):
    if not isinstance(value, dict) or set(value) != {'schema', 'completed', 'pending'} or value['schema'] != 'caddy-transition-v1':
        raise ValueError('invalid Caddy transition state')
    validate_completed(value['completed'], root)
    validate_pending(value['pending'], root)
    return value


def state_directory(root, create):
    root_stat = root.lstat()
    if not stat.S_ISDIR(root_stat.st_mode) or root_stat.st_uid != os.geteuid() or root_stat.st_mode & 0o022:
        raise ValueError('deployment directory is not protected')
    parent = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        opened = os.fstat(parent)
        if (opened.st_dev, opened.st_ino) != (root_stat.st_dev, root_stat.st_ino):
            raise ValueError('deployment directory changed')
        if create:
            try:
                os.mkdir(STATE_DIRECTORY, 0o700, dir_fd=parent)
                os.fsync(parent)
            except FileExistsError:
                pass
        directory = os.open(STATE_DIRECTORY, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
        info = os.fstat(directory)
        linked = os.stat(STATE_DIRECTORY, dir_fd=parent, follow_symlinks=False)
        if (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o700
                or (info.st_dev, info.st_ino) != (linked.st_dev, linked.st_ino)):
            os.close(directory)
            raise ValueError('Caddy state directory is unsafe')
        return directory
    finally:
        os.close(parent)


def read_state(root):
    root = Path(root)
    path = root / STATE_DIRECTORY
    if not path.exists() and not path.is_symlink():
        return {'schema': 'caddy-transition-v1', 'completed': None, 'pending': None}
    directory = state_directory(root, False)
    try:
        names = os.listdir(directory)
        if names != [STATE_FILE]:
            raise ValueError('Caddy state directory is incomplete or ambiguous')
        data = read_private(directory, STATE_FILE, MAX_RECORD)
        return validate_state(json.loads(data, object_pairs_hook=unique_object), root)
    finally:
        os.close(directory)


def write_state(root, value):
    root = Path(root)
    validate_state(value, root)
    encoded = json.dumps(value, sort_keys=True, separators=(',', ':')).encode()
    if len(encoded) > MAX_RECORD:
        raise ValueError('Caddy state exceeds size limit')
    directory = state_directory(root, True)
    pending = '.state-' + secrets.token_hex(16) + '.pending'
    try:
        names = os.listdir(directory)
        if names not in ([], [STATE_FILE]):
            raise ValueError('Caddy state directory is incomplete or ambiguous')
        if names:
            read_private(directory, STATE_FILE, MAX_RECORD)
        write_exclusive(directory, pending, encoded)
        os.replace(pending, STATE_FILE, src_dir_fd=directory, dst_dir_fd=directory)
        os.fsync(directory)
    finally:
        os.close(directory)


def begin(root, pending):
    state = read_state(root)
    if state['pending'] is not None:
        raise ValueError('an earlier Caddy transition is pending and requires operator recovery')
    state['pending'] = pending
    write_state(root, state)
    return state


def bind_admission(root, token, admission):
    state = read_state(root)
    pending = state['pending']
    if not isinstance(pending, dict) or pending['token'] != token:
        raise ValueError('Caddy transition cannot accept image admission')
    validate_admission(admission, pending['image'])
    if pending['phase'] == 'admitted' and pending['admission'] == admission:
        return
    if pending['phase'] != 'prepared':
        raise ValueError('Caddy transition image admission changed')
    pending['admission'] = admission
    pending['phase'] = 'admitted'
    write_state(root, state)


def mark_staged(root, token, source):
    state = read_state(root)
    pending = state['pending']
    if not isinstance(pending, dict) or pending['token'] != token or pending['phase'] != 'admitted':
        raise ValueError('Caddy transition cannot accept staged source')
    validate_identity(source)
    if pending['kind'] == 'rollback' and source != pending['source']:
        raise ValueError('rollback source differs from the selected bundle')
    pending['staged_source'] = source
    pending['phase'] = 'staged'
    write_state(root, state)


def finish(root, token):
    state = read_state(root)
    pending = state['pending']
    if not isinstance(pending, dict) or pending['token'] != token or pending['phase'] != 'staged':
        raise ValueError('Caddy transition has no verified staged source')
    if pending['kind'] == 'rollback' and pending['staged_source'] != pending['source']:
        raise ValueError('rollback source differs from the selected bundle')
    if pending['kind'] == 'update':
        state['completed'] = {key: pending[key] for key in ('previous', 'receipt', 'receipt_sha256', 'source')}
    elif pending['kind'] == 'rollback':
        state['completed'] = None
    state['pending'] = None
    write_state(root, state)
    return state
