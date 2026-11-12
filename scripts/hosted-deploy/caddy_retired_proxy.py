"""Qualified retained proxy identities, never a label or wildcard exemption.

Docker labels are immutable. A stopped retained container stays in inventory;
only a protected authority written by reconciliation/replacement can identify
it as retired. Every field, boot and retained name is rechecked on each use.
"""
import os
from pathlib import Path
import re

from caddy_recovery_receipt import MAX_RECORD, private_directory, read_current_caddyfile, read_private, write_exclusive
from caddy_volume_migration import inspect_one
import legacy_handoff as handoff
from legacy_recovery_guards import lifecycle
from legacy_recovery_profile import profile, same_profile

DIRECTORY = '.caddy-retired-proxies'
STARTUP_NAME = 'Caddyfile'
JSON_SUFFIX = '.json'
ID = re.compile(r'[0-9a-f]{64}\Z')
# A later boot of the reconciled serving proxy, recorded by one qualified action. See caddy_serving_boot.py.
BOOTS = '.caddy-serving-boots'
BOOT_SCHEMA = 'serving-proxy-boot-v1'
BOOT_NAME = re.compile(r'boot-([0-9a-f]{64})-[0-9a-f]{32}\.json\Z')
BOOT_FIELDS = {'schema', 'host', 'instance', 'id', 'previous', 'boot', 'serving_sha256', 'reason', 'authority'}
BOOT_REASONS = ('abandoned-offline-preparation', 'accepted-restart')
BOOT_RECEIPT = 'RECORDED.json'
MAX_BOOTS = 32


def authority(root, value):
    if not isinstance(value, dict) or set(value) != {'path', 'sha256'}:
        raise ValueError('retired proxy authority is missing')
    path = Path(value['path'])
    relative = path.relative_to(root)
    if (len(relative.parts) != 3 or relative.parts[0] not in ('.legacy-recovery', '.caddy-native-replacements')
            or not re.fullmatch(r'reconciled-[0-9a-f]{32}|replace-[0-9a-f]{32}', relative.parts[1])
            or relative.parts[2] != 'retirement-authority.json' or path.resolve(strict=True) != path):
        raise ValueError('retired proxy authority is outside its qualified operation')
    owner = private_directory(path.parent)
    try:
        record, _ = handoff.read_json(owner, path.name, value['sha256'])
    finally:
        os.close(owner)
    if record.get('schema') != 'qualified-proxy-retirement-v1' or record.get('host') != handoff.host_identity():
        raise ValueError('retired proxy authority host or schema differs')
    return record


def verify_retired(root, instance, item, run):
    fields = {'schema', 'instance', 'host', 'id', 'name', 'profile', 'boot', 'authority'}
    if (not isinstance(item, dict) or set(item) != fields or item['schema'] != 'retained-proxy-v1'
            or item['host'] != handoff.host_identity() or item['instance'] != instance
            or not isinstance(item['id'], str) or not ID.fullmatch(item['id'])
            or not isinstance(item['name'], str) or not re.fullmatch(
                re.escape(instance) + r'-caddy-(?:aborted|retained)-(?:[0-9a-f]{16}|[0-9a-f]{32})', item['name'])):
        raise ValueError('retired proxy identity is invalid')
    proof = authority(root, item['authority'])
    if proof.get('instance') != instance or proof.get('retired') != {
            key: item[key] for key in ('id', 'name', 'profile', 'boot')}:
        raise ValueError('retired proxy differs from its qualified authority')
    actual = inspect_one(run, 'container', item['id'])
    if actual.get('Name') != '/' + item['name'] or not same_profile(profile(actual), item['profile']):
        raise ValueError('retired proxy full profile or retained name changed')
    labels = actual.get('Config', {}).get('Labels', {})
    if labels.get('com.docker.compose.project') != instance or labels.get('com.docker.compose.service') != 'caddy':
        raise ValueError('retired proxy Compose ownership changed')
    lifecycle(actual, False, item['boot'])
    return item['id']


def boot_authority(root, value):
    """The receipt of the action that recorded a boot: one private file in that action's own folder."""
    if not isinstance(value, dict) or set(value) != {'path', 'sha256'}:
        raise ValueError('serving proxy boot authority is missing')
    path = Path(value['path'])
    relative = path.relative_to(root)
    if (len(relative.parts) != 3 or relative.parts[0] != BOOTS
            or not re.fullmatch(r'(?:abandon|accept)-[0-9a-f]{32}', relative.parts[1])
            or relative.parts[2] != BOOT_RECEIPT or path.resolve(strict=True) != path):
        raise ValueError('serving proxy boot authority is outside its qualified operation')
    owner = private_directory(path.parent)
    try:
        record, _ = handoff.read_json(owner, path.name, value['sha256'])
    finally:
        os.close(owner)
    return record


def valid_boot(value):
    return (isinstance(value, dict) and set(value) == {'started_at', 'restart_count'}
            and isinstance(value['started_at'], str) and bool(value['started_at'])
            and type(value['restart_count']) is int and value['restart_count'] >= 0)


