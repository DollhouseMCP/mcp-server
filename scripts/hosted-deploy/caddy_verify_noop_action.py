"""Recheck a preserved hardened proxy before draining the application."""
import json
from pathlib import Path
import sys

SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))
sys.dont_write_bytecode = True
from caddy_clone_action import validate_request
from caddy_unchanged_action import find_receipt, verify_noop
from image_scan_intake import unique_object


def main():
    raw = sys.stdin.buffer.read(65537)
    if len(raw) > 65536:
        raise ValueError('proxy verification request exceeds its size limit')
    value = json.loads(raw, object_pairs_hook=unique_object)
    keys = {'deploy_dir', 'instance', 'data_volume', 'config_volume', 'previous', 'image'}
    if not isinstance(value, dict) or set(value) != keys:
        raise ValueError('invalid proxy verification request')
    root = validate_request({key: value[key] for key in ('deploy_dir', 'instance', 'data_volume', 'config_volume')})
    previous = Path(value['previous'])
    if previous.parent != root:
        raise ValueError('previous source is outside the deployment')
    record = find_receipt(root, previous)
    profile = record['profile']
    if (profile['reference'] != value['image'] or profile['data_volume'] != value['data_volume']
            or profile['config_volume'] != value['config_volume']):
        raise ValueError('proxy selection differs from the hardened receipt')
    verify_noop(root, value['instance'], previous)
    print('verified')


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('Caddy proxy recheck refused: ' + str(error), file=sys.stderr)
        sys.exit(1)
