"""Bring the same legacy proxy back after an abandoned offline preparation, or accept its restart.

prepare-caddy-offline stops the serving proxy and leaves ingress closed. Until
the update that follows has begun, nothing else can reopen it: there is no
completed transition to recover from. And a reconciled legacy proxy is bound to
one boot, so even the same container, started again by hand, is refused by
every later action.

Two explicit actions close that gap. Neither replaces a proxy, changes a
volume, a source bundle or the reconciled records, or begins a transition.

abandon-caddy-offline
    The proxy that the offline preparation stopped is still the one in the
    prepared clone receipt, with its full profile, stopped cleanly, and its
    ports are free. It is started once. Its active configuration must equal
    the receipt's Caddyfile and the public legacy acceptance must pass within
    bounded waits. If either fails, the proxy is stopped once more, without
    force, and the action refuses: ingress is closed again, as before.

accept-caddy-restart
    The reconciled serving proxy is running, but with another boot than the
    recorded one: Docker or the host restarted. Nothing is started. The same
    container, name and full profile, the same active configuration and the
    public acceptance are required. The receipt records the host's and the
    Docker daemon's start times, so that an unexplained restart is visible.

Each action keeps a private journal in .caddy-serving-boots and, for a
reconciled proxy, writes one boot record beside the reconciled serving record.
caddy_retired_proxy.serving_boot follows those records, so a later preparation
accepts the proxy's new boot and nothing else.
"""
import datetime
import json
import os
from pathlib import Path
import secrets
import sys
import time

SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))
sys.dont_write_bytecode = True
from caddy_clone_action import acquire_lock, docker_run, validate_request
from caddy_image_admission import qualify
from caddy_prepared_action import read_candidate, verify as verify_prepared
from caddy_recovery_receipt import private_directory, read_private, write_exclusive, MAX_RECORD
from caddy_release_action import public_origin
import caddy_retired_proxy as retired
from caddy_service_guard import unique_proxy
from caddy_transition_state import read_state
from caddy_volume_migration import check_local_daemon, inspect_one
from image_scan_intake import unique_object
import legacy_handoff as handoff
from legacy_recovery_guards import ingress_available, lifecycle
from legacy_recovery_profile import profile, same_profile

ACTIONS = ('abandon-caddy-offline', 'accept-caddy-restart')
READY_WAIT = 30
ACCEPT_WAIT = 60
EXPLAINED_WITHIN = 300
DOCKER_PID = '/var/run/docker.pid'


def utc(seconds):
    return datetime.datetime.fromtimestamp(seconds, datetime.timezone.utc).isoformat()


def serving_config(identifier, receipt, record, boot):
    from legacy_recovery_checks import serving_config as check
    check(identifier, receipt, record, boot)


def public_acceptance(origin):
    from legacy_recovery_action import public_acceptance as accept
    return accept(origin)


def within(seconds, check, sleep=time.sleep):
    """Repeat a check until it passes. The wait is an enforced bound, never a measured margin."""
    deadline = time.monotonic() + seconds
    while True:
        try:
            return check()
        except (ValueError, OSError):
            if time.monotonic() >= deadline:
                raise
            sleep(0.5)


def require_no_transition(root):
    from legacy_control_resolution import unresolved_pending
    if unresolved_pending(root, read_state(root)) is not None:
        raise ValueError('a Caddy transition is pending; use its own recovery')


def begin(root, kind, issued):
    """A new private journal for one action, with its intent recorded before anything changes."""
    parent = root / retired.BOOTS
    parent.mkdir(mode=0o700, exist_ok=True)
    owner = private_directory(parent)
    try:
        name = kind + '-' + secrets.token_hex(16)
        os.mkdir(name, 0o700, dir_fd=owner)
        os.fsync(owner)
    finally:
        os.close(owner)
    journal(parent / name, 'issued.json', issued)
    return parent / name


def journal(operation, name, value):
    directory = private_directory(operation)
    try:
        write_exclusive(directory, name, handoff.encoded(value))
        os.fsync(directory)
    finally:
        os.close(directory)


