"""Reconcile protected controls while the recovered legacy stack keeps serving."""
import json
import os
from pathlib import Path
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from caddy_active_config import DOCKER, bounded_input, system_docker, validate_system
from caddy_clone_action import acquire_lock, validate_request
from caddy_image_admission import qualify
from caddy_recover_action import recovery_kind, verify_recovered
from caddy_recovery_receipt import MAX_RECORD, private_directory, read_caddy_snapshot, read_private
from caddy_retired_proxy import DIRECTORY, inventory, register
from caddy_service_guard import proxy_startup_path, unique_proxy
from caddy_unchanged_action import no_other_writers
from caddy_volume_migration import inspect_one, inspect_volumes
from image_scan_intake import unique_object
import legacy_control_compose as compose
import legacy_control_resolution as resolution
import legacy_handoff as handoff
from legacy_manual_recovery_import import import_accepted
import legacy_reconcile_files as files
import legacy_recovery_action as recovery
import legacy_recovery_boundary as boundary
import legacy_recovery_checks as checks
from legacy_recovery_guards import exact_container, ingress_available, lifecycle, serving_dns
from legacy_recovery_journal import Journal
from legacy_recovery_profile import profile, profile_hash

HANDOFF_FILES = ('issued.json', 'stop-acknowledged.json', 'receipt.json')


def automatic(root, value, run):
    armed, armed_sha = boundary.read_window(root, value['token'])
    if armed['request'] != value:
        raise ValueError('reconciliation does not bind the armed window')
    journal = Journal(root, value['token'], armed_sha)
    try:
        baseline, recovered = journal.read('baseline'), journal.read('RECOVERED')
        _, receipt_sha = handoff.read_json(journal.directory, 'RECOVERED.json')
        state, pending, _ = checks.forward_state(root, value, armed, baseline['forward_state'])
        if recovered['app_id'] != value['app_id'] or recovered['retained_id'] != baseline['current_id']:
            raise ValueError('completed recovery identities differ from the armed window')
        checks.database(value, armed, run)
        app = exact_container(run, value['app_id'], armed['profiles']['app'], value['instance'], True, recovered['app_boot'])
        postgres = inspect_one(run, 'container', value['postgres_id'])
        proxy = inspect_one(run, 'container', recovered['proxy_id'])
        lifecycle(proxy, True, recovered['proxy_boot'])
        retained = exact_container(run, recovered['retained_id'], baseline['proxy_profile'],
                                   recovered['retained_name'], False, baseline['proxy_boot'])
        operation = journal.operation
    finally:
        journal.close()
    directory = private_directory(boundary.window_path(root, value['token']))
    try:
        selected = {name: (read_private(directory, name, MAX_RECORD), expected['mode'])
                    for name, expected in armed['files'].items() if expected is not None}
    finally:
        os.close(directory)
    return {'state': state, 'pending': pending, 'files': selected, 'database': armed['database'], 'app': app,
            'postgres': postgres, 'proxy': proxy, 'retained': retained, 'proxy_token': operation,
            'source': armed['source'], 'checkpoint_sha256': armed['checkpoint_sha256'], 'recovery_sha256': receipt_sha,
            'handoff_observation': baseline['app'], 'unchanged_unarchived_files': []}


def marker_inventory(root, value, data):
    path = handoff.state_path(root, value)
    raw = {}
    try:
        directory = private_directory(path)
    except FileNotFoundError:
        directory = None
    if directory is not None:
        try:
            for name in HANDOFF_FILES:
                try:
                    raw[name] = read_private(directory, name, MAX_RECORD)
                except FileNotFoundError:
                    continue
        finally:
            os.close(directory)
    hashes = {name: handoff.digest(raw[name]) if name in raw else None for name in HANDOFF_FILES}
    expected = expected_markers(root, path, data)
    if hashes != expected:
        raise ValueError('legacy handoff evidence changed or was promoted after recovery')
    return str(path.relative_to(root)), hashes


def expected_markers(root, path, data):
    if 'marker_hashes' in data:
        if path != root / handoff.STATE:
            raise ValueError('accepted manual handoff namespace changed')
        expected = data['marker_hashes']
        return {name: expected.get('.legacy-handoff/' + name) for name in HANDOFF_FILES}
    observed = data['handoff_observation']
    mode = observed['mode']
    if mode == 'never-stopped':
        return dict.fromkeys(HANDOFF_FILES)
    if mode not in ('stop-acknowledged', 'stopped'):
        raise ValueError('unrecognized recovery handoff observation')
    return {
        'issued.json': observed['issued_sha256'],
        'stop-acknowledged.json': observed['stop_ack_sha256'],
        'receipt.json': observed['handoff_sha256'] if mode == 'stopped' else None,
    }


def census(root, instance, data, run):
    identifiers = run(['docker', 'ps', '--all', '--no-trunc', '--filter', 'label=com.docker.compose.project=' + instance,
                       '--filter', 'label=com.docker.compose.service=caddy', '--format', '{{.ID}}'], 15, MAX_RECORD)
    actual = identifiers.decode('ascii').splitlines()
    expected = inventory(root, instance, run) | {data['proxy']['Id'], data['retained']['Id']}
    if len(actual) != len(set(actual)) or set(actual) != expected:
        raise ValueError('Caddy label census includes an unknown or missing identity')


