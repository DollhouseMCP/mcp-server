"""Start a prepared proxy without letting Compose act on retained labels."""
import os
from pathlib import Path
import stat
import time

from caddy_active_config import read_snapshots, validate_system
from caddy_hardened_profile import validate_hardened_profile
from caddy_recover_action import named_containers, old_proxy_args, recovery_kind
from caddy_recovery_receipt import private_directory, read_current_caddyfile, write_exclusive
from caddy_release_action import pending_control
from caddy_retired_proxy import inventory, register
from caddy_service_guard import proxy_startup_path, unique_proxy
from caddy_unchanged_action import no_other_writers
from caddy_volume_guard import refuse_writers
from caddy_volume_migration import inspect_one, inspect_volumes, running_containers, verify_prepared
import legacy_handoff as handoff
from legacy_recovery_boundary import TOKEN
from caddy_transition_action import sync_root
from legacy_recovery_guards import exact_container, ingress_available, lifecycle
from legacy_recovery_profile import profile

DIRECTORY = '.caddy-native-replacements'
REPLACEMENT_PREFIX = 'replace-'


def replacement_path(root, token):
    if not isinstance(token, str) or not TOKEN.fullmatch(token):
        raise ValueError('invalid native replacement token')
    return root / DIRECTORY / (REPLACEMENT_PREFIX + token)


def record(path, name, value):
    directory = private_directory(path)
    try:
        write_exclusive(directory, name + '.json', handoff.encoded(value))
        os.fsync(directory)
    finally:
        os.close(directory)


def once(path, name, argv, run, timeout):
    record(path, name + '-issued', {'operation': argv[1]})
    started = time.monotonic()
    try:
        raw = run(argv, timeout, 65536)
    except BaseException as error:
        record(path, name + '-failed', {'elapsed_seconds': time.monotonic() - started,
                                        'error': str(error), 'outcome': 'refused or UNKNOWN; no retry'})
        raise
    record(path, name + '-acknowledged', {'elapsed_seconds': time.monotonic() - started,
                                          'stdout_sha256': handoff.digest(raw), 'exit_code': 0})
    return raw


def validate_startup(root, token, control):
    _, verification = read_snapshots(root, token, control)
    startup = root / 'Caddyfile'
    if read_current_caddyfile(root) != verification or stat.S_IMODE(startup.lstat().st_mode) != 0o644:
        raise ValueError('prepared native Caddy startup file differs')
    return startup


def operation_directory(root, token):
    path = replacement_path(root, token)
    parent = path.parent
    parent.mkdir(mode=0o700, exist_ok=True)
    owner = private_directory(parent)
    try:
        os.mkdir(path.name, 0o700, dir_fd=owner)
        os.fsync(owner)
    finally:
        os.close(owner)
    sync_root(root)
    return path


def checked_candidate(run, identifier, expected, running):
    container = inspect_one(run, 'container', identifier)
    if (container.get('Id') != identifier or container.get('State', {}).get('Running') is not running
            or container.get('Config', {}).get('Labels', {}).get('org.dollhousemcp.proxy-recovery-token') != expected['token']):
        raise ValueError('native Caddy candidate ownership or lifecycle is UNKNOWN')
    validate_hardened_profile(container, expected['image'], expected['admission'], expected['instance'],
                              str(expected['startup']), expected['names'], expected['ports'])
    return container


def prepare_replacement(root, value, pending, control, run, admit):
    instance, token = value['instance'], pending['token']
    kind, original, receipt = recovery_kind(root, Path(pending['previous']))
    if kind != 'legacy' or str(receipt) != pending['receipt']:
        raise ValueError('native replacement requires the selected original legacy receipt')
    old_profile = original['profile']
    identifier = unique_proxy(run, instance, root=root)
    if identifier != old_profile['container_id']:
        raise ValueError('stopped original proxy differs from the clone receipt')
    old = inspect_one(run, 'container', identifier)
    boot = lifecycle(old, False)
    full = profile(old)
    old_startup = proxy_startup_path(root, instance, identifier, run, require_root_copy=False)
    helper = Path(__file__).with_name('caddy_volume_copy.mjs')
    verify_prepared(run, old_profile, original['clone'], helper, str(old_startup), os.environ.get('DOCKER_HOST'), admit)
    startup = validate_startup(root, token, control)
    admission = admit(pending['image'])
    if admission != pending['admission'] or admission != value['admission']:
        raise ValueError('native replacement image admission changed')
    image = inspect_one(run, 'image', admission['store_id'])
    names = pending['volumes']
    volumes = original['clone']['volumes'][2:]
    if [item['name'] for item in volumes] != names or inspect_volumes(run, names) != volumes:
        raise ValueError('native replacement destination volumes changed')
    ports = old_profile['ports']
    ingress_available(run, ports)
    refuse_writers(running_containers(run), volumes)
    return {'instance': instance, 'token': token, 'image': image, 'admission': admission,
            'reference': pending['image'], 'startup': startup, 'names': names, 'volumes': volumes,
            'ports': ports, 'original_id': identifier, 'original_profile': full, 'boot': boot,
            'clone_receipt': str(receipt), 'clone_receipt_sha256': pending['receipt_sha256'],
            'logging': old_profile['logging']}


