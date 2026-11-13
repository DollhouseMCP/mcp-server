"""Create and verify two fresh named Caddy volumes by image copy-up."""
import json
import os
from pathlib import Path
import re
import secrets
import sys

SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))
sys.dont_write_bytecode = True
from caddy_clone_action import acquire_lock, docker_run, validate_request
from caddy_image_admission import REFERENCE, qualify
from caddy_recovery_receipt import private_directory, read_private, write_exclusive
from caddy_service_guard import unique_proxy
from caddy_volume_guard import refuse_writers
from caddy_volume_migration import (check_local_daemon, inspect_one, inspect_volumes,
                                    require_helper_image, run_owned_helper, running_containers)
from image_scan_intake import unique_object

ID = re.compile(r'[0-9a-f]{64}\Z')


FRESH_TOKEN_LABEL = 'org.dollhousemcp.caddy-fresh-token'


def fresh_names(run, names, token):
    existing = run(['docker', 'volume', 'ls', '--format', '{{.Name}}'], 15, 1024 * 1024).decode('utf-8').splitlines()
    if any(name in existing for name in names):
        raise ValueError('fresh Caddy volumes must not already exist')
    for name in names:
        returned = run(['docker', 'volume', 'create', '--label',
                        'org.dollhousemcp.caddy-fresh-token=' + token, name], 15, 65536).decode('utf-8').strip()
        if returned != name:
            raise ValueError('fresh volume creation returned an unexpected name')
        labels = inspect_one(run, 'volume', name).get('Labels')
        if not isinstance(labels, dict) or labels.get(FRESH_TOKEN_LABEL) != token:
            raise ValueError('fresh volume ownership is unproven')


def seed_args(image, names, token):
    return ['docker', 'create', '--pull', 'never', '--name', 'dollhouse-caddy-seed-' + token,
            '--label', 'org.dollhousemcp.caddy-fresh-token=' + token,
            '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
            '--user', '1001:1001', '--mount', 'type=volume,src=' + names[0] + ',dst=/data',
            '--mount', 'type=volume,src=' + names[1] + ',dst=/config', image]


def validate_seed_isolation(host, state):
    if not isinstance(host, dict) or host.get('NetworkMode') != 'none' or host.get('ReadonlyRootfs') is not True or set(host.get('CapDrop') or []) != {'ALL'} or host.get('SecurityOpt') != ['no-new-privileges:true']:
        raise ValueError('seed isolation differs from the requested profile')
    if host.get('Privileged') is not False or host.get('AutoRemove') is not False or host.get('RestartPolicy', {}).get('Name') != 'no':
        raise ValueError('seed lifecycle differs from the requested profile')
    if not isinstance(state, dict) or state.get('Running') is not False:
        raise ValueError('seed container must never run')


def inspect_seed(run, selector, image_id, names, token):
    seed = inspect_one(run, 'container', selector)
    config, host, state = seed.get('Config'), seed.get('HostConfig'), seed.get('State')
    identifier = seed.get('Id')
    if not isinstance(identifier, str) or not ID.fullmatch(identifier) or seed.get('Name') != '/dollhouse-caddy-seed-' + token or seed.get('Image') != image_id:
        raise ValueError('seed identity is unproven')
    if not isinstance(config, dict) or not isinstance(config.get('Labels'), dict) or config['Labels'].get(FRESH_TOKEN_LABEL) != token or config.get('User') != '1001:1001':
        raise ValueError('seed ownership is unproven')
    validate_seed_isolation(host, state)
    mounts = seed.get('Mounts')
    if not isinstance(mounts, list) or len(mounts) != 2:
        raise ValueError('seed mounts differ from the request')
    observed = {item.get('Destination'): item for item in mounts if isinstance(item, dict)}
    for index, target in enumerate(('/data', '/config')):
        item = observed.get(target, {})
        if item.get('Type') != 'volume' or item.get('Name') != names[index] or item.get('RW') is not True:
            raise ValueError('seed mounts differ from the request')
    return identifier


