"""Exercise the real copier on four disposable CI volumes; no admission claim."""
import json
from pathlib import Path
import secrets
import signal
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts' / 'hosted-deploy'))
sys.path.insert(0, str(ROOT / 'scripts'))
from caddy_clone_action import docker_run
from caddy_image_admission import scanner
from caddy_volume_migration import require_helper_image, run_owned_helper, validate_copy_receipt


def main():
    names = sys.argv[1:]
    if len(names) != 4 or len(set(names)) != 4:
        raise ValueError('four distinct owned fixture volumes are required')
    helper = ROOT / 'scripts/hosted-deploy/caddy_volume_copy.mjs'
    image = require_helper_image(docker_run)

    def expired(_signum, _frame):
        raise TimeoutError('native copier fixture deadline expired')

    signal.signal(signal.SIGALRM, expired)
    signal.alarm(180)
    try:
        observed_stderr = {'start': ''}

        def observed_run(command, timeout, maximum):
            status, stdout, stderr, error = scanner.bounded_process(command, timeout, maximum, stderr_maximum=65536)
            diagnostic = stderr.decode('utf-8', errors='replace')[:1024]
            if command[:2] == ['docker', 'start']:
                observed_stderr['start'] = diagnostic
            if status != 0 or error:
                raise ValueError('fixture helper failed: ' + diagnostic)
            return stdout

        def invoke(mode=None):
            raw = run_owned_helper(observed_run, names, helper, secrets.token_hex(16), image, mode)
            return validate_copy_receipt(json.loads(raw))

        before = invoke('--verify-source')
        copied = invoke()
        after = invoke('--verify-source')
        verified = invoke('--verify')
        if before != copied or after != copied or verified != copied:
            raise ValueError('native source or copied inventory changed')
        try:
            invoke()
        except ValueError as error:
            if 'Caddy destination volume is not empty' not in str(error) + observed_stderr['start']:
                raise
        else:
            raise ValueError('nonempty destination unexpectedly accepted a second copy')
        if invoke('--verify') != copied:
            raise ValueError('refused reuse changed copied content')
        print(json.dumps({'helperImageId': image, 'inventory': copied, 'sourceUnchanged': True,
                          'copiedVerified': True, 'nonemptyReuseRefused': True}, sort_keys=True))
    finally:
        signal.alarm(0)


if __name__ == '__main__':
    main()
