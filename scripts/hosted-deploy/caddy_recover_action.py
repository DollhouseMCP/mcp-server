"""Restore only the receipt-bound legacy proxy, preserving app and database."""
import copy
import hashlib
import ipaddress
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
from caddy_bundle_identity import bundle_identity
from caddy_image_admission import qualify
from caddy_hardened_receipt import read_hardened_receipt
from caddy_legacy_profile import validate_legacy_profile
from caddy_prepared_action import PREVIOUS, read_candidate
from caddy_recovery_preflight import preflight, validate_replacement
from caddy_recovery_receipt import (MAX_RECORD, private_directory, read_caddy_snapshot, read_private,
                                    read_receipt, write_exclusive)
from caddy_unchanged_action import verify_noop
from caddy_volume_migration import inspect_one
from image_scan_intake import unique_object

ID = re.compile(r'[0-9a-f]{64}\Z')


def recovery_entry(item, kind):
    if kind == 'hardened':
        return read_hardened_receipt(item)
    candidate = read_candidate(item)
    if not isinstance(candidate, dict) or not isinstance(candidate.get('bundle'), str):
        raise ValueError('invalid recovery receipt')
    return read_receipt(item, Path(candidate['bundle']), candidate.get('bundle_identity'))


def recovery_directory(path, kind, root, previous, identity):
    if not path.exists() and not path.is_symlink():
        return []
    directory = private_directory(path)
    try:
        names = []
        with os.scandir(directory) as entries:
            for entry in entries:
                names.append(entry.name)
                if len(names) > 1000:
                    raise ValueError('recovery inventory exceeds limit')
        found = []
        for name in sorted(names):
            if not re.fullmatch(r'proxy-[0-9a-f]{32}', name):
                raise ValueError('invalid recovery inventory entry')
            record = recovery_entry(path / name, kind)
            bundle = Path(record['bundle'])
            if bundle.parent != root or not PREVIOUS.fullmatch(bundle.name):
                raise ValueError('recovery bundle is outside the deployment')
            if bundle == previous:
                if record['bundle_identity'] != identity:
                    raise ValueError('selected bundle differs from its receipt')
                found.append((kind, record, path / name))
        return found
    finally:
        os.close(directory)


def recovery_kind(root, previous):
    if previous.parent != root or not PREVIOUS.fullmatch(previous.name):
        raise ValueError('invalid selected previous bundle')
    identity = bundle_identity(previous)
    found = []
    for directory_name, kind in (('.caddy-recovery', 'legacy'), ('.caddy-hardened-recovery', 'hardened')):
        found.extend(recovery_directory(root / directory_name, kind, root, previous, identity))
    if len(found) != 1:
        raise ValueError('exactly one recovery receipt must bind the selected previous bundle')
    return found[0]


def published_port(entry):
    address = ipaddress.ip_address(entry['host_ip'])
    host = '[' + str(address) + ']' if address.version == 6 else str(address)
    return host + ':' + entry['host_port'] + ':' + entry['container_port']


def old_proxy_args(plan, instance, token, caddyfile):
    profile = plan['record']['profile']
    caddyfile = str(caddyfile)
    if ',' in caddyfile or '\n' in caddyfile:
        raise ValueError('unsupported protected Caddyfile path')
    command = ['docker', 'create', '--pull', 'never', '--name', instance + '-caddy',
               '--label', 'com.docker.compose.project=' + instance,
               '--label', 'com.docker.compose.service=caddy',
               '--label', 'org.dollhousemcp.proxy-recovery-token=' + token,
               '--restart', 'unless-stopped', '--log-driver', 'json-file',
               '--shm-size', '64m',
               '--log-opt', 'max-size=' + profile['logging']['max-size'],
               '--log-opt', 'max-file=' + profile['logging']['max-file'],
               '--network', profile['network']]
    if profile.get('kind') == 'hardened':
        command.extend(['--user', '1001:1001', '--read-only', '--cap-drop', 'ALL',
                        '--cap-add', 'NET_BIND_SERVICE', '--security-opt', 'no-new-privileges:true',
                        '--sysctl', 'net.ipv4.ip_unprivileged_port_start=1024',
                        '--tmpfs', '/tmp:noexec,nosuid,nodev,size=64M,mode=1777'])
    for alias in profile['aliases']:
        if alias == profile['container_id'][:12]:
            raise ValueError('recovery of a volatile legacy container-ID alias is unsupported')
        command.extend(['--network-alias', alias])
    for port in profile['ports']:
        command.extend(['--publish', published_port(port)])
    command.extend(['--mount', 'type=volume,src=' + profile['data_volume'] + ',dst=/data,volume-nocopy',
                    '--mount', 'type=volume,src=' + profile['config_volume'] + ',dst=/config,volume-nocopy',
                    '--mount', 'type=bind,src=' + caddyfile + ',dst=/etc/caddy/Caddyfile,readonly',
                    profile['reference'] if profile.get('kind') == 'hardened' else profile['image_id']])
    return command


