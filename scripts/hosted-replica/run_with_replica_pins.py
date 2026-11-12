#!/usr/bin/env python3
"""Run one legacy reconciliation action on a replica, bound to the replica's own evidence.

legacy_manual_recovery_import.py pins nine hashes of the evidence of one manual
recovery on the live host. They name that host's containers, boots and
volumes, so no other host can ever satisfy them. A replica has its own
containers and therefore its own evidence and its own nine hashes. This
launcher replaces the nine pins, in this process only, and then runs the real
action unchanged.

It refuses on any host that is not a declared replica (see build_replica.py),
so the live pins can never be replaced on the live host. The names of the
replaced pins are printed to standard error for the rehearsal receipt.

Run it in the private working folder that holds accepted-replica.json, the
file write_recovery_evidence.py writes:

    run_with_replica_pins.py preflight-legacy-reconciliation < input.json
    run_with_replica_pins.py prepare-legacy-reconciliation < input.json > request.json
    run_with_replica_pins.py reconcile-legacy < request.json
"""
import json
from pathlib import Path
import re
import runpy
import sys

# The tooling's identity is a hash of its folder. A bytecode cache written there would change it.
sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_replica import Refused, declared_replica

TOOLING = Path(__file__).resolve().parents[1] / 'hosted-deploy'
ACTIONS = {'preflight-legacy-reconciliation': 'legacy_reconcile_preflight.py',
           'prepare-legacy-reconciliation': 'legacy_reconcile_action.py',
           'reconcile-legacy': 'legacy_reconcile_action.py'}
PINS = 'accepted-replica.json'
SHA = re.compile(r'[0-9a-f]{64}\Z')


def replace_pins(accepted, pins):
    """Replace every pin or none: a partial replacement would mix two hosts' evidence."""
    if (not isinstance(pins, dict) or set(pins) != set(accepted)
            or any(not isinstance(value, str) or not SHA.fullmatch(value) for value in pins.values())):
        raise Refused('the replica pins must give one SHA-256 for each of: ' + ', '.join(sorted(accepted)))
    accepted.update(pins)
    return sorted(pins)


def main(argv):
    if len(argv) != 2 or argv[1] not in ACTIONS:
        raise ValueError('usage: run_with_replica_pins.py %s' % '|'.join(ACTIONS))
    declared_replica()
    pins = json.loads(Path(PINS).read_text(encoding='utf-8'))
    sys.path.insert(0, str(TOOLING))
    import legacy_manual_recovery_import as manual
    print('replica pins replaced: ' + ', '.join(replace_pins(manual.ACCEPTED, pins)), file=sys.stderr)
    script = str(TOOLING / ACTIONS[argv[1]])
    sys.argv = [script, argv[1]]
    runpy.run_path(script, run_name='__main__')
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main(sys.argv))
    except Refused as error:
        print('refused: %s' % error, file=sys.stderr)
        sys.exit(3)
