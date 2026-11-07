"""Private, bounded records for the hosted proxy recovery transaction."""
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import stat
import secrets

MAX_RECORD = 1024 * 1024
MAX_CADDYFILE = 1024 * 1024
SHA256 = re.compile(r'[0-9a-f]{64}\Z')
IMAGE_ID = re.compile(r'sha256:[0-9a-f]{64}\Z')
VOLUME = re.compile(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\Z')


PENDING_RECEIPT = '.receipt.pending'


def stable(st):
    return (st.st_dev, st.st_ino, st.st_mode, st.st_uid, st.st_nlink,
            st.st_size, st.st_mtime_ns, st.st_ctime_ns)


def private_directory(path):
    path = Path(path)
    st = path.lstat()
    if not stat.S_ISDIR(st.st_mode) or st.st_uid != os.geteuid() or stat.S_IMODE(st.st_mode) != 0o700:
        raise ValueError('unsafe recovery directory')
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    if stable(os.fstat(fd)) != stable(st):
        os.close(fd)
        raise ValueError('recovery directory changed')
    return fd


def read_private(directory, name, maximum):
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
    try:
        st = os.fstat(fd)
        if (not stat.S_ISREG(st.st_mode) or st.st_uid != os.geteuid() or st.st_nlink != 1
                or stat.S_IMODE(st.st_mode) != 0o600 or st.st_size > maximum):
            raise ValueError('unsafe recovery file')
        data = bytearray()
        while len(data) < st.st_size:
            chunk = os.read(fd, min(65536, st.st_size - len(data)))
            if not chunk:
                raise ValueError('truncated recovery file')
            data.extend(chunk)
        if os.read(fd, 1) or stable(os.fstat(fd)) != stable(st):
            raise ValueError('recovery file changed')
        linked = os.stat(name, dir_fd=directory, follow_symlinks=False)
        if stable(linked) != stable(st):
            raise ValueError('recovery file replaced')
        return bytes(data)
    finally:
        os.close(fd)


def read_current_caddyfile(deploy_dir):
    """Capture the existing regular config without following its final link."""
    path = Path(deploy_dir)
    root = path.lstat()
    if not stat.S_ISDIR(root.st_mode) or root.st_uid != os.geteuid() or root.st_mode & 0o022:
        raise ValueError('unsafe deployment directory')
    directory = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        if stable(os.fstat(directory)) != stable(root):
            raise ValueError('deployment directory changed')
        fd = os.open('Caddyfile', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        try:
            before = os.fstat(fd)
            if (not stat.S_ISREG(before.st_mode) or before.st_uid != os.geteuid()
                    or before.st_nlink != 1 or before.st_mode & 0o022 or before.st_size > MAX_CADDYFILE):
                raise ValueError('unsafe existing Caddyfile')
            data = bytearray()
            while len(data) < before.st_size:
                block = os.read(fd, min(65536, before.st_size - len(data)))
                if not block:
                    raise ValueError('existing Caddyfile was truncated')
                data.extend(block)
            after = os.stat('Caddyfile', dir_fd=directory, follow_symlinks=False)
            if os.read(fd, 1) or stable(os.fstat(fd)) != stable(before) or stable(after) != stable(before):
                raise ValueError('existing Caddyfile changed')
            return bytes(data)
        finally:
            os.close(fd)
    finally:
        os.close(directory)


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('duplicate recovery receipt field')
        result[key] = value
    return result


def validate_ports(ports):
    if len(ports) not in (1, 2):
        raise ValueError('invalid proxy ports')
    for entry in ports:
        if not isinstance(entry, dict) or set(entry) != {'container_port', 'host_ip', 'host_port'}:
            raise ValueError('invalid proxy port binding')
        target, published = entry['container_port'], entry['host_port']
        if not isinstance(target, str) or not re.fullmatch(r'[1-9](?a:\d){0,4}/tcp', target) or int(target[:-4]) > 65535:
            raise ValueError('invalid proxy container port')
        if not isinstance(published, str) or not re.fullmatch(r'[1-9](?a:\d){0,4}', published) or int(published) > 65535:
            raise ValueError('invalid proxy host port')
        ipaddress.ip_address(entry['host_ip'])


def validate_legacy_logging(logging):
    if (not isinstance(logging, dict) or set(logging) != {'max-size', 'max-file'}
            or not re.fullmatch(r'[1-9](?a:\d)*[kKmMgG]', logging.get('max-size', ''))
            or not re.fullmatch(r'[1-9](?a:\d)*', logging.get('max-file', ''))):
        raise ValueError('invalid proxy logging')


def validate_legacy_configuration(profile):
    env, aliases, ports = profile['public_env'], profile['aliases'], profile['ports']
    if not isinstance(env, dict) or not isinstance(aliases, list) or not isinstance(ports, list):
        raise ValueError('invalid proxy configuration')
    if not set(env) <= {'PATH', 'CADDY_VERSION', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME'} or not all(isinstance(value, str) and value and not any(c in value for c in '\n\r\x00') for value in env.values()):
        raise ValueError('invalid proxy environment')
    if not all(isinstance(value, str) and VOLUME.fullmatch(value) for value in aliases) or len(set(aliases)) != len(aliases):
        raise ValueError('invalid proxy aliases')
    validate_ports(ports)


def validate_profile(profile):
    if isinstance(profile, dict) and profile.get('kind') == 'hardened':
        from caddy_hardened_receipt import validate_hardened_profile_values
        validate_hardened_profile_values(profile)
        return
    fields = {'container_id', 'image_id', 'diff_ids', 'data_volume', 'config_volume',
              'public_env', 'network', 'aliases', 'ports', 'platform', 'repo_digests', 'logging'}
    if not isinstance(profile, dict) or set(profile) != fields:
        raise ValueError('invalid proxy profile')
    if (not isinstance(profile['container_id'], str) or not SHA256.fullmatch(profile['container_id'])
            or not isinstance(profile['image_id'], str) or not IMAGE_ID.fullmatch(profile['image_id'])):
        raise ValueError('invalid proxy identity')
    diff_ids = profile['diff_ids']
    if not isinstance(diff_ids, list) or not diff_ids or not all(isinstance(item, str) and IMAGE_ID.fullmatch(item) for item in diff_ids):
        raise ValueError('invalid proxy layers')
    volumes = [profile['data_volume'], profile['config_volume']]
    if not all(isinstance(item, str) and VOLUME.fullmatch(item) for item in volumes) or volumes[0] == volumes[1]:
        raise ValueError('invalid proxy volumes')
    if not isinstance(profile['network'], str) or not VOLUME.fullmatch(profile['network']):
        raise ValueError('invalid proxy network')
    if profile['platform'] not in ('linux/amd64', 'linux/arm64'):
        raise ValueError('invalid proxy platform')
    validate_legacy_logging(profile['logging'])
    digests = profile['repo_digests']
    if not isinstance(digests, list) or not all(isinstance(value, str) and re.fullmatch(r'[^\s@]+@sha256:[0-9a-f]{64}', value) for value in digests):
        raise ValueError('invalid proxy registry digests')
    validate_legacy_configuration(profile)


def validate_clone_volume(volume):
    fields = {'name', 'driver', 'created_at', 'mountpoint', 'device', 'inode'}
    if not isinstance(volume, dict) or set(volume) != fields:
        raise ValueError('invalid clone volume identity')
    if not isinstance(volume['name'], str) or not VOLUME.fullmatch(volume['name']) or volume['driver'] != 'local':
        raise ValueError('invalid clone volume')
    if not isinstance(volume['created_at'], str) or not volume['created_at']:
        raise ValueError('invalid clone volume creation identity')
    if not isinstance(volume['mountpoint'], str) or not os.path.isabs(volume['mountpoint']):
        raise ValueError('invalid clone mountpoint')
    if any(isinstance(volume[key], bool) or not isinstance(volume[key], int) or volume[key] < 0 for key in ('device', 'inode')):
        raise ValueError('invalid clone filesystem identity')
    return volume['name']


def validate_clone(clone, profile):
    if not isinstance(clone, dict) or set(clone) != {'volumes', 'copy'}:
        raise ValueError('invalid clone receipt')
    volumes = clone['volumes']
    if not isinstance(volumes, list) or len(volumes) != 4:
        raise ValueError('invalid clone volume identities')
    names = [validate_clone_volume(volume) for volume in volumes]
    if len(set(names)) != 4 or names[:2] != [profile['data_volume'], profile['config_volume']]:
        raise ValueError('clone does not bind the original proxy volumes')
    from caddy_volume_migration import validate_copy_receipt
    validate_copy_receipt(clone['copy'])


def validate_record(record, bundle, bundle_identity):
    keys = {'schema', 'bundle', 'bundle_identity', 'caddyfile_sha256', 'profile', 'clone'}
    if not isinstance(record, dict) or set(record) != keys or record['schema'] != 1 or isinstance(record['schema'], bool):
        raise ValueError('invalid recovery receipt schema')
    if record['bundle'] != str(bundle) or record['bundle_identity'] != bundle_identity:
        raise ValueError('receipt does not identify the selected source bundle')
    if not isinstance(record['bundle'], str) or not os.path.isabs(record['bundle']) or os.path.normpath(record['bundle']) != record['bundle']:
        raise ValueError('invalid source bundle path')
    identity = record['bundle_identity']
    if not isinstance(identity, dict) or set(identity) != {'sha256', 'entries', 'bytes'}:
        raise ValueError('invalid source bundle identity')
    if not isinstance(identity['sha256'], str) or not SHA256.fullmatch(identity['sha256']):
        raise ValueError('invalid source bundle hash')
    if any(isinstance(identity[key], bool) or not isinstance(identity[key], int) or identity[key] < 0 for key in ('entries', 'bytes')):
        raise ValueError('invalid source bundle size')
    if not isinstance(record['caddyfile_sha256'], str) or not SHA256.fullmatch(record['caddyfile_sha256']):
        raise ValueError('invalid Caddyfile identity')
    validate_profile(record['profile'])
    validate_clone(record['clone'], record['profile'])
    return record


def read_receipt(path, bundle, bundle_identity):
    directory = private_directory(path)
    try:
        record = json.loads(read_private(directory, 'receipt.json', MAX_RECORD), object_pairs_hook=unique_object)
        validate_record(record, bundle, bundle_identity)
        caddyfile = read_private(directory, 'Caddyfile', MAX_CADDYFILE)
        if hashlib.sha256(caddyfile).hexdigest() != record['caddyfile_sha256']:
            raise ValueError('recorded Caddyfile does not match receipt')
        return record
    finally:
        os.close(directory)


def read_caddy_snapshot(path, expected_hash):
    directory = private_directory(path)
    try:
        data = read_private(directory, 'Caddyfile', MAX_CADDYFILE)
        if hashlib.sha256(data).hexdigest() != expected_hash:
            raise ValueError('recorded Caddyfile does not match receipt')
        return data
    finally:
        os.close(directory)


def write_exclusive(directory, name, data):
    fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory)
    try:
        os.fchmod(fd, 0o600)
        view = memoryview(data)
        while view:
            written = os.write(fd, view)
            if written <= 0:
                raise ValueError('failed to write recovery file')
            view = view[written:]
        os.fsync(fd)
    finally:
        os.close(fd)


def create_receipt(parent, record, caddyfile):
    if not isinstance(caddyfile, bytes) or len(caddyfile) > MAX_CADDYFILE:
        raise ValueError('invalid Caddyfile snapshot')
    if hashlib.sha256(caddyfile).hexdigest() != record.get('caddyfile_sha256'):
        raise ValueError('Caddyfile snapshot does not match receipt')
    validate_record(record, record.get('bundle'), record.get('bundle_identity'))
    encoded = json.dumps(record, sort_keys=True, separators=(',', ':')).encode()
    if len(encoded) > MAX_RECORD:
        raise ValueError('recovery receipt is too large')
    parent_fd = private_directory(parent)
    try:
        name = 'proxy-' + secrets.token_hex(16)
        os.mkdir(name, 0o700, dir_fd=parent_fd)
        directory = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent_fd)
        try:
            os.fchmod(directory, 0o700)
            write_exclusive(directory, 'Caddyfile', caddyfile)
            write_exclusive(directory, PENDING_RECEIPT, encoded)
            # A link creates the commit name atomically and refuses an existing name.
            os.link(PENDING_RECEIPT, 'receipt.json', src_dir_fd=directory, dst_dir_fd=directory, follow_symlinks=False)
            os.unlink(PENDING_RECEIPT, dir_fd=directory)
            os.fsync(directory)
        finally:
            os.close(directory)
        os.fsync(parent_fd)
        return Path(parent) / name
    finally:
        os.close(parent_fd)
