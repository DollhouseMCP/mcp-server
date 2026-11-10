"""Consume a qualified reconciliation without erasing its failed controls.

The old state/handoff bytes remain evidence. A new transition may consume one
fully verified disposition, with separate issued/completed lineage records.
"""
import os
from pathlib import Path
import re

from caddy_bundle_identity import bundle_identity
from caddy_recovery_receipt import MAX_RECORD, private_directory, read_private, write_exclusive
import legacy_handoff as handoff
from legacy_recovery_boundary import FILES, read_configuration

IMPLEMENTATION = Path(__file__).resolve().parent
CORE = ('kind', 'token', 'image', 'volumes', 'previous', 'receipt', 'receipt_sha256', 'source')


def operation_path(root, token):
    if not isinstance(token, str) or not re.fullmatch(r'[0-9a-f]{32}', token):
        raise ValueError('invalid reconciliation token')
    return root / '.legacy-recovery' / ('reconciled-' + token)


def raw_state(root):
    directory = private_directory(root / '.caddy-state')
    try:
        return read_private(directory, 'state.json', MAX_RECORD)
    finally:
        os.close(directory)


def verify_handoff_hashes(root, record):
    if set(record['handoff']) != {'issued.json', 'receipt.json'}:
        raise ValueError('reconciled handoff inventory is incomplete')
    directory = private_directory(root / handoff.STATE)
    try:
        for name, expected in record['handoff'].items():
            if handoff.digest(read_private(directory, name, MAX_RECORD)) != expected:
                raise ValueError('historical handoff evidence changed')
    finally:
        os.close(directory)


def read_resolution(root, token):
    directory = private_directory(operation_path(root, token))
    try:
        record, digest = handoff.read_json(directory, 'RECONCILED.json')
        if (record.get('schema') != 'legacy-controls-reconciled-v1' or record.get('token') != token
                or record.get('host') != handoff.host_identity() or record.get('instance') is None
                or record.get('implementation') != bundle_identity(IMPLEMENTATION)):
            raise ValueError('qualified reconciliation binding differs')
        authority, _ = handoff.read_json(directory, 'retirement-authority.json', record['retirement_authority_sha256'])
        if authority.get('host') != record['host'] or authority.get('instance') != record['instance']:
            raise ValueError('qualified retirement authority differs')
        verify_handoff_hashes(root, record)
        return record, digest
    finally:
        os.close(directory)


def verify_files(root, files):
    if set(files) != set(FILES):
        raise ValueError('reconciled configuration inventory is incomplete')
    for name, expected in files.items():
        try:
            raw, mode = read_configuration(root, name)
        except FileNotFoundError:
            if expected is None:
                continue
            raise ValueError('reconciled configuration disappeared') from None
        if expected != {'sha256': handoff.digest(raw), 'mode': mode, 'bytes': len(raw)}:
            raise ValueError('reconciled configuration changed')


def lookup(root, state):
    pending = state.get('pending')
    if pending is None:
        return None
    try:
        record, digest = read_resolution(root, pending['token'])
    except FileNotFoundError:
        return None
    if (handoff.digest(raw_state(root)) != record['failed_state_sha256']
            or pending != record['failed_state']['pending']
            or bundle_identity(root / 'server') != record['source']):
        raise ValueError('reconciled source or failed controls changed')
    verify_files(root, record['files'])
    directory = private_directory(operation_path(root, pending['token']))
    try:
        if any(name.startswith('consume-') for name in os.listdir(directory)):
            raise ValueError('reconciliation consumption was already issued or is UNKNOWN')
    finally:
        os.close(directory)
    return record, digest


def unresolved_pending(root, state):
    return None if lookup(root, state) is not None else state.get('pending')


def core(pending):
    return {key: pending[key] for key in CORE}


def issue_consumption(root, state, pending):
    found = lookup(root, state)
    if found is None:
        raise ValueError('no qualified reconciliation can release the old transition')
    record, digest = found
    if pending['kind'] != 'update' or pending['source'] != record['source'] or pending['token'] == record['token']:
        raise ValueError('new transition does not consume the qualified legacy source')
    directory = private_directory(operation_path(root, record['token']))
    name = 'consume-' + pending['token']
    value = {'schema': 'legacy-reconciliation-consumption-v1', 'resolution_sha256': digest,
             'old_token': record['token'], 'host': record['host'], 'pending': core(pending)}
    try:
        # Preserve the exact raw failed state before the current state can move.
        write_exclusive(directory, name + '-failed-state.json', raw_state(root))
        write_exclusive(directory, name + '-issued.json', handoff.encoded(value))
        os.fsync(directory)
    finally:
        os.close(directory)
    return operation_path(root, record['token']), name, value


def complete_consumption(issued, root):
    path, name, value = issued
    directory = private_directory(path)
    try:
        write_exclusive(directory, name + '-completed.json', handoff.encoded(value))
        os.fsync(directory)
    finally:
        os.close(directory)
    parent = private_directory(root / '.legacy-recovery')
    try:
        write_exclusive(parent, 'lineage-' + value['pending']['token'] + '.json', handoff.encoded(
            {'old_token': value['old_token'], 'consumption_sha256': handoff.digest(handoff.encoded(value))}))
        os.fsync(parent)
    finally:
        os.close(parent)


def consumed(root, state, token):
    pending = state.get('pending')
    if not isinstance(pending, dict) or pending['token'] != token:
        raise ValueError('handoff lineage requires the active transition token')
    parent = private_directory(root / '.legacy-recovery')
    try:
        lineage, _ = handoff.read_json(parent, 'lineage-' + token + '.json')
    finally:
        os.close(parent)
    record, digest = read_resolution(root, lineage['old_token'])
    directory = private_directory(operation_path(root, record['token']))
    try:
        issued, sha = handoff.read_json(directory, 'consume-' + token + '-issued.json', lineage['consumption_sha256'])
        completed, _ = handoff.read_json(directory, 'consume-' + token + '-completed.json', sha)
        old = read_private(directory, 'consume-' + token + '-failed-state.json', MAX_RECORD)
    finally:
        os.close(directory)
    if (issued != completed or issued['resolution_sha256'] != digest or issued['pending'] != core(pending)
            or handoff.digest(old) != record['failed_state_sha256']
            or bundle_identity(Path(pending['previous'])) != record['source']):
        raise ValueError('handoff consumption lineage differs')
    return record
