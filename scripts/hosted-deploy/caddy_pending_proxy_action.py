"""Explicit proxy-only recovery before pending source promotion."""
import json
import os
from pathlib import Path
import secrets
import sys

SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))
sys.dont_write_bytecode = True
from caddy_bundle_identity import bundle_identity
from caddy_clone_action import acquire_lock, docker_run, validate_request
from caddy_hardened_receipt import read_hardened_receipt
from caddy_image_admission import qualify
from caddy_recovery_receipt import read_caddy_snapshot, read_current_caddyfile, read_receipt
from caddy_recovery_preflight import validate_old_image
from caddy_recover_action import (named_containers, old_proxy_args, public_snapshot, recover_locked,
                                  retain_candidate_evidence, stop_owned_recovery, verify_recovered,
                                  write_recovery_evidence)
from caddy_service_guard import unique_proxy
from caddy_transition_action import receipt_hash
from caddy_transition_state import read_state
from caddy_unchanged_action import observe
from caddy_volume_migration import check_local_daemon, inspect_one, verify_prepared
from image_scan_intake import unique_object


def pending_record(root):
    state = read_state(root)
    pending = state['pending']
    if not isinstance(pending, dict) or pending['kind'] not in ('update', 'rollback'):
        raise ValueError('no prior proxy is bound to the pending transition')
    if pending.get('control') is not None:
        raise ValueError('verification or release is pending; automatic proxy recovery is refused')
    previous = Path(pending['previous'])
    if pending['phase'] == 'staged':
        if (bundle_identity(previous) != pending['source']
                or bundle_identity(root / 'server') != pending['staged_source']):
            raise ValueError('staged source differs from the pending proxy record')
    elif (previous.exists() or previous.is_symlink() or pending['staged_source'] is not None
          or bundle_identity(root / 'server') != pending['source']):
        raise ValueError('current source differs from the pending proxy record')
    path = Path(pending['receipt'])
    if receipt_hash(path) != pending['receipt_sha256']:
        raise ValueError('pending proxy receipt changed')
    if path.parent.name == '.caddy-hardened-recovery':
        record = read_hardened_receipt(path)
    else:
        record = read_receipt(path, previous, pending['source'])
    if record['bundle'] != str(previous) or record['bundle_identity'] != pending['source']:
        raise ValueError('pending proxy receipt does not bind the current source')
    return path, record


def restore_current(root, instance, run=docker_run, admit=qualify):
    receipt, record = pending_record(root)
    snapshot = read_caddy_snapshot(receipt, record['caddyfile_sha256'])
    current_caddyfile = read_current_caddyfile(root)
    profile = record['profile']
    if record['schema'] == 'caddy-hardened-v1':
        if current_caddyfile != snapshot:
            raise ValueError('current Caddyfile differs from its protected snapshot')
        names = [profile['data_volume'], profile['config_volume']]
        actual, volumes = observe(run, admit, root, instance, profile['reference'], names, profile['ports'])
        if actual != profile or volumes != record['volumes']:
            raise ValueError('live proxy differs from the protected pending record')
        return {'outcome': 'unchanged'}
    check_local_daemon(run, os.environ.get('DOCKER_HOST'))
    if unique_proxy(run, instance) != profile['container_id']:
        raise ValueError('original pending proxy identity changed')
    helper = Path(__file__).with_name('caddy_volume_copy.mjs')
    verify_prepared(run, profile, record['clone'], helper, str(root / 'Caddyfile'), os.environ.get('DOCKER_HOST'), admit)
    if current_caddyfile != snapshot:
        return recreate_original(root, instance, receipt, record, snapshot, current_caddyfile, run, admit)
    try:
        run(['docker', 'start', profile['container_id']], 20, 65536)
    except BaseException as error:
        error.add_note('Original proxy start outcome is UNKNOWN; inspect its exact identity before retrying')
        raise
    actual = inspect_one(run, 'container', profile['container_id'])
    if actual.get('Id') != profile['container_id'] or actual.get('State', {}).get('Running') is not True:
        raise ValueError('original proxy start is UNKNOWN')
    if unique_proxy(run, instance) != profile['container_id']:
        raise ValueError('original proxy selection changed after start')
    return {'outcome': 'started-original', 'container_id': profile['container_id']}