def retain_original(root, operation, expected, run):
    instance, token, identifier = expected['instance'], expected['token'], expected['original_id']
    full, boot = expected['original_profile'], expected['boot']
    retained = instance + '-caddy-retained-' + token
    record(operation, 'baseline', {key: expected[key] for key in (
        'original_id', 'original_profile', 'boot', 'clone_receipt', 'clone_receipt_sha256', 'reference', 'volumes')})
    exact_container(run, identifier, full, instance + '-caddy', False, boot)
    if once(operation, 'retain-original', ['docker', 'rename', identifier, retained], run, 15):
        raise ValueError('native original proxy rename acknowledgement differs')
    exact_container(run, identifier, full, retained, False, boot)
    authority = {'schema': 'qualified-proxy-retirement-v1', 'host': handoff.host_identity(), 'instance': instance,
                 'retired': {'id': identifier, 'name': retained, 'profile': full, 'boot': boot}}
    record(operation, 'retirement-authority', authority)
    register(root, instance, identifier, retained, operation / 'retirement-authority.json', run)


def create_candidate(root, operation, expected, run):
    instance, token = expected['instance'], expected['token']
    if named_containers(run, instance) or unique_proxy(run, instance, required=False, root=root) is not None:
        raise ValueError('native replacement name or service ownership is not free')
    spec = {'kind': 'hardened', 'network': instance + '_default', 'aliases': ['caddy', instance + '-caddy'],
            'container_id': expected['original_id'], 'ports': expected['ports'],
            'data_volume': expected['names'][0], 'config_volume': expected['names'][1],
            'reference': expected['reference'], 'logging': expected['logging']}
    plan = {'record': {'profile': spec}}
    raw = once(operation, 'create-proxy', old_proxy_args(plan, instance, token, expected['startup']), run, 30)
    candidate = raw.decode('ascii').strip()
    if not handoff.SHA.fullmatch(candidate) or raw != (candidate + '\n').encode():
        raise ValueError('native proxy create identity is UNKNOWN')
    before = checked_candidate(run, candidate, expected, False)
    if type(before.get('RestartCount')) is not int or before['RestartCount'] != 0:
        raise ValueError('new native proxy restart count differs')
    record(operation, 'created', {'id': candidate, 'profile': profile(before)})
    return candidate


def fence_failed_start(operation, candidate, expected, run):
    actual = inspect_one(run, 'container', candidate)
    running = actual.get('State', {}).get('Running')
    if type(running) is not bool:
        raise ValueError('native proxy start is UNKNOWN; independent fencing required')
    checked_candidate(run, candidate, expected, running)
    if running:
        result = once(operation, 'fence-failed-start',
                      ['docker', 'stop', '--signal', 'SIGTERM', '--timeout', '-1', candidate], run, 60)
        if result != (candidate + '\n').encode():
            raise ValueError('native failed-start fence acknowledgement is UNKNOWN')
        stopped = checked_candidate(run, candidate, expected, False)
        record(operation, 'failed-start-fenced', {'id': candidate, 'profile': profile(stopped),
                                                   'boot': lifecycle(stopped, False)})


def verify_failed_start_fence(root, token, current):
    """Use only our known compensating stop, never a later inferred start."""
    path = replacement_path(root, token)
    owner = private_directory(path)
    try:
        proof, _ = handoff.read_json(owner, 'failed-start-fenced.json')
        ack, _ = handoff.read_json(owner, 'fence-failed-start-acknowledged.json')
    finally:
        os.close(owner)
    identity = current['Id']
    if (proof != {'id': identity, 'profile': profile(current), 'boot': lifecycle(current, False)}
            or ack.get('exit_code') != 0 or ack.get('stdout_sha256') != handoff.digest((identity + '\n').encode())
            or current.get('Config', {}).get('Labels', {}).get('org.dollhousemcp.proxy-recovery-token') != token):
        raise ValueError('native failed-start offline fence is UNKNOWN')


def start_candidate(root, operation, candidate, expected, control, run):
    if (unique_proxy(run, expected['instance'], root=root) != candidate
            or inspect_volumes(run, expected['names']) != expected['volumes']):
        raise ValueError('native replacement ownership or volumes changed before start')
    validate_startup(root, expected['token'], control)
    ingress_available(run, expected['ports'])
    refuse_writers(running_containers(run), expected['volumes'])
    try:
        if once(operation, 'start-proxy', ['docker', 'start', candidate], run, 30) != (candidate + '\n').encode():
            raise ValueError('native proxy start acknowledgement is UNKNOWN')
        running = checked_candidate(run, candidate, expected, True)
        boot = lifecycle(running, True)
        if boot['restart_count'] != 0:
            raise ValueError('new native proxy restarted before acknowledgement')
        no_other_writers(run, candidate, expected['volumes'])
        record(operation, 'started', {'id': candidate, 'boot': boot})
    except BaseException:
        fence_failed_start(operation, candidate, expected, run)
        raise


def replace(root, value, pending, control, run, admit):
    expected = prepare_replacement(root, value, pending, control, run, admit)
    operation = operation_directory(root, expected['token'])
    retain_original(root, operation, expected, run)
    if pending_control(root, expected['token'], 'prepared')[1:] != (pending, control):
        raise ValueError('prepared native transition changed during retention')
    candidate = create_candidate(root, operation, expected, run)
    start_candidate(root, operation, candidate, expected, control, run)
    return 'native'


def start(root, value, run, admit):
    _, pending, control = pending_control(root, value['token'], 'prepared')
    if (pending['image'] != value['image'] or pending['volumes'] != [value['data_volume'], value['config_volume']]):
        raise ValueError('prepared proxy request differs from the transition')
    retired = inventory(root, value['instance'], run)
    if not retired:
        current = unique_proxy(run, value['instance'], required=False, root=root)
        if current is not None and inspect_one(run, 'container', current).get('State', {}).get('Running') is not False:
            raise ValueError('Compose replacement requires the original proxy stopped')
        return 'compose'
    if pending['kind'] != 'update':
        raise ValueError('retained legacy proxies require a qualified update')
    validate_system()
    return replace(root, value, pending, control, run, admit)
