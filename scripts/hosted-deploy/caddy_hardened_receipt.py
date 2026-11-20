"""Protected receipt for an unchanged, already-qualified hardened proxy."""
import hashlib
import json
import os
from pathlib import Path
import re
import secrets

from caddy_image_admission import REFERENCE
from caddy_recovery_receipt import (IMAGE_ID, MAX_RECORD, MAX_CADDYFILE, SHA256, VOLUME, private_directory,
                                    read_private, unique_object, validate_ports, write_exclusive)

NAME = re.compile(r'proxy-[0-9a-f]{32}\Z')


PENDING_RECEIPT = '.receipt.pending'


def validate_hardened_identity(profile):
    if not isinstance(profile['admission'], dict) or not isinstance(profile['container_id'], str) or not SHA256.fullmatch(profile['container_id']):
        raise ValueError('invalid hardened proxy identity')
    if (not isinstance(profile['image_id'], str) or not IMAGE_ID.fullmatch(profile['image_id'])
            or not isinstance(profile['reference'], str) or not REFERENCE.fullmatch(profile['reference'])):
        raise ValueError('invalid hardened image identity')
    if profile['admission'].get('reference') != profile['reference'] or profile['admission'].get('store_id') != profile['image_id']:
        raise ValueError('hardened image admission does not match its profile')


def validate_hardened_logging(logging):
    if not isinstance(logging, dict) or set(logging) != {'max-size', 'max-file'}:
        raise ValueError('invalid hardened logging')
    if not isinstance(logging['max-size'], str) or not re.fullmatch(r'[1-9](?a:\d)*[kKmMgG]', logging['max-size']):
        raise ValueError('invalid hardened log size')
    if not isinstance(logging['max-file'], str) or not re.fullmatch(r'[1-9](?a:\d)*', logging['max-file']):
        raise ValueError('invalid hardened log retention')


def validate_hardened_profile_values(profile):
    fields = {'kind', 'container_id', 'image_id', 'reference', 'data_volume', 'config_volume',
              'network', 'ports', 'aliases', 'logging', 'admission'}
    if not isinstance(profile, dict) or set(profile) != fields or profile['kind'] != 'hardened':
        raise ValueError('invalid hardened proxy profile')
    validate_hardened_identity(profile)
    for key in ('data_volume', 'config_volume', 'network'):
        if not isinstance(profile[key], str) or not VOLUME.fullmatch(profile[key]):
            raise ValueError('invalid hardened proxy name')
    if profile['data_volume'] == profile['config_volume']:
        raise ValueError('hardened volumes are not distinct')
    if not profile['network'].endswith('_default'):
        raise ValueError('invalid hardened Compose network')
    aliases = profile['aliases']
    if not isinstance(aliases, list) or not all(isinstance(value, str) and VOLUME.fullmatch(value) for value in aliases) or len(set(aliases)) != len(aliases):
        raise ValueError('invalid hardened proxy aliases')
    if not isinstance(profile['ports'], list):
        raise ValueError('invalid hardened proxy ports')
    validate_ports(profile['ports'])
    validate_hardened_logging(profile['logging'])


def validate_hardened_bundle(record):
    bundle = record['bundle']
    if not isinstance(bundle, str) or not os.path.isabs(bundle) or os.path.normpath(bundle) != bundle:
        raise ValueError('invalid hardened receipt bundle')
    identity = record['bundle_identity']
    if not isinstance(identity, dict) or set(identity) != {'sha256', 'entries', 'bytes'}:
        raise ValueError('invalid hardened bundle identity')
    if not isinstance(identity['sha256'], str) or not SHA256.fullmatch(identity['sha256']):
        raise ValueError('invalid hardened bundle hash')
    if any(isinstance(identity[key], bool) or not isinstance(identity[key], int) or identity[key] < 0 for key in ('entries', 'bytes')):
        raise ValueError('invalid hardened bundle size')
    if not isinstance(record['caddyfile_sha256'], str) or not SHA256.fullmatch(record['caddyfile_sha256']):
        raise ValueError('invalid hardened Caddyfile hash')


def validate_hardened_volume(volume):
    if set(volume) != {'name', 'driver', 'created_at', 'mountpoint', 'device', 'inode'} or volume['driver'] != 'local':
        raise ValueError('invalid hardened volume metadata')
    if not isinstance(volume['mountpoint'], str) or not os.path.isabs(volume['mountpoint']):
        raise ValueError('invalid hardened mountpoint')
    if not isinstance(volume['created_at'], str) or not volume['created_at']:
        raise ValueError('invalid hardened creation identity')
    if any(isinstance(volume[key], bool) or not isinstance(volume[key], int) or volume[key] < 0 for key in ('device', 'inode')):
        raise ValueError('invalid hardened filesystem identity')


def validate_hardened_volumes(volumes, profile):
    if not isinstance(volumes, list) or len(volumes) != 2 or not all(isinstance(item, dict) for item in volumes):
        raise ValueError('invalid hardened volume identities')
    for volume in volumes:
        validate_hardened_volume(volume)
    if [item.get('name') for item in volumes] != [profile['data_volume'], profile['config_volume']]:
        raise ValueError('hardened volume identities disagree')


def validate_hardened_record(record):
    keys = {'schema', 'bundle', 'bundle_identity', 'caddyfile_sha256', 'profile', 'volumes'}
    if not isinstance(record, dict) or set(record) != keys or record['schema'] != 'caddy-hardened-v1':
        raise ValueError('invalid hardened proxy receipt')
    validate_hardened_bundle(record)
    validate_hardened_profile_values(record['profile'])
    validate_hardened_volumes(record['volumes'], record['profile'])
    return record


def write_hardened_receipt(parent, record, caddyfile):
    validate_hardened_record(record)
    if not isinstance(caddyfile, bytes) or len(caddyfile) > MAX_CADDYFILE or hashlib.sha256(caddyfile).hexdigest() != record['caddyfile_sha256']:
        raise ValueError('invalid hardened Caddyfile snapshot')
    data = json.dumps(record, sort_keys=True, separators=(',', ':')).encode()
    if len(data) > MAX_RECORD:
        raise ValueError('hardened receipt exceeds size limit')
    parent_fd = private_directory(parent)
    try:
        name = 'proxy-' + secrets.token_hex(16)
        os.mkdir(name, 0o700, dir_fd=parent_fd)
        directory = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent_fd)
        try:
            os.fchmod(directory, 0o700)
            write_exclusive(directory, 'Caddyfile', caddyfile)
            write_exclusive(directory, PENDING_RECEIPT, data)
            os.link(PENDING_RECEIPT, 'receipt.json', src_dir_fd=directory, dst_dir_fd=directory, follow_symlinks=False)
            os.unlink(PENDING_RECEIPT, dir_fd=directory)
            os.fsync(directory)
        finally:
            os.close(directory)
        os.fsync(parent_fd)
        return Path(parent) / name
    finally:
        os.close(parent_fd)


def read_hardened_receipt(path):
    directory = private_directory(path)
    try:
        record = validate_hardened_record(json.loads(read_private(directory, 'receipt.json', MAX_RECORD), object_pairs_hook=unique_object))
        caddyfile = read_private(directory, 'Caddyfile', MAX_CADDYFILE)
        if hashlib.sha256(caddyfile).hexdigest() != record['caddyfile_sha256']:
            raise ValueError('hardened Caddyfile snapshot changed')
        return record
    finally:
        os.close(directory)