def revert_original_name(run, plan, instance, token, backup):
    occupied = named_containers(run, instance)
    original_id = plan['current_id']
    if occupied and occupied[0] != original_id:
        candidate = stop_owned_recovery(run, occupied[0], instance, token, plan['record']['profile']['image_id'])
        retain_candidate_evidence(plan, token, candidate)
        run(['docker', 'rm', candidate], 10, 65536)
        if named_containers(run, instance):
            raise ValueError('recovery proxy name remains occupied')
    original = inspect_one(run, 'container', original_id)
    if original.get('Id') != original_id or original.get('Name') not in ('/' + instance + '-caddy', '/' + backup):
        raise ValueError('original proxy identity is UNKNOWN')
    if original.get('State', {}).get('Running') is not False:
        raise ValueError('original proxy state is UNKNOWN')
    if original['Name'] == '/' + backup:
        run(['docker', 'rename', original_id, instance + '-caddy'], 10, 65536)
    checked = inspect_one(run, 'container', original_id)
    if checked.get('Name') != '/' + instance + '-caddy' or checked.get('State', {}).get('Running') is not False:
        raise ValueError('original proxy name restoration is UNKNOWN')


def recreate_original(root, instance, receipt, record, snapshot, current_caddyfile, run, admit):
    profile = record['profile']
    image = inspect_one(run, 'image', profile['image_id'])
    validate_old_image(image, profile, admit)
    token = secrets.token_hex(16)
    plan = {'receipt': receipt, 'record': record, 'previous': Path(record['bundle']), 'current_id': profile['container_id']}
    caddyfile = public_snapshot(root, token, snapshot) if profile.get('kind') == 'hardened' else receipt / 'Caddyfile'
    command = old_proxy_args(plan, instance, token, caddyfile)
    if pending_record(root) != (receipt, record) or read_current_caddyfile(root) != current_caddyfile:
        raise ValueError('pending recovery evidence changed')
    backup = 'dollhouse-caddy-original-' + token
    try:
        run(['docker', 'rename', profile['container_id'], backup], 10, 65536)
        original = inspect_one(run, 'container', profile['container_id'])
        if original.get('Name') != '/' + backup or original.get('State', {}).get('Running') is not False:
            raise ValueError('original proxy rename is UNKNOWN')
        if named_containers(run, instance):
            raise ValueError('proxy name unexpectedly occupied after rename')
        identifier = run(command, 15, 65536).decode('ascii').strip()
        verify_recovered(run, identifier, plan, instance, token, False, caddyfile, admit)
        run(['docker', 'start', identifier], 20, 65536)
        verify_recovered(run, identifier, plan, instance, token, True, caddyfile, admit)
        write_recovery_evidence(plan, token, 'success', {
            'schema': 'caddy-pending-recovery-success-v1', 'token': token,
            'restored_id': identifier, 'preserved_original_id': profile['container_id'],
            'original_profile': profile,
        })
        return {'outcome': 'recreated-original', 'container_id': identifier,
                'preserved_original_id': profile['container_id']}
    except BaseException as error:
        try:
            revert_original_name(run, plan, instance, token, backup)
        except Exception as cleanup:
            error.add_note('Original proxy name restoration is UNKNOWN: ' + str(cleanup))
        raise


def recover_pending(root, instance, image, run=docker_run, admit=qualify):
    _, record = pending_record(root)
    current = unique_proxy(run, instance)
    if current == record['profile']['container_id']:
        return restore_current(root, instance, run, admit)
    pending = read_state(root)['pending']
    if pending['phase'] != 'staged':
        raise ValueError('pending proxy identity changed before source staging')
    return recover_locked(root, instance, Path(record['bundle']), image, run, admit)


def main():
    raw = sys.stdin.buffer.read(65537)
    if len(raw) > 65536:
        raise ValueError('pending proxy request exceeds its size limit')
    value = json.loads(raw, object_pairs_hook=unique_object)
    keys = {'deploy_dir', 'instance', 'data_volume', 'config_volume', 'previous', 'image'}
    if not isinstance(value, dict) or set(value) != keys:
        raise ValueError('invalid pending proxy request')
    root = validate_request({key: value[key] for key in ('deploy_dir', 'instance', 'data_volume', 'config_volume')})
    lock = acquire_lock(root)
    try:
        result = recover_pending(root, value['instance'], value['image'])
        print(json.dumps(result, separators=(',', ':')))
    finally:
        os.close(lock)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('Pending proxy recovery refused: ' + str(error), file=sys.stderr)
        for note in getattr(error, '__notes__', ()):
            print(note, file=sys.stderr)
        sys.exit(1)
