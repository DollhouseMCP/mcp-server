"""Run every read-only control of legacy reconciliation, report each outcome and change nothing.

reconcile-legacy stops at its first refusal, so one attempt can reveal only one
defect. This action runs the same controls, from request generation to the
point where reconciliation would first write, and keeps going after a refusal.
A control whose input was refused is reported as NOT_RUN and names that input.

It never creates the reconciliation operation, stages or installs a file, or
issues a Docker command that changes a container, volume or image: every Docker
command passed to a control goes through an allowlist of observations. It holds
the deployment lock while it runs, and refuses if the lock file does not already
exist. Its only write is one private temporary directory for the Compose model,
outside the deployment and memory-backed where /run exists, removed before exit.

The lock is an flock on a descriptor that no child process inherits, so it is
released on every exit path: return, refusal, a handled termination signal, and
a kill, where the kernel closes the descriptor. Only a kill can leave the
temporary directory behind; it stays private to root.

A complete PASS is not a reconciliation and authorizes nothing.
"""
import json
import os
from pathlib import Path
import shutil
import signal
import stat
import sys
import tempfile
import time

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from caddy_active_config import system_docker, validate_system
from caddy_clone_action import acquire_lock, validate_request
from caddy_image_admission import qualify
from caddy_recovery_receipt import MAX_RECORD
from caddy_transition_state import read_state
from image_scan_intake import unique_object
import legacy_control_compose as compose
import legacy_control_resolution as resolution
import legacy_handoff as handoff
import legacy_manual_recovery_import as manual
import legacy_reconcile_action as action
import legacy_reconcile_files as files
import legacy_recovery_action as recovery
import legacy_recovery_boundary as boundary
from legacy_reconciliation_request import generate

SCHEMA = 'legacy-reconciliation-preflight-v1'
INPUT_KEYS = {'deploy_dir', 'instance', 'checkpoint_dir', 'manual_evidence_dir'}
PASS, REFUSED, NOT_RUN = 'PASS', 'REFUSED', 'NOT_RUN'
# Docker observations only. exec is limited by its callers to schema dumps, one
# read-only query and the application's own loopback health requests.
OBSERVATIONS = {('ps',), ('inspect',), ('exec',), ('info',), ('container', 'inspect'), ('image', 'inspect'),
                ('volume', 'inspect'), ('volume', 'ls'), ('context', 'inspect')}


MEMORY = Path('/run')


def exit_on_signal():
    """Turn a termination signal into an ordinary exit, so every finally block still runs."""
    def stop(number, _frame):
        raise SystemExit(128 + number)
    for number in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(number, stop)


def observing(run):
    """Refuse, before Docker sees it, any command that is not an observation."""
    def guarded(argv, timeout, maximum):
        if argv[:1] != ['docker'] or not {tuple(argv[1:2]), tuple(argv[1:3])} & OBSERVATIONS:
            raise ValueError('preflight refused a Docker command that is not an observation: ' + ' '.join(argv[:3]))
        return run(argv, timeout, maximum)
    return guarded


class Report:
    """Outcomes in the order the controls ran. A refusal never stops the next control."""

    def __init__(self):
        self.controls = []
        self.values = {}

    def skip(self, name, missing):
        self.controls.append({'control': name, 'outcome': NOT_RUN, 'needs': list(missing)})

    def control(self, name, check, needs=()):
        missing = [need for need in needs if need not in self.values]
        if missing:
            return self.skip(name, missing)
        started = time.monotonic()
        try:
            self.values[name] = check()
        except Exception as error:  # Every refusal is a finding; the remaining controls still run.
            self.controls.append({'control': name, 'outcome': REFUSED, 'reason': str(error)[:2000],
                                  'seconds': round(time.monotonic() - started, 3)})
            return None
        self.controls.append({'control': name, 'outcome': PASS, 'seconds': round(time.monotonic() - started, 3)})
        return self.values[name]

    def count(self, outcome):
        return sum(item['outcome'] == outcome for item in self.controls)


def pinned_helper(root):
    if resolution.IMPLEMENTATION.is_relative_to(root / 'server'):
        raise ValueError('reconciliation requires a pinned helper outside the replaced source cache')


def native_host():
    validate_system()
    if os.uname().machine != 'x86_64':
        raise ValueError('reconciliation requires the qualified native AMD64 legacy host')


def existing_lock(root):
    """The real action would create a missing lock file. A preflight must not."""
    info = (root / '.caddy-deploy.lock').lstat()
    if not stat.S_ISREG(info.st_mode):
        raise ValueError('deployment lock is unsafe')
    return acquire_lock(root, allow_control=True)


def generated_request(root, value, run):
    """The request exactly as prepare-legacy-reconciliation generates it, then split as reconcile-legacy does."""
    request = generate(root, value['instance'], value['checkpoint_dir'], value['manual_evidence_dir'], run)
    validate_request({key: request[key] for key in ('deploy_dir', 'instance', 'data_volume', 'config_volume')})
    identities = request.pop('receipt_identities')
    if set(request) != boundary.KEYS | {'manual_evidence_dir'}:
        raise ValueError('invalid reconciliation request')
    evidence = request.pop('manual_evidence_dir')
    if (any(not isinstance(item, str) for item in request.values()) or not boundary.TOKEN.fullmatch(request['token'])
            or any(not handoff.SHA.fullmatch(request[key]) for key in ('app_id', 'postgres_id'))
            or not isinstance(evidence, str) or identities is None):
        raise ValueError('invalid reconciliation identity')
    return request, evidence, identities


def operation_absent(root, token):
    path = resolution.operation_path(root, token)
    if os.path.lexists(path):
        raise ValueError('a reconciliation operation already exists for this transition')


