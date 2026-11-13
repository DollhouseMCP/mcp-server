"""Revalidate one protected offline clone before hosted source replacement."""
import hashlib
import json
import os
from pathlib import Path
import re
import sys

SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))
sys.dont_write_bytecode = True
from caddy_bundle_identity import bundle_identity
from caddy_clone_action import docker_run, validate_request
from caddy_image_admission import qualify
from caddy_recovery_receipt import MAX_RECORD, private_directory, read_current_caddyfile, read_private, read_receipt, unique_object
from caddy_service_guard import proxy_startup_path, unique_proxy
from caddy_volume_migration import check_local_daemon, verify_prepared

PREVIOUS = re.compile(r'server\.prev-[0-9a-f]{32}\Z')


def read_candidate(path):
    directory = private_directory(path)
    try:
        data = read_private(directory, 'receipt.json', MAX_RECORD)
    finally:
        os.close(directory)
    return json.loads(data, object_pairs_hook=unique_object)


def validated_candidate(root, recovery, name):
    if not re.fullmatch(r'proxy-[0-9a-f]{32}', name):
        raise ValueError('unsupported recovery directory entry')
    path = recovery / name
    candidate = read_candidate(path)
    if not isinstance(candidate, dict) or not isinstance(candidate.get('bundle'), str):
        raise ValueError('invalid recovery receipt')
    bundle = Path(candidate['bundle'])
    if bundle.parent != root or not PREVIOUS.fullmatch(bundle.name):
        raise ValueError('recovery bundle is outside the deployment')
    return path, bundle, read_receipt(path, bundle, candidate.get('bundle_identity'))


def find_prepared(root, current_identity, caddyfile, destination_names):
    recovery = root / '.caddy-recovery'
    directory = private_directory(recovery)
    try:
        names = []
        with os.scandir(directory) as entries:
            for entry in entries:
                names.append(entry.name)
                if len(names) > 1000:
                    raise ValueError('recovery inventory exceeds limit')
        matches = []
        for name in sorted(names):
            path, _, record = validated_candidate(root, recovery, name)
            if (record['bundle_identity'] == current_identity
                    and record['caddyfile_sha256'] == hashlib.sha256(caddyfile).hexdigest()
                    and [v['name'] for v in record['clone']['volumes'][2:]] == destination_names):
                matches.append((path, record))
        if len(matches) != 1:
            raise ValueError('exactly one matching offline clone receipt is required')
        return matches[0]
    finally:
        os.close(directory)


def verify(value, run=docker_run, admit=qualify):
    root = validate_request(value)
    check_local_daemon(run, os.environ.get('DOCKER_HOST'))
    selected = unique_proxy(run, value['instance'], root=root)
    current = bundle_identity(root / 'server')
    caddyfile = read_current_caddyfile(root)
    destinations = [value['data_volume'], value['config_volume']]
    path, record = find_prepared(root, current, caddyfile, destinations)
    if selected != record['profile']['container_id'] or unique_proxy(run, value['instance'], root=root) != selected:
        raise ValueError('selected proxy differs from the prepared clone receipt')
    previous = Path(record['bundle'])
    if previous.exists() or previous.is_symlink():
        raise ValueError('recorded previous bundle destination already exists')
    helper = Path(__file__).with_name('caddy_volume_copy.mjs')
    startup = proxy_startup_path(root, value['instance'], selected, run)
    verify_prepared(run, record['profile'], record['clone'], helper, str(startup), os.environ.get('DOCKER_HOST'), admit)
    if unique_proxy(run, value['instance'], root=root) != selected:
        raise ValueError('selected proxy changed during clone verification')
    if bundle_identity(root / 'server') != current or read_current_caddyfile(root) != caddyfile:
        raise ValueError('source or Caddyfile changed during verification')
    return previous, path


def main():
    raw = sys.stdin.buffer.read(65537)
    if len(raw) > 65536:
        raise ValueError('prepared-clone request exceeds its size limit')
    request = json.loads(raw, object_pairs_hook=unique_object)
    previous, _ = verify(request)
    print(previous)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('Caddy prepared clone refused: ' + str(error), file=sys.stderr)
        sys.exit(1)
