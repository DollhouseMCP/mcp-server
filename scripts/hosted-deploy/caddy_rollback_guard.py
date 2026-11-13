"""Read-only refusal of rollback that would reopen a different proxy."""
import json
from pathlib import Path
import sys

SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))
sys.dont_write_bytecode = True
from caddy_clone_action import validate_request
from caddy_recover_action import recovery_kind
from caddy_unchanged_action import verify_noop
from image_scan_intake import unique_object


def main():
    raw = sys.stdin.buffer.read(65537)
    if len(raw) > 65536:
        raise ValueError('rollback guard request exceeds its limit')
    value = json.loads(raw, object_pairs_hook=unique_object)
    fields = {'deploy_dir', 'instance', 'data_volume', 'config_volume', 'previous', 'image'}
    if not isinstance(value, dict) or set(value) != fields:
        raise ValueError('invalid rollback guard request')
    root = validate_request({key: value[key] for key in ('deploy_dir', 'instance', 'data_volume', 'config_volume')})
    previous = Path(value['previous'])
    kind, record, _ = recovery_kind(root, previous)
    if kind != 'hardened':
        raise ValueError('rollback requires a different proxy; retain the recovery point for a separately qualified plan')
    profile = record['profile']
    if (profile['reference'] != value['image'] or profile['data_volume'] != value['data_volume']
            or profile['config_volume'] != value['config_volume']):
        raise ValueError('rollback requires a different proxy; retain the recovery point for a separately qualified plan')
    verify_noop(root, value['instance'], previous)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('Caddy rollback refused before mutation: ' + str(error), file=sys.stderr)
        sys.exit(1)
