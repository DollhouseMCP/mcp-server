#!/usr/bin/env python3
"""Return a legacy update transition that began and was never used.

The legacy update begins its Caddy transition and then arms its recovery
baseline. Beginning consumes the reconciliation of the earlier failed
transition: the state file now holds the new transition, and the old state is
preserved byte for byte beside the consumption records. If the update stops
between those two steps, the new transition is pending with nothing armed.
recover-legacy has no baseline to recover from, and every later action refuses
a pending transition. The window cannot be tried again.

This action undoes that one beginning. It first proves that the transition was
never used:

- it is an update in its first phase: nothing admitted, nothing staged, no
  verification control;
- the consumption records are complete and bind this transition, and no return
  was issued for it before;
- no recovery baseline is armed and no forward write was issued;
- no legacy stop was issued for it;
- the previous source was not staged, and the serving source and every
  configuration file are exactly as the reconciliation recorded them.

Then, in order: it preserves the state it removes, records the return, puts the
preserved state back as the exact preserved bytes, reads it back and compares
its hash, and records the return as completed. A return that is interrupted
leaves an issued record without a completed one, and every later action
refuses, as it does after an interrupted consumption.

It issues no Docker command, and starts, stops and removes nothing. It does not
bring ingress back: after it, abandon-caddy-offline or accept-caddy-restart
applies, as after an offline preparation alone.

    legacy_update_return.py return-unarmed-update < request.json

    {"deploy_dir": ..., "instance": ..., "data_volume": ..., "config_volume": ...}
"""
import json
import os
from pathlib import Path
import secrets
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from caddy_active_config import validate_system
from caddy_bundle_identity import bundle_identity
from caddy_clone_action import acquire_lock, validate_request
from caddy_recovery_receipt import MAX_RECORD, private_directory, read_private, write_exclusive
from caddy_transition_state import STATE_FILE, read_state, state_directory, validate_state
from image_scan_intake import unique_object
import legacy_control_resolution as resolution
import legacy_handoff as handoff
from legacy_recovery_boundary import window_path

ACTION = 'return-unarmed-update'


def unused(pending, value):
    """The pending transition is an update that only began."""
    if (not isinstance(pending, dict) or pending['kind'] != 'update' or pending['phase'] != 'prepared'
            or pending['admission'] is not None or pending['staged_source'] is not None or pending.get('control') is not None):
        raise ValueError('the pending transition is not an update in its first phase')
    if pending['volumes'] != [value['data_volume'], value['config_volume']]:
        raise ValueError('the pending transition names other volumes')
    return pending['token']


def consumption(root, pending, value):
    """The reconciliation this transition consumed, with its complete consumption records and no return."""
    token = pending['token']
    parent = private_directory(root / resolution.DIRECTORY)
    try:
        lineage, _ = handoff.read_json(parent, 'lineage-' + token + '.json')
    except FileNotFoundError:
        raise ValueError('this transition consumed no reconciliation') from None
    finally:
        os.close(parent)
    record, digest = resolution.read_resolution(root, lineage['old_token'])
    if record['instance'] != value['instance']:
        raise ValueError('the consumed reconciliation belongs to another instance')
    prefix = resolution.CONSUME_PREFIX + token
    directory = private_directory(resolution.operation_path(root, record['token']))
    try:
        found = resolution.consumptions(directory)
        if found.pop(token, None) != set(resolution.CONSUMPTION):
            raise ValueError('the consumption records are incomplete, or a return was already issued')
        # An earlier attempt's consumption must itself have been returned, whole.
        resolution.require_returned(directory, record, digest, found)
        issued, issued_sha = handoff.read_json(directory, prefix + resolution.ISSUED, lineage['consumption_sha256'])
        handoff.read_json(directory, prefix + resolution.COMPLETED, issued_sha)
        preserved = read_private(directory, prefix + resolution.FAILED_STATE, MAX_RECORD)
    finally:
        os.close(directory)
    if (issued.get('resolution_sha256') != digest or issued.get('old_token') != record['token']
            or issued.get('pending') != resolution.core(pending)
            or handoff.digest(preserved) != record['failed_state_sha256']):
        raise ValueError('the consumption records do not bind this transition and the reconciled state')
    restored = validate_state(json.loads(preserved, object_pairs_hook=unique_object), root)
    if restored['pending'] != record['failed_state']['pending']:
        raise ValueError('the preserved state is not the reconciled state')
    return record, digest, issued_sha, preserved