def verify_recovered(run, identifier, plan, instance, token, running, caddyfile, admit=qualify):
    if not isinstance(identifier, str) or not ID.fullmatch(identifier):
        raise ValueError('recovery container identity is invalid')
    container = inspect_one(run, 'container', identifier)
    state = container.get('State')
    if container.get('Id') != identifier or not isinstance(state, dict) or state.get('Running') is not running:
        raise ValueError('recovery container state is unexpected')
    config = container.get('Config')
    if not isinstance(config, dict) or not isinstance(config.get('Labels'), dict) or config['Labels'].get('org.dollhousemcp.proxy-recovery-token') != token:
        raise ValueError('recovery container ownership is unproven')
    image = inspect_one(run, 'image', plan['record']['profile']['image_id'])
    if plan['record']['profile'].get('kind') == 'hardened':
        from caddy_hardened_profile import validate_hardened_profile
        expected = plan['record']['profile']
        admission = admit(expected['reference'])
        actual = validate_hardened_profile(container, image, admission, instance, str(caddyfile),
                                           [expected['data_volume'], expected['config_volume']], expected['ports'])
    else:
        actual = validate_legacy_profile(container, image, str(caddyfile), instance + '_default')
    expected = copy.deepcopy(plan['record']['profile'])
    expected['container_id'] = identifier
    # The daemon may add the new immutable container's short ID as an alias.
    if identifier[:12] in actual['aliases'] and identifier[:12] not in expected['aliases']:
        actual['aliases'].remove(identifier[:12])
    if actual != expected:
        raise ValueError('recovered proxy differs from its recorded runtime contract')
    return container


def public_snapshot(root, token, data):
    name = 'Caddyfile.recovery-' + token
    directory = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        fd = os.open(name, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory)
        try:
            view = memoryview(data)
            while view:
                count = os.write(fd, view)
                if count <= 0:
                    raise ValueError('failed to create recovery Caddyfile')
                view = view[count:]
            os.fchmod(fd, 0o644)
            os.fsync(fd)
            os.lseek(fd, 0, os.SEEK_SET)
            digest = hashlib.sha256()
            remaining = len(data)
            while remaining:
                block = os.read(fd, min(65536, remaining))
                if not block:
                    raise ValueError('recovery Caddyfile is truncated')
                digest.update(block)
                remaining -= len(block)
            if os.read(fd, 1) or digest.digest() != hashlib.sha256(data).digest():
                raise ValueError('recovery Caddyfile content differs from receipt')
            opened = os.fstat(fd)
            linked = os.stat(name, dir_fd=directory, follow_symlinks=False)
            if (opened.st_dev, opened.st_ino, opened.st_size) != (linked.st_dev, linked.st_ino, len(data)) or opened.st_uid != os.geteuid() or opened.st_nlink != 1:
                raise ValueError('recovery Caddyfile identity changed')
        finally:
            os.close(fd)
        os.fsync(directory)
        return root / name
    finally:
        os.close(directory)


def stop_replacement(run, plan, instance):
    identifier = plan['current_id']
    current = inspect_one(run, 'container', identifier)
    if current.get('Id') != identifier or current.get('Name') != '/' + instance + '-caddy':
        raise ValueError('replacement proxy changed before stop')
    state = current.get('State')
    if not isinstance(state, dict) or not isinstance(state.get('Running'), bool):
        raise ValueError('replacement proxy state is UNKNOWN')
    if state['Running']:
        run(['docker', 'stop', '--time', '10', identifier], 20, 65536)
    after = inspect_one(run, 'container', identifier)
    if after.get('Id') != identifier or after.get('Name') != '/' + instance + '-caddy' or after.get('State', {}).get('Running') is not False:
        raise ValueError('replacement proxy stop is UNKNOWN')


