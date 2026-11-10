"""Recheck an offline Caddy clone and original proxy before replacement."""
import json
import os
from pathlib import Path
import sys

SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))
sys.dont_write_bytecode = True
from caddy_clone_action import docker_run, validate_request
from caddy_image_admission import qualify
from caddy_recovery_preflight import find_previous_receipt
from caddy_service_guard import proxy_startup_path, unique_proxy
from caddy_volume_migration import check_local_daemon, verify_prepared
from image_scan_intake import unique_object


def verify(value, run=docker_run, admit=qualify):
    keys = {'deploy_dir', 'instance', 'data_volume', 'config_volume', 'previous', 'image'}
    if not isinstance(value, dict) or set(value) != keys:
        raise ValueError('invalid prestart request')
    root = validate_request({key: value[key] for key in ('deploy_dir', 'instance', 'data_volume', 'config_volume')})
    previous = Path(value['previous'])
    _, record = find_previous_receipt(root, previous)
    expected_names = [item['name'] for item in record['clone']['volumes'][2:]]
    if expected_names != [value['data_volume'], value['config_volume']]:
        raise ValueError('selected volumes differ from the clone receipt')
    profile = record['profile']
    check_local_daemon(run, os.environ.get('DOCKER_HOST'))
    if unique_proxy(run, value['instance'], root=root) != profile['container_id']:
        raise ValueError('selected original proxy changed')
    helper = Path(__file__).with_name('caddy_volume_copy.mjs')
    # Rendering has replaced root/Caddyfile; the qualified original proxy still
    # has its separate immutable, receipt-bound old startup file.
    startup = proxy_startup_path(root, value['instance'], profile['container_id'], run, require_root_copy=False)
    verify_prepared(run, profile, record['clone'], helper, str(startup), os.environ.get('DOCKER_HOST'), admit)
    return True


def main():
    raw = sys.stdin.buffer.read(65537)
    if len(raw) > 65536:
        raise ValueError('prestart request exceeds its size limit')
    verify(json.loads(raw, object_pairs_hook=unique_object))
    print('verified')


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('Caddy prestart recheck refused: ' + str(error), file=sys.stderr)
        for note in getattr(error, '__notes__', ()):
            print(note, file=sys.stderr)
        sys.exit(1)