def create_seed(run, image, image_id, names, token):
    selector = 'dollhouse-caddy-seed-' + token
    try:
        identifier = run(seed_args(image, names, token), 15, 65536).decode('ascii').strip()
        if inspect_seed(run, identifier, image_id, names, token) != identifier:
            raise ValueError('seed create acknowledgement is inconsistent')
        selector = identifier
    except BaseException as original:
        try:
            identifier = inspect_seed(run, selector, image_id, names, token)
            run(['docker', 'rm', identifier], 10, 65536)
        except Exception as cleanup:
            original.add_note('Seed cleanup is UNKNOWN: ' + str(cleanup))
        raise
    run(['docker', 'rm', selector], 10, 65536)


def write_fresh_receipt(root, record):
    path = root / '.caddy-fresh'
    try:
        path.mkdir(mode=0o700)
    except FileExistsError:
        pass
    parent = private_directory(path)
    try:
        data = json.dumps(record, sort_keys=True, separators=(',', ':')).encode()
        if len(data) > 1024 * 1024:
            raise ValueError('fresh volume receipt exceeds size limit')
        name = 'fresh-' + secrets.token_hex(16) + '.json'
        pending = '.' + name + '.pending'
        write_exclusive(parent, pending, data)
        os.link(pending, name, src_dir_fd=parent, dst_dir_fd=parent, follow_symlinks=False)
        os.unlink(pending, dir_fd=parent)
        os.fsync(parent)
        return path / name
    finally:
        os.close(parent)


def read_fresh_candidate(directory, name):
    if not re.fullmatch(r'fresh-[0-9a-f]{32}\.json', name):
        raise ValueError('unsupported fresh receipt entry')
    data = read_private(directory, name, 1024 * 1024)
    record = json.loads(data, object_pairs_hook=unique_object)
    keys = {'schema', 'instance', 'admission', 'volumes', 'layout', 'token'}
    if not isinstance(record, dict) or set(record) != keys or record['schema'] != 1 or isinstance(record['schema'], bool):
        raise ValueError('invalid fresh volume receipt')
    volumes, token = record['volumes'], record['token']
    if (not isinstance(volumes, list) or len(volumes) != 2 or not all(isinstance(value, dict) for value in volumes)
            or not isinstance(token, str) or not re.fullmatch(r'[0-9a-f]{32}', token)):
        raise ValueError('invalid fresh volume receipt')
    return record


def find_fresh_receipt(root, instance, admission, names):
    path = root / '.caddy-fresh'
    if not path.exists() and not path.is_symlink():
        raise ValueError('existing volumes require a matching managed creation receipt')
    directory = private_directory(path)
    try:
        entries = []
        with os.scandir(directory) as items:
            for item in items:
                entries.append(item.name)
                if len(entries) > 1000:
                    raise ValueError('fresh receipt inventory exceeds limit')
        matches = []
        for name in sorted(entries):
            record = read_fresh_candidate(directory, name)
            if record['instance'] == instance and record['admission'] == admission and [item.get('name') for item in record['volumes']] == names:
                matches.append((path / name, record))
        if len(matches) != 1:
            raise ValueError('exactly one matching managed fresh-volume receipt is required')
        return matches[0]
    finally:
        os.close(directory)


def verify_fresh(run, root, instance, admission, names, helper_id):
    path, record = find_fresh_receipt(root, instance, admission, names)
    volumes = inspect_volumes(run, names)
    if volumes != record['volumes']:
        raise ValueError('fresh volume identity changed')
    for name in names:
        labels = inspect_one(run, 'volume', name).get('Labels')
        if not isinstance(labels, dict) or labels.get(FRESH_TOKEN_LABEL) != record['token']:
            raise ValueError('fresh volume ownership changed')
    refuse_writers(running_containers(run), volumes)
    helper = Path(__file__).with_name('caddy_volume_copy.mjs')
    raw = run_owned_helper(run, names + names, helper, secrets.token_hex(16), helper_id, mode='--verify-fresh')
    result = json.loads(raw, object_pairs_hook=unique_object)
    if result != record['layout'] or result != {'schema': 'caddy-fresh-volumes-v1', 'data_mode': 0o750, 'config_mode': 0o750, 'owner': 1001, 'group': 1001}:
        raise ValueError('fresh volume layout changed')
    if inspect_volumes(run, names) != volumes:
        raise ValueError('fresh volume identity changed during verification')
    refuse_writers(running_containers(run), volumes)
    return path