def boot_records(root, instance, identifier, directory):
    """Every recorded later boot of one serving proxy, each bound to its serving record and its authority."""
    serving_sha = handoff.digest(read_private(directory, 'serving-' + identifier + JSON_SUFFIX, MAX_RECORD))
    names = sorted(name for name in os.listdir(directory)
                   if (match := BOOT_NAME.fullmatch(name)) is not None and match.group(1) == identifier)
    if len(names) > MAX_BOOTS:
        raise ValueError('serving proxy boot records exceed their bound')
    records = []
    for name in names:
        record, _ = handoff.read_json(directory, name)
        if (set(record) != BOOT_FIELDS or record['schema'] != BOOT_SCHEMA or record['host'] != handoff.host_identity()
                or record['instance'] != instance or record['id'] != identifier or record['reason'] not in BOOT_REASONS
                or record['serving_sha256'] != serving_sha or not valid_boot(record['previous'])
                or not valid_boot(record['boot']) or record['previous']['started_at'] == record['boot']['started_at']):
            raise ValueError('serving proxy boot record is invalid')
        proof = boot_authority(root, record['authority'])
        if proof.get('boot_record') != {key: record[key] for key in BOOT_FIELDS - {'authority'}}:
            raise ValueError('serving proxy boot record differs from its qualified authority')
        records.append(record)
    return records


def serving_boot(root, instance, identifier, serving):
    """The boot the reconciled serving proxy must have: its reconciled one, or the newest one recorded after it.

    The records must form exactly one chain from the reconciled boot. A fork, a
    loop or a record that is not on the chain refuses.
    """
    directory = private_directory(root / DIRECTORY)
    try:
        records = boot_records(root, instance, identifier, directory)
    finally:
        os.close(directory)
    current, started = serving['boot'], {serving['boot']['started_at']}
    for _ in records:
        following = [record for record in records if record['previous'] == current]
        if len(following) != 1 or following[0]['boot']['started_at'] in started:
            raise ValueError('serving proxy boot records do not form one chain')
        current = following[0]['boot']
        started.add(current['started_at'])
    return current


def inventory(root, instance, run):
    parent = Path(root) / DIRECTORY
    try:
        directory = private_directory(parent)
    except FileNotFoundError:
        return set()
    try:
        names = sorted(os.listdir(directory))
        if len(names) > 100:
            raise ValueError('retired proxy inventory exceeds its bound')
        result = set()
        for name in names:
            if re.fullmatch(r'serving-[0-9a-f]{64}\.json', name) or BOOT_NAME.fullmatch(name):
                continue
            if not re.fullmatch(r'proxy-[0-9a-f]{64}\.json', name):
                raise ValueError('retired proxy inventory has an unknown entry')
            record, _ = handoff.read_json(directory, name)
            identifier = verify_retired(Path(root), instance, record, run)
            if name != 'proxy-' + identifier + JSON_SUFFIX or identifier in result:
                raise ValueError('retired proxy inventory is ambiguous')
            result.add(identifier)
        return result
    finally:
        os.close(directory)


def register(root, instance, identifier, name, proof_path, run):
    current = inspect_one(run, 'container', identifier)
    owner = private_directory(proof_path.parent)
    try:
        proof_raw = read_private(owner, proof_path.name, MAX_RECORD)
    finally:
        os.close(owner)
    item = {'schema': 'retained-proxy-v1', 'instance': instance, 'host': handoff.host_identity(),
            'id': identifier, 'name': name, 'profile': profile(current), 'boot': lifecycle(current, False),
            'authority': {'path': str(proof_path), 'sha256': handoff.digest(proof_raw)}}
    verify_retired(root, instance, item, run)
    parent = root / DIRECTORY
    parent.mkdir(mode=0o700, exist_ok=True)
    directory = private_directory(parent)
    try:
        write_exclusive(directory, 'proxy-' + identifier + JSON_SUFFIX, handoff.encoded(item))
        os.fsync(directory)
    finally:
        os.close(directory)


def serving_record(root, instance, identifier):
    """The reconciled serving proxy record for this ID, bound to its authority, or None when there is none."""
    try:
        directory = private_directory(root / DIRECTORY)
    except FileNotFoundError:
        return None
    try:
        try:
            if not isinstance(identifier, str) or not ID.fullmatch(identifier):
                raise ValueError('reconciled serving proxy ID is invalid')
            record, _ = handoff.read_json(directory, 'serving-' + identifier + JSON_SUFFIX)
        except FileNotFoundError:
            return None
    finally:
        os.close(directory)
    proof = authority(root, record['authority'])
    if proof.get('instance') != instance or proof.get('serving') != record.get('serving'):
        raise ValueError('reconciled serving proxy authority differs')
    serving = record['serving']
    if serving['id'] != identifier:
        raise ValueError('reconciled serving proxy selector differs')
    return serving


def startup_path(root, instance, identifier, run, require_root_copy=True):
    """Only the one reconciled legacy proxy may use its protected old bind."""
    serving = serving_record(root, instance, identifier)
    if serving is None:
        return root / STARTUP_NAME
    current = inspect_one(run, 'container', identifier)
    if not same_profile(profile(current), serving['profile']) or current.get('Name') != '/' + instance + '-caddy':
        raise ValueError('reconciled serving proxy profile changed')
    running = current.get('State', {}).get('Running')
    if type(running) is not bool:
        raise ValueError('reconciled serving proxy lifecycle is UNKNOWN')
    lifecycle(current, running, serving_boot(root, instance, identifier, serving))
    path = Path(serving['caddyfile'])
    relative = path.relative_to(root)
    if (len(relative.parts) != 3 or relative.parts[0] != '.caddy-recovery'
            or not re.fullmatch(r'proxy-[0-9a-f]{32}', relative.parts[1]) or relative.parts[2] != STARTUP_NAME
            or path.resolve(strict=True) != path):
        raise ValueError('reconciled startup path is not an original protected proxy receipt')
    owner = private_directory(path.parent)
    try:
        content = read_private(owner, STARTUP_NAME, MAX_RECORD)
    finally:
        os.close(owner)
    if (handoff.digest(content) != serving['caddyfile_sha256']
            or (require_root_copy and read_current_caddyfile(root) != content)):
        raise ValueError('reconciled startup bytes differ from the original and deployment copies')
    return path