def prove_serving(root, value, data, record, receipt, run, admit, public):
    instance = value['instance']
    request, checkpoint_sha, manifest = handoff.checkpoint(value['checkpoint_dir'])
    if checkpoint_sha != data['checkpoint_sha256'] or request['app']['id'] != value['app_id']:
        raise ValueError('reconciliation checkpoint changed')
    handoff.verify_database(value, manifest, run)
    if boundary.database_fingerprint(run, value['postgres_id']) != data['database']:
        raise ValueError('reconciliation database schema, globals or ledger changed')
    for key, name in (('app', instance), ('postgres', instance + '-postgres'), ('proxy', instance + '-caddy')):
        item = data[key]
        exact_container(run, item['Id'], profile(item), name, True, lifecycle(item, True))
    retired = data['retained']
    exact_container(run, retired['Id'], profile(retired), retired['Name'][1:], False, lifecycle(retired, False))
    handoff.app_profile(run, instance, value['app_id'], True, root)
    recovery.app_acceptance(value, run)
    serving_dns(run, instance, value['app_id'])
    verify_recovered(run, data['proxy']['Id'], {'record': record}, instance, data['proxy_token'], True,
                     receipt / 'Caddyfile', admit)
    expected = record['clone']['volumes']
    if inspect_volumes(run, [item['name'] for item in expected]) != expected:
        raise ValueError('original or partial Caddy volume identity changed')
    no_other_writers(run, data['proxy']['Id'], expected[:2])
    ingress_available(run, record['profile']['ports'], excluded=(data['proxy']['Id'],))
    checks.serving_config(data['proxy']['Id'], receipt, record, lifecycle(data['proxy'], True))
    census(root, instance, data, run)
    return public(data['pending']['control']['public_origin'])


def check_compose(path, root, instance, data):
    argv = [DOCKER, 'compose', '--project-name', instance, '--project-directory', str(root), '--env-file', '/dev/null',
            '-f', str(path), 'config', '--format', 'json']
    try:
        raw = bounded_input(argv, timeout=25, env={'PATH': '/usr/bin:/bin', 'LC_ALL': 'C', 'DOCKER_HOST': 'unix:///dev/null'})
        result = json.loads(raw, object_pairs_hook=unique_object)
    except (ValueError, OSError):
        # Compose config can contain credentials. Never emit its stdout or stderr.
        raise ValueError('private legacy Compose model could not be resolved') from None
    services = result.get('services', {})
    if set(services) != {'dollhousemcp', 'postgres', 'caddy'}:
        raise ValueError('private legacy Compose service inventory differs')
    for name, key in (('dollhousemcp', 'app'), ('postgres', 'postgres'), ('caddy', 'proxy')):
        observed, expected = services[name], data[key]
        if (observed.get('image') != expected['Image'] or observed.get('container_name') != expected['Name'][1:]
                # Compose's canonical output re-escapes literal dollar signs.
                or observed.get('environment') != compose.literal(compose.environment(expected['Config']['Env']))
                or 'build' in observed or 'env_file' in observed):
            raise ValueError('resolved legacy Compose image, environment or service identity differs')


def retire(root, instance, operation, data, receipt, run):
    current, old = data['proxy'], data['retained']
    serving = {'id': current['Id'], 'profile': profile(current), 'boot': lifecycle(current, True),
               'caddyfile': str(receipt / 'Caddyfile'),
               'caddyfile_sha256': handoff.digest(data['files']['Caddyfile'][0])}
    record = {'schema': 'qualified-proxy-retirement-v1', 'host': handoff.host_identity(), 'instance': instance,
              'serving': serving, 'retired': {'id': old['Id'], 'name': old['Name'][1:], 'profile': profile(old),
                                              'boot': lifecycle(old, False)}}
    files.record(operation, 'retirement-authority', record)
    authority_path = operation / 'retirement-authority.json'
    register(root, instance, old['Id'], old['Name'][1:], authority_path, run)
    authority = {'path': str(authority_path), 'sha256': handoff.digest(handoff.encoded(record))}
    files.record(root / DIRECTORY, 'serving-' + current['Id'], {'authority': authority, 'serving': serving})
    if unique_proxy(run, instance, root=root) != current['Id'] or proxy_startup_path(root, instance, current['Id'], run) != receipt / 'Caddyfile':
        raise ValueError('qualified proxy selection read-back differs')
    return authority['sha256']