def stop_owned_recovery(run, selector, instance, token, image_id):
    candidate = inspect_one(run, 'container', selector)
    identifier = candidate.get('Id')
    config = candidate.get('Config')
    state = candidate.get('State')
    if (not isinstance(identifier, str) or not ID.fullmatch(identifier) or candidate.get('Name') != '/' + instance + '-caddy'
            or candidate.get('Image') != image_id or not isinstance(config, dict) or not isinstance(config.get('Labels'), dict)
            or config['Labels'].get('org.dollhousemcp.proxy-recovery-token') != token
            or not isinstance(state, dict) or not isinstance(state.get('Running'), bool)):
        raise ValueError('recovery container ownership is UNKNOWN')
    if state['Running']:
        run(['docker', 'stop', '--time', '5', identifier], 10, 65536)
        after = inspect_one(run, 'container', identifier)
        if after.get('Id') != identifier or after.get('State', {}).get('Running') is not False:
            raise ValueError('recovery container stop is UNKNOWN')
    return identifier


def named_containers(run, instance):
    raw = run(['docker', 'ps', '--all', '--no-trunc', '--filter',
               'name=^/' + instance + '-caddy$', '--format', '{{.ID}}'], 15, 65536)
    identifiers = raw.decode('ascii').splitlines()
    if len(identifiers) > 1 or any(not ID.fullmatch(value) for value in identifiers):
        raise ValueError('selected proxy name is ambiguous')
    return identifiers


def write_recovery_evidence(plan, token, kind, record):
    receipt_fd = private_directory(plan['receipt'])
    try:
        source = read_private(receipt_fd, 'receipt.json', MAX_RECORD)
    finally:
        os.close(receipt_fd)
    root = plan['previous'].parent
    evidence = root / '.caddy-transactions'
    try:
        evidence.mkdir(mode=0o700)
    except FileExistsError:
        pass
    directory = private_directory(evidence)
    try:
        record['previous_bundle'] = str(plan['previous'])
        record['source_receipt_sha256'] = hashlib.sha256(source).hexdigest()
        payload = json.dumps(record, sort_keys=True, separators=(',', ':')).encode()
        pending = '.' + kind + '-' + token + '.pending'
        final = kind + '-' + token + '.json'
        write_exclusive(directory, pending, payload)
        os.link(pending, final, src_dir_fd=directory, dst_dir_fd=directory, follow_symlinks=False)
        os.unlink(pending, dir_fd=directory)
        os.fsync(directory)
    finally:
        os.close(directory)


def retain_candidate_evidence(plan, token, candidate):
    """Commit protected ownership evidence before removing our failed candidate."""
    write_recovery_evidence(plan, token, 'candidate', {
        'schema': 'caddy-recovery-candidate-v1', 'token': token,
        'candidate_id': candidate, 'original_proxy_id': plan['current_id'],
        'candidate_image_id': plan['record']['profile']['image_id'],
    })


def retain_success_evidence(plan, token, restored):
    write_recovery_evidence(plan, token, 'success', {
        'schema': 'caddy-recovery-success-v1', 'token': token,
        'restored_id': restored, 'preserved_replacement_id': plan['current_id'],
        'replacement_reference': plan['image_reference'],
        'replacement_profile': plan['current_profile'],
    })


def restore_replacement(run, plan, instance, token, backup):
    """Compensate only the proxy switch, never the application or schema."""
    occupied = named_containers(run, instance)
    if occupied and occupied[0] != plan['current_id']:
        candidate = stop_owned_recovery(run, occupied[0], instance, token, plan['record']['profile']['image_id'])
        retain_candidate_evidence(plan, token, candidate)
        run(['docker', 'rm', candidate], 10, 65536)
        if named_containers(run, instance):
            raise ValueError('recovery proxy name remains occupied')
    current = inspect_one(run, 'container', plan['current_id'])
    if current.get('Id') != plan['current_id'] or current.get('Name') not in ('/' + instance + '-caddy', '/' + backup):
        raise ValueError('previous replacement proxy identity is UNKNOWN')
    normalized = copy.deepcopy(current)
    normalized['Name'] = '/' + instance + '-caddy'
    image = inspect_one(run, 'image', plan['image_reference'])
    _, _, profile = validate_replacement(normalized, image, instance, plan['image_reference'], plan['admission'], plan['record'], plan['caddyfile'])
    if profile != plan['current_profile']:
        raise ValueError('replacement proxy profile changed during recovery')
    if current['Name'] == '/' + backup:
        run(['docker', 'rename', plan['current_id'], instance + '-caddy'], 10, 65536)
    current = inspect_one(run, 'container', plan['current_id'])
    if current.get('Name') != '/' + instance + '-caddy':
        raise ValueError('replacement proxy name restoration is UNKNOWN')
    state = current.get('State', {})
    if plan['current_running'] and state.get('Running') is False:
        run(['docker', 'start', plan['current_id']], 20, 65536)
    final = inspect_one(run, 'container', plan['current_id'])
    _, running, profile = validate_replacement(final, image, instance, plan['image_reference'], plan['admission'], plan['record'], plan['caddyfile'])
    if running != plan['current_running'] or profile != plan['current_profile']:
        raise ValueError('replacement proxy state restoration is UNKNOWN')