def record_boot(root, instance, identifier, operation, previous, boot, reason, evidence):
    """The action's final receipt and, for a reconciled proxy, the boot record that the receipt authorizes."""
    bound = None
    if retired.serving_record(root, instance, identifier) is not None:
        directory = private_directory(root / retired.DIRECTORY)
        try:
            serving_raw = read_private(directory, 'serving-' + identifier + retired.JSON_SUFFIX, MAX_RECORD)
        finally:
            os.close(directory)
        bound = {'schema': retired.BOOT_SCHEMA, 'host': handoff.host_identity(), 'instance': instance, 'id': identifier,
                 'previous': previous, 'boot': boot, 'serving_sha256': handoff.digest(serving_raw), 'reason': reason}
    receipt = {'schema': 'serving-proxy-boot-receipt-v1', 'host': handoff.host_identity(), 'instance': instance,
               'id': identifier, 'previous': previous, 'boot': boot, 'reason': reason, 'boot_record': bound, **evidence}
    journal(operation, retired.BOOT_RECEIPT, receipt)
    if bound is not None:
        authority = {'path': str(operation / retired.BOOT_RECEIPT), 'sha256': handoff.digest(handoff.encoded(receipt))}
        directory = private_directory(root / retired.DIRECTORY)
        try:
            write_exclusive(directory, 'boot-%s-%s.json' % (identifier, operation.name.rsplit('-', 1)[1]),
                            handoff.encoded({**bound, 'authority': authority}))
            os.fsync(directory)
        finally:
            os.close(directory)
    return receipt


def started(run, before):
    """Start the stopped proxy once. Only its own ID is an acknowledgement."""
    identifier = before['Id']
    output = run(['docker', 'start', identifier], 30, 65536)
    if output not in (identifier.encode('ascii'), (identifier + '\n').encode('ascii')):
        raise ValueError('proxy start acknowledgement is UNKNOWN')
    current = inspect_one(run, 'container', identifier)
    if current.get('Id') != identifier or not same_profile(profile(current), profile(before)):
        raise ValueError('started proxy differs from the stopped one')
    boot = lifecycle(current, True)
    if boot['started_at'] == before['State']['StartedAt']:
        raise ValueError('proxy start produced no new boot')
    return boot


def fence(run, identifier, operation, error):
    """One non-forcing stop after a failed verification: ingress is closed again, as it was."""
    journal(operation, 'refused.json', {'error': str(error)[:2000], 'compensation': 'one non-forcing stop'})
    run(['docker', 'stop', '--signal', 'SIGTERM', '--timeout', '-1', identifier], 60, 65536)
    lifecycle(inspect_one(run, 'container', identifier), False)
    journal(operation, 'fenced.json', {'id': identifier, 'stopped': True, 'no_retry': True})


def abandon(root, value, origin, run, admit, config, public, sleep=time.sleep):
    request = {key: value[key] for key in ('deploy_dir', 'instance', 'data_volume', 'config_volume')}
    instance = value['instance']
    # The existing check of a prepared clone: the selected proxy is the receipt's, stopped, with its full profile.
    _, receipt = verify_prepared(request, run, admit)
    record = read_candidate(receipt)
    identifier = record['profile']['container_id']
    before = inspect_one(run, 'container', identifier)
    previous = lifecycle(before, False)
    ingress_available(run, record['profile']['ports'])
    if unique_proxy(run, instance, root=root) != identifier:
        raise ValueError('selected proxy changed before the start')
    operation = begin(root, 'abandon', {'action': ACTIONS[0], 'id': identifier, 'previous': previous,
                                        'prepared_receipt': str(receipt), 'profile_sha256': handoff.digest(
                                            handoff.encoded(record['profile']))})
    boot = started(run, before)
    journal(operation, 'started.json', {'id': identifier, 'boot': boot})
    try:
        within(READY_WAIT, lambda: config(identifier, receipt, record, boot), sleep)
        results = within(ACCEPT_WAIT, lambda: public(origin), sleep)
        if lifecycle(inspect_one(run, 'container', identifier), True) != boot:
            raise ValueError('proxy boot changed during verification')
    except BaseException as error:
        fence(run, identifier, operation, error)
        raise
    record_boot(root, instance, identifier, operation, previous, boot, 'abandoned-offline-preparation',
                {'prepared_receipt': str(receipt), 'public': results})
    return {'outcome': 'ABANDONED', 'proxy_id': identifier, 'ingress': 'open', 'receipt': str(operation / retired.BOOT_RECEIPT)}


