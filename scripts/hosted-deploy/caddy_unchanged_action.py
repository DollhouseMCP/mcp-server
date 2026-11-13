"""Bind an unchanged, qualified live proxy to the source bundle being replaced."""
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import stat
import sys

SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))
sys.dont_write_bytecode = True
from caddy_bundle_identity import bundle_identity
from caddy_clone_action import acquire_lock, docker_run, validate_request
from caddy_hardened_profile import validate_hardened_profile
from caddy_hardened_receipt import read_hardened_receipt, write_hardened_receipt
from caddy_image_admission import REFERENCE, qualify
from caddy_recovery_receipt import SHA256, private_directory, read_current_caddyfile
from caddy_service_guard import unique_proxy
from caddy_volume_guard import refuse_writers
from caddy_volume_migration import check_local_daemon, inspect_one, inspect_volumes, running_containers
from image_scan_intake import unique_object

PREVIOUS = re.compile(r'server\.prev-[0-9a-f]{32}\Z')


def expected_ports(value):
    host = value['bind_address']
    import ipaddress
    host = str(ipaddress.ip_address(host))
    http = value['http_port']
    https = value['https_port']
    if any(not isinstance(port, str) or not re.fullmatch(r'[1-9](?a:\d){0,4}', port) or int(port) > 65535 for port in (http, https)):
        raise ValueError('invalid expected Caddy ports')
    if value['proxy_mode'] == 'caddy-tls':
        return sorted([{'container_port': '80/tcp', 'host_ip': host, 'host_port': http},
                       {'container_port': '443/tcp', 'host_ip': host, 'host_port': https}], key=lambda item: item['container_port'])
    if value['proxy_mode'] == 'caddy-http':
        return [{'container_port': http + '/tcp', 'host_ip': host, 'host_port': http}]
    raise ValueError('invalid Caddy proxy mode')


def no_other_writers(run, current_id, volumes):
    inventory = running_containers(run)
    selected = [container for container in inventory if container.get('Id') == current_id]
    if len(selected) != 1:
        raise ValueError('the qualified Caddy container is not uniquely running')
    refuse_writers([container for container in inventory if container.get('Id') != current_id], volumes)


def protected_root(root):
    path = root / '.caddy-hardened-recovery'
    try:
        path.mkdir(mode=0o700)
    except FileExistsError:
        pass
    fd = private_directory(path)
    os.close(fd)
    return path


def observe(run, admit, root, instance, image_reference, names, ports):
    check_local_daemon(run, os.environ.get('DOCKER_HOST'))
    if stat.S_IMODE((root / 'Caddyfile').lstat().st_mode) != 0o644:
        raise ValueError('hardened proxy requires its existing public Caddyfile mode')
    admission = admit(image_reference)
    image = inspect_one(run, 'image', image_reference)
    selected = unique_proxy(run, instance, root=root)
    container = inspect_one(run, 'container', selected)
    state = container.get('State')
    if not isinstance(state, dict) or state.get('Running') is not True:
        raise ValueError('the qualified Caddy proxy is not running')
    profile = validate_hardened_profile(container, image, admission, instance, str(root / 'Caddyfile'), names, ports)
    volumes = inspect_volumes(run, names)
    if (volumes[0]['device'], volumes[0]['inode']) == (volumes[1]['device'], volumes[1]['inode']):
        raise ValueError('hardened Caddy volumes alias')
    no_other_writers(run, profile['container_id'], volumes)
    return profile, volumes


def prepare(value, run=docker_run, admit=qualify):
    required = {'deploy_dir', 'instance', 'data_volume', 'config_volume', 'image', 'expected_caddy_sha256',
                'proxy_mode', 'bind_address', 'http_port', 'https_port'}
    if not isinstance(value, dict) or set(value) != required:
        raise ValueError('invalid unchanged proxy request')
    root = validate_request({key: value[key] for key in ('deploy_dir', 'instance', 'data_volume', 'config_volume')})
    image_reference, expected_hash = value['image'], value['expected_caddy_sha256']
    if not isinstance(image_reference, str) or not REFERENCE.fullmatch(image_reference):
        raise ValueError('invalid Caddy image reference')
    if not isinstance(expected_hash, str) or not SHA256.fullmatch(expected_hash):
        raise ValueError('invalid requested Caddyfile hash')
    ports = expected_ports(value)
    lock = acquire_lock(root)
    try:
        caddyfile = read_current_caddyfile(root)
        if hashlib.sha256(caddyfile).hexdigest() != expected_hash:
            raise ValueError('changed Caddyfile needs an offline migration and recovery record')
        current = bundle_identity(root / 'server')
        names = [value['data_volume'], value['config_volume']]
        profile, volumes = observe(run, admit, root, value['instance'], image_reference, names, ports)
        if bundle_identity(root / 'server') != current or read_current_caddyfile(root) != caddyfile:
            raise ValueError('source or Caddyfile changed during proxy observation')
        token = secrets.token_hex(16)
        previous = root / ('server.prev-' + token)
        if previous.exists() or previous.is_symlink():
            raise ValueError('previous source destination already exists')
        record = {'schema': 'caddy-hardened-v1', 'bundle': str(previous), 'bundle_identity': current,
                  'caddyfile_sha256': expected_hash, 'profile': profile, 'volumes': volumes}
        write_hardened_receipt(protected_root(root), record, caddyfile)
        return previous
    finally:
        os.close(lock)


def find_receipt(root, previous):
    recovery = root / '.caddy-hardened-recovery'
    directory = private_directory(recovery)
    try:
        names = []
        with os.scandir(directory) as entries:
            for entry in entries:
                names.append(entry.name)
                if len(names) > 1000:
                    raise ValueError('hardened receipt inventory exceeds limit')
        matches = []
        for name in sorted(names):
            if not re.fullmatch(r'proxy-[0-9a-f]{32}', name):
                raise ValueError('unsupported hardened receipt entry')
            record = read_hardened_receipt(recovery / name)
            if record['bundle'] == str(previous):
                matches.append(record)
        if len(matches) != 1:
            raise ValueError('exactly one hardened receipt must match the previous bundle')
        return matches[0]
    finally:
        os.close(directory)


def verify_noop(root, instance, previous, run=docker_run, admit=qualify):
    if previous.parent != root or not PREVIOUS.fullmatch(previous.name):
        raise ValueError('invalid previous source bundle')
    record = find_receipt(root, previous)
    if bundle_identity(previous) != record['bundle_identity']:
        raise ValueError('previous source bundle differs from hardened receipt')
    caddyfile = read_current_caddyfile(root)
    if hashlib.sha256(caddyfile).hexdigest() != record['caddyfile_sha256']:
        raise ValueError('live Caddyfile differs from hardened receipt')
    expected = record['profile']
    names = [expected['data_volume'], expected['config_volume']]
    profile, volumes = observe(run, admit, root, instance, expected['reference'], names, expected['ports'])
    if profile != expected or volumes != record['volumes']:
        raise ValueError('live proxy differs from hardened recovery receipt')
    return previous


def main():
    raw = sys.stdin.buffer.read(65537)
    if len(raw) > 65536:
        raise ValueError('unchanged proxy request exceeds its size limit')
    request = json.loads(raw, object_pairs_hook=unique_object)
    print(prepare(request))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('Unchanged Caddy proxy admission refused: ' + str(error), file=sys.stderr)
        for note in getattr(error, '__notes__', ()):
            print(note, file=sys.stderr)
        sys.exit(1)
