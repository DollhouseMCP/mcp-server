"""Recheck managed fresh Caddy volumes immediately before first start."""
import json
import os
from pathlib import Path
import sys

SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))
sys.dont_write_bytecode = True
from caddy_clone_action import docker_run, validate_request
from caddy_fresh_action import verify_fresh
from caddy_image_admission import qualify
from caddy_service_guard import unique_proxy
from caddy_volume_migration import check_local_daemon, require_helper_image
from image_scan_intake import unique_object


def verify(value, run=docker_run, admit=qualify):
    keys = {'deploy_dir', 'instance', 'data_volume', 'config_volume', 'image'}
    if not isinstance(value, dict) or set(value) != keys:
        raise ValueError('invalid fresh Caddy recheck request')
    root = validate_request({key: value[key] for key in ('deploy_dir', 'instance', 'data_volume', 'config_volume')})
    check_local_daemon(run, os.environ.get('DOCKER_HOST'))
    if unique_proxy(run, value['instance'], required=False) is not None:
        raise ValueError('an unexpected Caddy service already exists')
    helper = require_helper_image(run)
    admission = admit(value['image'])
    return verify_fresh(run, root, value['instance'], admission, [value['data_volume'], value['config_volume']], helper)


def main():
    raw = sys.stdin.buffer.read(65537)
    if len(raw) > 65536:
        raise ValueError('fresh Caddy recheck request exceeds its size limit')
    print(verify(json.loads(raw, object_pairs_hook=unique_object)))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('Fresh Caddy recheck refused: ' + str(error), file=sys.stderr)
        for note in getattr(error, '__notes__', ()):
            print(note, file=sys.stderr)
        sys.exit(1)
