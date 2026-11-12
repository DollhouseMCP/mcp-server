"""Consume a qualified reconciliation without erasing its failed controls.

The old state/handoff bytes remain evidence. A new transition may consume one
fully verified disposition, with separate issued/completed lineage records.

A reconciliation is consumed once. The one exception is a consumption that
legacy_update_return.py returned: the transition that consumed it was never
used, its records are complete, and the preserved state is back. lookup accepts
such a consumption, and only such a one, as not open.
"""
import json
import os
from pathlib import Path
import re

from caddy_bundle_identity import bundle_identity
from caddy_recovery_receipt import MAX_RECORD, private_directory, read_private, write_exclusive
import legacy_handoff as handoff
from legacy_recovery_boundary import DIRECTORY, FILES, read_configuration

IMPLEMENTATION = Path(__file__).resolve().parent
CONSUME_PREFIX = 'consume-'
CORE = ('kind', 'token', 'image', 'volumes', 'previous', 'receipt', 'receipt_sha256', 'source')
FAILED_STATE, ISSUED, COMPLETED = '-failed-state.json', '-issued.json', '-completed.json'
CONSUMPTION = (FAILED_STATE, ISSUED, COMPLETED)
RETURN = ('-removed-state.json', '-return-issued.json', '-return-completed.json')
RETURN_SCHEMA = 'legacy-reconciliation-return-v1'
UNKNOWN = 'reconciliation consumption was already issued or is UNKNOWN'


def operation_path(root, token):
    if not isinstance(token, str) or not re.fullmatch(r'[0-9a-f]{32}', token):
        raise ValueError('invalid reconciliation token')
    return root / DIRECTORY / ('reconciled-' + token)


def raw_state(root):
    directory = private_directory(root / '.caddy-state')
    try:
        return read_private(directory, 'state.json', MAX_RECORD)
    finally:
        os.close(directory)


def handoff_directory(root, record):
    if set(record['handoff']) != {'issued.json', 'stop-acknowledged.json', 'receipt.json'}:
        raise ValueError('reconciled handoff inventory is incomplete')
    relative = Path(record['handoff_directory'])
    if (relative.parts != (handoff.STATE,) and (len(relative.parts) != 2 or relative.parts[0] != handoff.STATE
            or not re.fullmatch(r'window-[0-9a-f]{32}', relative.parts[1]))):
        raise ValueError('historical handoff directory is outside the qualified namespace')
    return root / relative


def verify_handoff_hashes(root, record):
    path = handoff_directory(root, record)
    try:
        directory = private_directory(path)
    except FileNotFoundError:
        if all(value is None for value in record['handoff'].values()):
            return
        raise
    try:
        for name, expected in record['handoff'].items():
            try:
                raw = read_private(directory, name, MAX_RECORD)
            except FileNotFoundError:
                if expected is None:
                    continue
                raise ValueError('historical handoff evidence disappeared') from None
            if expected is None or handoff.digest(raw) != expected:
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
        require_returned(directory, record, digest, consumptions(directory))
    finally:
        os.close(directory)
    return record, digest


def consumptions(directory):
    """The consumption records of one reconciliation: the file suffixes present, by consuming token."""
    found = {}
    for name in os.listdir(directory):
        if name.startswith(CONSUME_PREFIX):
            match = re.fullmatch(r'([0-9a-f]{32})(-[a-z-]+\.json)', name[len(CONSUME_PREFIX):])
            if match is None:
                raise ValueError(UNKNOWN)
            found.setdefault(match.group(1), set()).add(match.group(2))
    return found


def require_returned(directory, record, digest, found):
    """The only relaxation of single use: a consumption that was returned, whole and verified, is not open."""
    for token, names in found.items():
        if names != set(CONSUMPTION + RETURN):
            raise ValueError(UNKNOWN)
        verify_return(directory, record, digest, token)


def return_record(record, digest, token, consumption_sha, removed_raw):
    return {'schema': RETURN_SCHEMA, 'resolution_sha256': digest, 'old_token': record['token'], 'token': token,
            'host': record['host'], 'consumption_sha256': consumption_sha, 'removed_state_sha256': handoff.digest(removed_raw),
            'restored_state_sha256': record['failed_state_sha256']}


def verify_return(directory, record, digest, token):
    """One returned consumption: its own records, the state the return removed and the state it restored, bound by hash."""
    prefix = CONSUME_PREFIX + token
    try:
        issued, issued_sha = handoff.read_json(directory, prefix + ISSUED)
        handoff.read_json(directory, prefix + COMPLETED, issued_sha)
        returned, returned_sha = handoff.read_json(directory, prefix + '-return-issued.json')
        handoff.read_json(directory, prefix + '-return-completed.json', returned_sha)
        removed_raw = read_private(directory, prefix + '-removed-state.json', MAX_RECORD)
        restored_raw = read_private(directory, prefix + FAILED_STATE, MAX_RECORD)
        removed = json.loads(removed_raw).get('pending')
        intact = (issued.get('resolution_sha256') == digest and issued.get('old_token') == record['token']
                  and isinstance(removed, dict) and removed.get('token') == token and issued.get('pending') == core(removed)
                  and handoff.digest(restored_raw) == record['failed_state_sha256']
                  and returned == return_record(record, digest, token, issued_sha, removed_raw))
    except (OSError, ValueError, KeyError, AttributeError):
        intact = False
    if not intact:
        raise ValueError(UNKNOWN)


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
    name = CONSUME_PREFIX + pending['token']
    value = {'schema': 'legacy-reconciliation-consumption-v1', 'resolution_sha256': digest,
             'old_token': record['token'], 'host': record['host'], 'pending': core(pending)}
    try:
        # Preserve the exact raw failed state before the current state can move.
        write_exclusive(directory, name + FAILED_STATE, raw_state(root))
        write_exclusive(directory, name + ISSUED, handoff.encoded(value))
        os.fsync(directory)
    finally:
        os.close(directory)
    return operation_path(root, record['token']), name, value


def complete_consumption(issued, root):
    path, name, value = issued
    directory = private_directory(path)
    try:
        write_exclusive(directory, name + COMPLETED, handoff.encoded(value))
        os.fsync(directory)
    finally:
        os.close(directory)
    parent = private_directory(root / DIRECTORY)
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
    parent = private_directory(root / DIRECTORY)
    try:
        lineage, _ = handoff.read_json(parent, 'lineage-' + token + '.json')
    finally:
        os.close(parent)
    record, digest = read_resolution(root, lineage['old_token'])
    directory = private_directory(operation_path(root, record['token']))
    try:
        issued, sha = handoff.read_json(directory, CONSUME_PREFIX + token + ISSUED, lineage['consumption_sha256'])
        completed, _ = handoff.read_json(directory, CONSUME_PREFIX + token + COMPLETED, sha)
        old = read_private(directory, CONSUME_PREFIX + token + FAILED_STATE, MAX_RECORD)
    finally:
        os.close(directory)
    if (issued != completed or issued['resolution_sha256'] != digest or issued['pending'] != core(pending)
            or handoff.digest(old) != record['failed_state_sha256']
            or bundle_identity(Path(pending['previous'])) != record['source']):
        raise ValueError('handoff consumption lineage differs')
    return record