def restart_evidence(boot, now=None):
    """What can explain a restart: when the host and the Docker daemon started. Unknown stays unknown."""
    evidence = {'observed_utc': utc(time.time() if now is None else now), 'host_boot_utc': None,
                'docker_daemon_started_utc': None, 'explained_by': None}
    try:
        with open('/proc/stat', encoding='ascii') as stream:
            host = next(int(line.split()[1]) for line in stream if line.startswith('btime '))
        evidence['host_boot_utc'] = utc(host)
        pid = int(Path(DOCKER_PID).read_text(encoding='ascii').strip())
        # Field 22 of /proc/<pid>/stat, after the parenthesised command name: start time in clock ticks since boot.
        ticks = int(Path('/proc/%d/stat' % pid).read_text(encoding='ascii').rsplit(')', 1)[1].split()[19])
        daemon = host + ticks / os.sysconf('SC_CLK_TCK')
        evidence['docker_daemon_started_utc'] = utc(daemon)
        text = boot['started_at']
        proxy = datetime.datetime.fromisoformat(text[:19] + '+00:00').timestamp()
        if 0 <= proxy - daemon <= EXPLAINED_WITHIN:
            evidence['explained_by'] = 'host boot' if 0 <= daemon - host <= EXPLAINED_WITHIN else 'Docker daemon start'
    except (OSError, ValueError, StopIteration):
        pass
    return evidence


def accept(root, value, origin, run, config, public, sleep=time.sleep):
    instance = value['instance']
    identifier = unique_proxy(run, instance, root=root)
    serving = retired.serving_record(root, instance, identifier)
    if serving is None:
        raise ValueError('no reconciled serving proxy record binds a boot; nothing to accept')
    current = inspect_one(run, 'container', identifier)
    if current.get('Id') != identifier or current.get('Name') != '/' + instance + '-caddy' or not same_profile(profile(current), serving['profile']):
        raise ValueError('running proxy is not the reconciled serving proxy')
    boot = lifecycle(current, True)
    previous = retired.serving_boot(root, instance, identifier, serving)
    if boot == previous:
        raise ValueError('the serving proxy still has its recorded boot; nothing to accept')
    operation = begin(root, 'accept', {'action': ACTIONS[1], 'id': identifier, 'previous': previous, 'boot': boot})
    startup = Path(serving['caddyfile']).parent
    within(READY_WAIT, lambda: config(identifier, startup, {'caddyfile_sha256': serving['caddyfile_sha256']}, boot), sleep)
    results = within(ACCEPT_WAIT, lambda: public(origin), sleep)
    if lifecycle(inspect_one(run, 'container', identifier), True) != boot or unique_proxy(run, instance, root=root) != identifier:
        raise ValueError('proxy boot changed during verification')
    receipt = record_boot(root, instance, identifier, operation, previous, boot, 'accepted-restart',
                          {'restart': restart_evidence(boot), 'public': results})
    return {'outcome': 'ACCEPTED', 'proxy_id': identifier, 'explained_by': receipt['restart']['explained_by'],
            'receipt': str(operation / retired.BOOT_RECEIPT)}


def act(action, value, run=docker_run, admit=qualify, config=serving_config, public=public_acceptance):
    keys = {'deploy_dir', 'instance', 'data_volume', 'config_volume', 'image', 'public_base_url'}
    if action not in ACTIONS or not isinstance(value, dict) or set(value) != keys:
        raise ValueError('invalid serving proxy boot request')
    origin = public_origin(value['public_base_url'])
    root = validate_request({key: value[key] for key in ('deploy_dir', 'instance', 'data_volume', 'config_volume')})
    lock = acquire_lock(root)
    try:
        check_local_daemon(run, os.environ.get('DOCKER_HOST'))
        require_no_transition(root)
        if action == ACTIONS[0]:
            return abandon(root, value, origin, run, admit, config, public)
        return accept(root, value, origin, run, config, public)
    finally:
        os.close(lock)


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in ACTIONS:
        raise ValueError('explicit abandon-caddy-offline or accept-caddy-restart action required')
    raw = sys.stdin.buffer.read(65537)
    if len(raw) > 65536:
        raise ValueError('serving proxy boot request exceeds its size limit')
    print(json.dumps(act(sys.argv[1], json.loads(raw, object_pairs_hook=unique_object)), sort_keys=True, separators=(',', ':')))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('Serving proxy boot action refused; ingress may be closed: ' + str(error), file=sys.stderr)
        for note in getattr(error, '__notes__', ()):
            print(note, file=sys.stderr)
        sys.exit(1)