def reconcile(root, value, manual, run=system_docker, admit=qualify, public=recovery.public_acceptance,
              verify_compose=check_compose):
    if resolution.IMPLEMENTATION.is_relative_to(root / 'server'):
        raise ValueError('reconciliation requires a pinned helper outside the replaced source cache')
    data = import_accepted(root, value, manual, run) if manual is not None else automatic(root, value, run)
    pending, instance = data['pending'], value['instance']
    kind, original, receipt = recovery_kind(root, Path(pending['previous']))
    if (kind != 'legacy' or str(receipt) != pending['receipt']
            or data.get('original_proxy_id', original['profile']['container_id']) != original['profile']['container_id']
            or read_caddy_snapshot(receipt, original['caddyfile_sha256']) != data['files']['Caddyfile'][0]):
        raise ValueError('reconciliation original source/Caddy receipt differs')
    failed = resolution.raw_state(root)
    if json.loads(failed, object_pairs_hook=unique_object) != data['state']:
        raise ValueError('failed control bytes changed before reconciliation')
    handoff_directory, handoff_hashes = marker_inventory(root, value, data)
    prove_serving(root, value, data, original, receipt, run, admit, public)
    operation = resolution.operation_path(root, value['token'])
    operation.parent.mkdir(mode=0o700, exist_ok=True)
    owner = private_directory(operation.parent)
    try:
        os.mkdir(operation.name, 0o700, dir_fd=owner)
        os.fsync(owner)
    finally:
        os.close(owner)
    files.sync_path(root, directory=True)
    before_files = files.live_inventory(root)
    model = compose.model(instance, data['app'], data['postgres'], data['proxy'])
    staged, after_files = files.stage_files(operation, data['files'], handoff.encoded(model) + b'\n')
    candidate = files.prepare_source(root, operation, Path(pending['previous']), data['source'])
    verify_compose(staged / 'compose.yml', root, instance, data)
    prove_serving(root, value, data, original, receipt, run, admit, public)
    if resolution.raw_state(root) != failed or marker_inventory(root, value, data) != (handoff_directory, handoff_hashes):
        raise ValueError('failed controls changed before source/configuration installation')
    files.save(operation, 'failed-state.json', failed)
    files.record(operation, 'reconciliation-issued', {'failed_state_sha256': handoff.digest(failed),
                 'before_source': pending['staged_source'], 'after_source': data['source'],
                 'before_files': before_files, 'after_files': after_files, 'handoff': handoff_hashes})
    files.install(root, operation, candidate, staged, pending['staged_source'], data['source'], before_files, after_files)
    verify_compose(root / 'compose.yml', root, instance, data)
    public_result = prove_serving(root, value, data, original, receipt, run, admit, public)
    authority_sha = retire(root, instance, operation, data, receipt, run)
    result = {'schema': 'legacy-controls-reconciled-v1', 'token': value['token'], 'instance': instance,
              'host': handoff.host_identity(), 'implementation': resolution.bundle_identity(resolution.IMPLEMENTATION),
              'failed_state': data['state'], 'failed_state_sha256': handoff.digest(failed), 'source': data['source'],
              'handoff_directory': handoff_directory, 'handoff': handoff_hashes, 'files': after_files,
              'retirement_authority_sha256': authority_sha, 'checkpoint_sha256': data['checkpoint_sha256'],
              'recovery_sha256': data.get('manual_receipt_sha256', data.get('recovery_sha256')),
              'app_profile_sha256': profile_hash(data['app']), 'postgres_profile_sha256': profile_hash(data['postgres']),
              'database': data['database'], 'public': public_result,
              'unchanged_unarchived_files': data['unchanged_unarchived_files']}
    if resolution.raw_state(root) != failed or marker_inventory(root, value, data) != (handoff_directory, handoff_hashes):
        raise ValueError('failed controls changed before reconciliation completion')
    files.record(operation, 'RECONCILED', result)
    return {'outcome': 'RECONCILED', 'receipt': str(operation / 'RECONCILED.json')}


def main():
    if sys.argv[1:] != ['reconcile-legacy']:
        raise ValueError('explicit reconcile-legacy action required')
    raw = sys.stdin.buffer.read(MAX_RECORD + 1)
    if len(raw) > MAX_RECORD:
        raise ValueError('reconciliation request exceeds its bound')
    value = json.loads(raw, object_pairs_hook=unique_object)
    if not isinstance(value, dict) or set(value) != boundary.KEYS | {'manual_evidence_dir'}:
        raise ValueError('invalid reconciliation request')
    manual = value.pop('manual_evidence_dir')
    if (any(not isinstance(item, str) for item in value.values()) or not boundary.TOKEN.fullmatch(value['token'])
            or any(not handoff.SHA.fullmatch(value[k]) for k in ('app_id', 'postgres_id'))
            or (manual is not None and not isinstance(manual, str))):
        raise ValueError('invalid reconciliation identity')
    root = validate_request({k: value[k] for k in ('deploy_dir', 'instance', 'data_volume', 'config_volume')})
    validate_system()
    if os.uname().machine != 'x86_64':
        raise ValueError('reconciliation requires the qualified native AMD64 legacy host')
    lock = acquire_lock(root, allow_control=True)
    try:
        print(json.dumps(reconcile(root, value, manual)))
    finally:
        os.close(lock)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('Legacy control reconciliation refused; retain every original and receipt: ' + str(error), file=sys.stderr)
        sys.exit(1)