def untouched(root, pending, record):
    """Nothing was armed, stopped, staged or changed since the reconciliation."""
    token = pending['token']
    window = window_path(root, token)
    if any(os.path.lexists(window / name) for name in ('armed.json', 'forward-write-issued.json')):
        raise ValueError('a recovery baseline is armed for this transition; recover-legacy applies')
    if os.path.lexists(root / handoff.STATE / ('window-' + token)):
        raise ValueError('a legacy stop was issued for this transition')
    if os.path.lexists(pending['previous']):
        raise ValueError('the previous source was staged for this transition')
    if pending['source'] != record['source'] or bundle_identity(root / 'server') != record['source']:
        raise ValueError('the serving source differs from the reconciled source')
    resolution.verify_files(root, record['files'])


def restore_state(root, raw):
    """Replace the state file with exactly these bytes, the way write_state replaces it."""
    directory = state_directory(root, False)
    name = '.state-' + secrets.token_hex(16) + '.pending'
    try:
        if os.listdir(directory) != [STATE_FILE]:
            raise ValueError('Caddy state directory is incomplete or ambiguous')
        write_exclusive(directory, name, raw)
        os.replace(name, STATE_FILE, src_dir_fd=directory, dst_dir_fd=directory)
        os.fsync(directory)
    finally:
        os.close(directory)


def return_update(root, value):
    removed = resolution.raw_state(root)
    pending = read_state(root)['pending']
    token = unused(pending, value)
    record, digest, issued_sha, preserved = consumption(root, pending, value)
    untouched(root, pending, record)
    if json.loads(removed, object_pairs_hook=unique_object)['pending'] != pending:
        raise ValueError('the transition state changed during the check')
    returned = handoff.encoded(resolution.return_record(record, digest, token, issued_sha, removed))
    prefix = resolution.CONSUME_PREFIX + token
    operation = resolution.operation_path(root, record['token'])
    directory = private_directory(operation)
    try:
        write_exclusive(directory, prefix + '-removed-state.json', removed)
        write_exclusive(directory, prefix + '-return-issued.json', returned)
        os.fsync(directory)
        restore_state(root, preserved)
        if handoff.digest(resolution.raw_state(root)) != record['failed_state_sha256']:
            raise ValueError('the restored state differs from the preserved state; the return is UNKNOWN')
        write_exclusive(directory, prefix + '-return-completed.json', returned)
        os.fsync(directory)
    finally:
        os.close(directory)
    state = read_state(root)
    if resolution.lookup(root, state) is None or resolution.unresolved_pending(root, state) is not None:
        raise ValueError('the restored transition is not resolved by its reconciliation')
    return {'outcome': 'RETURNED', 'returned_token': token, 'resolved_token': record['token'],
            'restored_state_sha256': record['failed_state_sha256'],
            'receipt': str(operation / (prefix + '-return-completed.json'))}


def main():
    if len(sys.argv) != 2 or sys.argv[1] != ACTION:
        raise ValueError('explicit %s action required' % ACTION)
    raw = sys.stdin.buffer.read(MAX_RECORD + 1)
    if len(raw) > MAX_RECORD:
        raise ValueError('request exceeds its bound')
    value = json.loads(raw, object_pairs_hook=unique_object)
    root = validate_request(value)
    validate_system()
    lock = acquire_lock(root)
    try:
        print(json.dumps(return_update(root, value), sort_keys=True))
    finally:
        os.close(lock)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('Legacy update return refused; nothing may be assumed returned: ' + str(error), file=sys.stderr)
        sys.exit(1)