def initialize_fresh(value, root, run, admission, names, helper_id):
    token = secrets.token_hex(16)
    fresh_names(run, names, token)
    before = inspect_volumes(run, names)
    if (before[0]['device'], before[0]['inode']) == (before[1]['device'], before[1]['inode']):
        raise ValueError('fresh Caddy volumes must be distinct')
    refuse_writers(running_containers(run), before)
    create_seed(run, value['image'], admission['store_id'], names, token)
    after = inspect_volumes(run, names)
    if after != before:
        raise ValueError('fresh volume identity changed during seeding')
    refuse_writers(running_containers(run), after)
    helper = Path(__file__).with_name('caddy_volume_copy.mjs')
    raw = run_owned_helper(run, names + names, helper, secrets.token_hex(16), helper_id, mode='--verify-fresh')
    result = json.loads(raw, object_pairs_hook=unique_object)
    if result != {'schema': 'caddy-fresh-volumes-v1', 'data_mode': 0o750, 'config_mode': 0o750, 'owner': 1001, 'group': 1001}:
        raise ValueError('fresh volume layout differs from qualified image')
    if inspect_volumes(run, names) != after:
        raise ValueError('fresh volume identity changed during verification')
    refuse_writers(running_containers(run), after)
    return write_fresh_receipt(root, {'schema': 1, 'instance': value['instance'], 'token': token,
                                      'admission': admission, 'volumes': after, 'layout': result})


def prepare_locked(value, root, run, admit):
    if (root / 'server').exists() or (root / 'server').is_symlink():
        raise ValueError('fresh volume initialization cannot modify an existing deployment')
    check_local_daemon(run, os.environ.get('DOCKER_HOST'))
    helper_id = require_helper_image(run)
    if unique_proxy(run, value['instance'], required=False, root=root) is not None:
        raise ValueError('fresh initialization refuses an existing Compose Caddy service')
    existing = run(['docker', 'ps', '--all', '--no-trunc', '--filter',
                    'name=^/' + value['instance'] + '-caddy$', '--format', '{{.ID}}'], 15, 65536)
    if existing.strip():
        raise ValueError('fresh initialization refuses an existing Caddy container')
    admission = admit(value['image'])
    if admission.get('reference') != value['image']:
        raise ValueError('image admission does not bind the requested reference')
    names = [value['data_volume'], value['config_volume']]
    existing = run(['docker', 'volume', 'ls', '--format', '{{.Name}}'], 15, 1024 * 1024).decode('utf-8').splitlines()
    if any(name in existing for name in names):
        return verify_fresh(run, root, value['instance'], admission, names, helper_id)
    return initialize_fresh(value, root, run, admission, names, helper_id)


def prepare(value, run=docker_run, admit=qualify):
    if not isinstance(value, dict) or set(value) != {'deploy_dir', 'instance', 'data_volume', 'config_volume', 'image'}:
        raise ValueError('invalid fresh volume request')
    root = validate_request({key: value[key] for key in ('deploy_dir', 'instance', 'data_volume', 'config_volume')})
    if not isinstance(value['image'], str) or not REFERENCE.fullmatch(value['image']):
        raise ValueError('Caddy image must be an immutable registry reference')
    lock = acquire_lock(root)
    try:
        return prepare_locked(value, root, run, admit)
    finally:
        os.close(lock)


def main():
    raw = sys.stdin.buffer.read(65537)
    if len(raw) > 65536:
        raise ValueError('fresh volume request exceeds its size limit')
    print(prepare(json.loads(raw, object_pairs_hook=unique_object)))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('Fresh Caddy volume initialization refused: ' + str(error), file=sys.stderr)
        for note in getattr(error, '__notes__', ()):
            print(note, file=sys.stderr)
        sys.exit(1)