def compose_model(root, instance, data, verify_compose):
    """Resolve the same private Compose model that reconciliation stages, from a temporary copy."""
    model = handoff.encoded(compose.model(instance, data['app'], data['postgres'], data['proxy'])) + b'\n'
    # The model carries the services' literal environment, so keep it off persistent storage.
    memory = MEMORY if MEMORY.is_dir() and os.access(MEMORY, os.W_OK) else None
    directory = Path(tempfile.mkdtemp(prefix='legacy-reconcile-preflight-', dir=memory))
    try:
        files.save(directory, 'compose.yml', model)
        verify_compose(directory / 'compose.yml', root, instance, data)
    finally:
        shutil.rmtree(directory)


def observed(root, value, data):
    """Everything reconciliation would later compare, so that the last control can prove it is unchanged."""
    return {'state': handoff.digest(resolution.raw_state(root)), 'files': files.live_inventory(root),
            'markers': action.marker_inventory(root, value, data)}


def recovery_data(report, root, run):
    """Every adoption step as its own control, then the data reconciliation derives from them.

    A step stores its observation before it validates it. So a refused step
    still lets the later controls run, and only a missing observation stops them.
    """
    value, evidence, identities = report.values['request']
    found = {}
    for name, needs, step in manual.adoption_steps(root, value, evidence, run, identities, found):
        missing = [need for need in needs if need not in found]
        if missing:
            report.skip(name, ['observation: ' + need for need in missing])
        else:
            report.control(name, step)
    return report.control('recovery_data', lambda: manual.adopted(found))


def dependent_controls(report, root, run, admit, public, verify_compose):
    """Controls that need the generated request and the accepted recovery data."""
    value = report.values['request'][0]
    instance = value['instance']
    data = recovery_data(report, root, run)
    report.control('recovery_receipt', lambda: action.original_receipt(root, data), needs=('recovery_data',))
    report.control('failed_state', lambda: action.failed_state(root, data), needs=('recovery_data',))
    report.control('handoff_markers', lambda: observed(root, value, data), needs=('recovery_data',))
    report.control('operation_absent', lambda: operation_absent(root, value['token']))
    needs = ('recovery_data', 'recovery_receipt')
    if all(need in report.values for need in needs):
        original, receipt = report.values['recovery_receipt']
        for name, proof in action.serving_proofs(root, value, data, original, receipt, run, admit):
            report.control(name, proof)
    else:
        for name in action.SERVING_PROOFS:
            report.control(name, None, needs=needs)
    report.control('public_acceptance', lambda: public(data['pending']['control']['public_origin']),
                   needs=('recovery_data',))
    report.control('compose_model', lambda: compose_model(root, instance, data, verify_compose),
                   needs=('recovery_data',))

    def unchanged():
        if observed(root, value, data) != report.values['handoff_markers']:
            raise ValueError('failed controls, handoff markers or deployment files changed during the preflight')
    report.control('unchanged', unchanged, needs=('handoff_markers',))


def preflight(value, run=system_docker, admit=qualify, public=recovery.public_acceptance,
              verify_compose=action.check_compose, host=native_host):
    report = Report()
    run = observing(run)
    root = Path(value['deploy_dir'])
    report.control('pinned_helper', lambda: pinned_helper(root))
    report.control('native_host', host)

    def bound_root():
        # As request preparation does: the retained transition names the volumes of this deployment.
        pending = read_state(root).get('pending')
        if not isinstance(pending, dict):
            raise ValueError('request preparation requires a retained transition')
        return validate_request({'deploy_dir': value['deploy_dir'], 'instance': value['instance'],
                                 'data_volume': pending['volumes'][0], 'config_volume': pending['volumes'][1]})
    root = report.control('retained_transition', bound_root) or root
    lock = report.control('deployment_lock', lambda: existing_lock(root), needs=('retained_transition',))
    try:
        report.control('request', lambda: generated_request(root, value, run), needs=('deployment_lock',))
        if 'request' in report.values:
            dependent_controls(report, root, run, admit, public, verify_compose)
        else:
            for name in (*manual.ADOPTION, 'recovery_data', 'recovery_receipt', 'failed_state', 'handoff_markers',
                         'operation_absent', *action.SERVING_PROOFS, 'public_acceptance', 'compose_model', 'unchanged'):
                report.control(name, None, needs=('request',))
    finally:
        if lock is not None:
            os.close(lock)
    return {'schema': SCHEMA, 'host': handoff.host_identity(), 'instance': value['instance'],
            'implementation': resolution.bundle_identity(resolution.IMPLEMENTATION),
            'controls': report.controls, 'passed': report.count(PASS), 'refused': report.count(REFUSED),
            'not_run': report.count(NOT_RUN), 'complete': report.count(PASS) == len(report.controls)}


def main():
    if sys.argv[1:] != ['preflight-legacy-reconciliation']:
        raise ValueError('explicit preflight action required')
    raw = sys.stdin.buffer.read(MAX_RECORD + 1)
    if len(raw) > MAX_RECORD:
        raise ValueError('preflight input exceeds its bound')
    value = json.loads(raw, object_pairs_hook=unique_object)
    if (not isinstance(value, dict) or set(value) != INPUT_KEYS
            or any(not isinstance(item, str) for item in value.values())):
        raise ValueError('preflight accepts paths and instance only, never tokens')
    exit_on_signal()
    result = preflight(value)
    print(json.dumps(result, indent=1))
    return 0 if result['complete'] else 3


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as error:
        print('Legacy reconciliation preflight could not run: ' + str(error), file=sys.stderr)
        sys.exit(1)