def recover_locked(root, instance, previous, image_reference, run=docker_run, admit=qualify):
    plan = preflight(root, instance, previous, image_reference, run, admit)
    token = secrets.token_hex(16)
    # Validate every dynamic create argument before stopping the replacement.
    if read_receipt(plan['receipt'], previous, bundle_identity(previous)) != plan['record']:
        raise ValueError('recovery receipt changed before proxy stop')
    snapshot = read_caddy_snapshot(plan['receipt'], plan['record']['caddyfile_sha256'])
    caddyfile = public_snapshot(root, token, snapshot) if plan['record']['profile'].get('kind') == 'hardened' else plan['receipt'] / 'Caddyfile'
    command = old_proxy_args(plan, instance, token, caddyfile)
    backup = 'dollhouse-caddy-replaced-' + token
    try:
        stop_replacement(run, plan, instance)
        run(['docker', 'rename', plan['current_id'], backup], 10, 65536)
        renamed = inspect_one(run, 'container', plan['current_id'])
        if renamed.get('Id') != plan['current_id'] or renamed.get('Name') != '/' + backup or renamed.get('State', {}).get('Running') is not False:
            raise ValueError('replacement proxy rename is UNKNOWN')
        if named_containers(run, instance):
            raise ValueError('proxy name unexpectedly occupied after rename')
        raw = run(command, 15, 65536).decode('ascii').strip()
        verify_recovered(run, raw, plan, instance, token, False, caddyfile, admit)
        run(['docker', 'start', raw], 20, 65536)
        verify_recovered(run, raw, plan, instance, token, True, caddyfile, admit)
        retain_success_evidence(plan, token, raw)
    except BaseException as original:
        try:
            restore_replacement(run, plan, instance, token, backup)
        except Exception as cleanup:
            original.add_note('Replacement proxy restoration is UNKNOWN: ' + str(cleanup))
        raise
    return {'restored_id': raw, 'preserved_replacement_id': plan['current_id']}


def recover(value, run=docker_run, admit=qualify):
    if not isinstance(value, dict) or set(value) != {'deploy_dir', 'instance', 'data_volume', 'config_volume', 'previous', 'image'}:
        raise ValueError('invalid recovery request')
    root = validate_request({key: value[key] for key in ('deploy_dir', 'instance', 'data_volume', 'config_volume')})
    previous = Path(value['previous'])
    if not isinstance(value['image'], str):
        raise ValueError('invalid replacement image reference')
    lock = acquire_lock(root)
    try:
        kind, record, _ = recovery_kind(root, previous)
        if kind == 'hardened':
            profile = record['profile']
            if (profile['reference'] != value['image'] or profile['data_volume'] != value['data_volume']
                    or profile['config_volume'] != value['config_volume']):
                raise ValueError('selected hardened proxy differs from the recovery receipt')
            verify_noop(root, value['instance'], previous, run, admit)
            return {'outcome': 'unchanged'}
        return recover_locked(root, value['instance'], previous, value['image'], run, admit)
    finally:
        os.close(lock)


def main():
    raw = sys.stdin.buffer.read(65537)
    if len(raw) > 65536:
        raise ValueError('recovery request exceeds its size limit')
    result = recover(json.loads(raw, object_pairs_hook=unique_object))
    print(json.dumps(result, separators=(',', ':')))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('Caddy proxy recovery refused: ' + str(error), file=sys.stderr)
        for note in getattr(error, '__notes__', ()):
            print(note, file=sys.stderr)
        sys.exit(1)
