"""One-shot, operator-invoked legacy handoff. Never a v2 drain acknowledgement."""
import hashlib
import json
import os
from pathlib import Path
import re
import socket
import stat
import sys

from caddy_active_config import system_docker, validate_system
from caddy_clone_action import acquire_lock, validate_request
from caddy_recovery_receipt import MAX_RECORD, private_directory, read_private, stable, write_exclusive, VOLUME
from caddy_release_action import confirm_denials, pending_control, verified_session
from caddy_volume_guard import overlapping
from caddy_volume_migration import inspect_one, running_containers
from image_scan_intake import unique_object

SHA = re.compile(r'[0-9a-f]{64}\Z')
LEGACY_IMAGE = 'sha256:13d294b73a003c602676a8978f3ec27f2ab820fc45bf597eebc072629216c64a'
LEGACY_CONFIG = 'sha256:2ba0fe4a3d0192990d2cf6ad0d4a4dc0f8d60022bcc0ec8278edc6d0bca6a6fd'
MISSING_SNAPSHOT = 'snapshot: not taken (no hcloud context)'
BOUNDARY = 'persisted checkpoint; in-memory settlement not established'
STATE = '.legacy-handoff'
MANIFEST_FILE = 'manifest.json'
IMAGE_FIELDS = ('Cmd', 'Entrypoint', 'User', 'WorkingDir', 'Env', 'Labels', 'Healthcheck', 'Volumes', 'ExposedPorts', 'StopSignal', 'StopTimeout')
IMAGE_CONFIG_SHA = '12c309e424a81fb8d685e591f1c0222b21e0eee9e88b4cd543b75a1391cabc0a'
IMAGE_LAYERS_SHA = 'c2713c4852d40ce6fa4c563fafc280c740baaec2e9ebbcba83c5ff16a0bc8b72'


def digest(data):
    return hashlib.sha256(data).hexdigest()


def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()


def host_identity():
    return {'hostname': socket.gethostname(), 'machine_id_sha256': digest(Path('/etc/machine-id').read_bytes())}


def private_root(value):
    if not isinstance(value, str) or not os.path.isabs(value) or os.path.normpath(value) != value:
        raise ValueError('checkpoint directory must be absolute and canonical')
    path = Path(value)
    if path.resolve(strict=True) != path:
        raise ValueError('checkpoint directory must not traverse symlinks')
    return private_directory(path)


def read_json(directory, name, expected=None):
    raw = read_private(directory, name, MAX_RECORD)
    if expected is not None and digest(raw) != expected:
        raise ValueError('checkpoint JSON digest changed')
    value = json.loads(raw, object_pairs_hook=unique_object)
    if not isinstance(value, dict):
        raise ValueError('checkpoint record must be an object')
    return value, digest(raw)


def file_hash(directory, name):
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
    try:
        before = os.fstat(fd)
        if (not stat.S_ISREG(before.st_mode) or before.st_uid != os.geteuid() or before.st_nlink != 1
                or stat.S_IMODE(before.st_mode) != 0o600 or before.st_size > 1024**3):
            raise ValueError('unsafe checkpoint artifact')
        result = hashlib.sha256()
        while True:
            block = os.read(fd, 65536)
            if not block:
                break
            result.update(block)
        if stable(os.fstat(fd)) != stable(before) or stable(os.stat(name, dir_fd=directory, follow_symlinks=False)) != stable(before):
            raise ValueError('checkpoint artifact changed')
        return {'sha256': result.hexdigest(), 'bytes': before.st_size}
    finally:
        os.close(fd)


def observation(raw):
    rows = [json.loads(line, object_pairs_hook=unique_object) for line in raw.splitlines() if line.strip()]
    ledgers = [row for row in rows if isinstance(row, dict) and row.get('kind') == 'ledger']
    tables = [row for row in rows if isinstance(row, dict) and row.get('kind') == 'table']
    if len(ledgers) != 1 or len(rows) != len(tables) + 1 or not tables:
        raise ValueError('incomplete restore observation')
    hashes = ledgers[0].get('hashes')
    if not isinstance(hashes, list) or len(hashes) != 62 or any(not isinstance(item, str) or not SHA.fullmatch(item) for item in hashes):
        raise ValueError('expected all 62 migration hashes')
    keys = []
    for row in tables:
        if (set(row) != {'kind', 'schema', 'table', 'count'} or not isinstance(row['schema'], str)
                or not row['schema'] or row['schema'] == 'information_schema' or row['schema'].startswith('pg_')
                or not isinstance(row['table'], str) or not row['table'] or type(row['count']) is not int or row['count'] < 0):
            raise ValueError('invalid restore table count')
        keys.append((row['schema'], row['table']))
    if len(keys) != len(set(keys)):
        raise ValueError('duplicate restore table')
    return hashes, sorted((row['schema'], row['table'], row['count']) for row in tables)


def snapshot(value):
    if value == MISSING_SNAPSHOT:
        return
    if (not isinstance(value, dict) or set(value) != {'id', 'status'} or value['status'] != 'taken'
            or not isinstance(value['id'], str) or not re.fullmatch(r'[1-9]\d*', value['id'], flags=re.ASCII)):
        raise ValueError('snapshot ID or explicit no-credential record required')


def validate_checkpoint_header(request):
    keys = {'schema', 'kind', 'app', 'dump_sha256', 'manifest_sha256', 'vm_receipt_sha256',
            'restore_proof_sha256', 'snapshot', 'accepted_boundary'}
    if set(request) != keys or type(request['schema']) is not int or request['schema'] != 1 or request['kind'] != 'legacy-offline-checkpoint' or request['accepted_boundary'] != BOUNDARY:
        raise ValueError('invalid explicit legacy checkpoint')
    app = request['app']
    if (not isinstance(app, dict) or set(app) != {'id', 'image_id', 'started_at', 'restart_count'}
            or not isinstance(app['id'], str) or not SHA.fullmatch(app['id']) or app['image_id'] != LEGACY_IMAGE
            or not isinstance(app['started_at'], str) or not app['started_at']
            or type(app['restart_count']) is not int or app['restart_count'] < 0):
        raise ValueError('invalid checkpoint app identity')
    for key in ('dump_sha256', 'manifest_sha256', 'vm_receipt_sha256', 'restore_proof_sha256'):
        if not isinstance(request[key], str) or not SHA.fullmatch(request[key]):
            raise ValueError('invalid checkpoint hash')
    snapshot(request['snapshot'])


def validate_vm(vm, request, artifacts, directory, manifest):
    expected = {**artifacts, MANIFEST_FILE: file_hash(directory, MANIFEST_FILE)}
    if (type(vm.get('schema')) is not int or vm['schema'] != 1 or vm.get('kind') != 'vm-offhost-copy'
            or vm.get('source_manifest_sha256') != request['manifest_sha256'] or vm.get('artifacts') != expected
            or not isinstance(vm.get('machine_id_sha256'), str) or not SHA.fullmatch(vm['machine_id_sha256'])
            or vm['machine_id_sha256'] == manifest['source_host']['machine_id_sha256']
            or not isinstance(vm.get('destination'), str) or not os.path.isabs(vm['destination'])):
        raise ValueError('off-server copy receipt differs')


def validate_restore_target(proof, database, app_id):
    if not isinstance(database, dict) or not isinstance(database.get('mounts'), list):
        raise ValueError('restore source storage identity unavailable')
    identifier, volume = proof.get('container_id'), proof.get('volume')
    names = [mount.get('Name') for mount in database['mounts'] if isinstance(mount, dict)]
    if (proof.get('network') != 'none' or not isinstance(identifier, str) or not SHA.fullmatch(identifier)
            or identifier in (database.get('id'), app_id) or not isinstance(volume, str)
            or not VOLUME.fullmatch(volume) or volume in names):
        raise ValueError('restore proof must describe a separate isolated disposable target')


def validate_proof(proof, request, directory, manifest):
    validate_restore_target(proof, manifest.get('source_database'), request['app']['id'])
    source_raw = read_private(directory, 'observation.jsonl', MAX_RECORD)
    restored_raw = read_private(directory, 'restored-observation.jsonl', MAX_RECORD)
    source, restored = observation(source_raw), observation(restored_raw)
    if (type(proof.get('schema')) is not int or proof['schema'] != 1 or proof.get('kind') != 'database-restore-proof' or proof.get('status') != 'passed'
            or proof.get('row_counts_equal') is not True or proof.get('migration_hashes_equal') is not True
            or proof.get('source_dump_sha256') != request['dump_sha256']
            or proof.get('source_manifest_sha256') != request['manifest_sha256']
            or proof.get('vm_receipt_sha256') != request['vm_receipt_sha256']
            or proof.get('source_observation_sha256') != digest(source_raw)
            or proof.get('restored_observation_sha256') != digest(restored_raw) or source != restored):
        raise ValueError('restore ledger hashes or row counts differ')
    if (type(proof.get('ledger_count')) is not int or proof['ledger_count'] != len(source[0])
            or type(proof.get('table_count')) is not int or proof['table_count'] != len(source[1])):
        raise ValueError('restore summary differs from its observations')


def checkpoint(path):
    directory = private_root(path)
    try:
        request, request_sha = read_json(directory, 'checkpoint.json')
        validate_checkpoint_header(request)
        manifest, _ = read_json(directory, MANIFEST_FILE, request['manifest_sha256'])
        vm, _ = read_json(directory, 'vm-receipt.json', request['vm_receipt_sha256'])
        proof, _ = read_json(directory, 'restore-proof.json', request['restore_proof_sha256'])
        if (manifest.get('kind') != 'exported-snapshot-database-backup' or type(manifest.get('schema')) is not int or manifest['schema'] != 1
                or manifest.get('snapshot_holder_commit') != 'confirmed' or manifest.get('source_host') != host_identity()
                or proof.get('source_host') != manifest['source_host']):
            raise ValueError('checkpoint host or source snapshot differs')
        artifacts = manifest.get('artifacts')
        if not isinstance(artifacts, dict) or set(artifacts) != {'database.dump', 'globals.sql', 'observation.jsonl'}:
            raise ValueError('incomplete database backup')
        for name, expected in artifacts.items():
            if (not isinstance(expected, dict) or type(expected.get('bytes')) is not int
                    or file_hash(directory, name) != expected):
                raise ValueError('database backup artifact changed')
        if artifacts['database.dump']['sha256'] != request['dump_sha256']:
            raise ValueError('dump identity differs')
        validate_vm(vm, request, artifacts, directory, manifest)
        validate_proof(proof, request, directory, manifest)
        return request, request_sha, manifest
    finally:
        os.close(directory)


def selected(run, instance, service):
    raw = run(['docker', 'ps', '--all', '--no-trunc', '--filter', 'label=com.docker.compose.project=' + instance,
               '--filter', 'label=com.docker.compose.service=' + service, '--format', '{{.ID}}'], 15, MAX_RECORD)
    ids = raw.decode('ascii').splitlines()
    if len(ids) != 1 or not SHA.fullmatch(ids[0]):
        raise ValueError('legacy service identity is missing or ambiguous')
    return ids[0]


def validate_app_config(app, instance):
    config, host = app.get('Config'), app.get('HostConfig')
    if not isinstance(config, dict) or not isinstance(host, dict):
        raise ValueError('legacy app configuration unavailable')
    labels = config.get('Labels') or {}
    if (app.get('Name') != '/' + instance or app.get('Image') != LEGACY_IMAGE
            or labels.get('com.docker.compose.project') != instance or labels.get('com.docker.compose.service') != 'dollhousemcp'
            or labels.get('org.dollhousemcp.memory-upgrade-drain') == 'v2'
            or config.get('StopSignal') not in (None, '', 'SIGTERM', 'TERM', '15')
            or host.get('Privileged') is not False or host.get('NetworkMode') != instance + '_default'
            or any((host.get('PortBindings') or {}).values())
            or host.get('PidMode') not in (None, '', 'private') or host.get('UTSMode') not in (None, '', 'private')):
        raise ValueError('unsupported legacy app configuration')
    return config, host


def validate_app_state(app, running):
    state = app.get('State')
    if (not isinstance(state, dict) or state.get('Running') is not running or state.get('Restarting') is not False
            or state.get('OOMKilled') is not False or type(app.get('RestartCount')) is not int or app['RestartCount'] < 0
            or not isinstance(state.get('StartedAt'), str) or not state['StartedAt'] or state['StartedAt'].startswith('0001-')):
        raise ValueError('unsupported or changed legacy app lifecycle')
    if running and state.get('Health', {}).get('Status') != 'healthy':
        raise ValueError('legacy app is not healthy before the handoff')
    if not running and (type(state.get('ExitCode')) is not int or state['ExitCode'] != 0 or not state.get('FinishedAt') or state['FinishedAt'].startswith('0001-')):
        raise ValueError('legacy app did not exit cleanly')
    return state


def refuse_other_writer(portfolio, other):
    mounts = other.get('Mounts')
    if not isinstance(mounts, list):
        raise ValueError('other writer inventory is unavailable')
    for item in mounts:
        if not isinstance(item, dict) or type(item.get('RW')) is not bool:
            raise ValueError('other writer mount is unavailable')
        if item.get('Type') != 'tmpfs' and item['RW']:
            source = item.get('Source')
            if not isinstance(source, str) or not os.path.isabs(source) or overlapping(portfolio, source):
                raise ValueError('another or unknown writer can access legacy storage')


def require_private_storage(run, app, root):
    mounts = app.get('Mounts')
    if not isinstance(mounts, list) or len(mounts) != 1:
        raise ValueError('legacy app requires its one retained portfolio bind')
    mount = mounts[0]
    if (not isinstance(mount, dict) or mount.get('Type') != 'bind' or mount.get('RW') is not True
            or mount.get('Source') != str(root / 'portfolio') or mount.get('Destination') != '/home/dollhouse/.dollhouse'):
        raise ValueError('legacy portfolio binding differs')
    info = (root / 'portfolio').lstat()
    if not stat.S_ISDIR(info.st_mode) or (root / 'portfolio').resolve(strict=True) != root / 'portfolio':
        raise ValueError('legacy portfolio is not canonical')
    for other in running_containers(run):
        if other.get('Id') != app['Id']:
            refuse_other_writer(mount['Source'], other)
    return {'device': info.st_dev, 'inode': info.st_ino, 'uid': info.st_uid, 'gid': info.st_gid, 'mode': stat.S_IMODE(info.st_mode)}


def app_profile(run, instance, identifier, running, root):
    if selected(run, instance, 'dollhousemcp') != identifier:
        raise ValueError('legacy app selection changed')
    app = inspect_one(run, 'container', identifier)
    if app.get('Id') != identifier:
        raise ValueError('immutable app ID changed')
    config, host = validate_app_config(app, instance)
    state = validate_app_state(app, running)
    image = inspect_one(run, 'image', LEGACY_IMAGE)
    image_config = image.get('Config')
    if (image.get('Id') != LEGACY_IMAGE or (image.get('Os'), image.get('Architecture')) != ('linux', 'amd64')
            or not isinstance(image_config, dict) or digest(encoded({k: image_config.get(k) for k in IMAGE_FIELDS})) != IMAGE_CONFIG_SHA
            or digest(encoded((image.get('RootFS') or {}).get('Layers'))) != IMAGE_LAYERS_SHA
            or config.get('Cmd') != image_config.get('Cmd') or config.get('Entrypoint') != image_config.get('Entrypoint')):
        raise ValueError('qualified legacy image or command differs')
    storage = require_private_storage(run, app, root)
    return {'id': identifier, 'image_id': LEGACY_IMAGE, 'qualified_config_sha256': LEGACY_CONFIG,
            'started_at': state['StartedAt'], 'restart_count': app['RestartCount'], 'storage': storage,
            'profile_sha256': digest(encoded({'config': config, 'host': host, 'mounts': app['Mounts']}))}


def verify_database(value, manifest, run):
    pg = inspect_one(run, 'container', value['postgres_id'])
    expected = manifest.get('source_database')
    if (not isinstance(expected, dict) or type(expected.get('restart_count')) is not int
            or expected.get('health') != 'healthy'):
        raise ValueError('checkpoint database identity unavailable')
    state = pg.get('State') or {}
    if (selected(run, value['instance'], 'postgres') != value['postgres_id'] or pg.get('Id') != expected.get('id')
            or pg.get('Image') != expected.get('image_id') or state.get('Running') is not True
            or state.get('Health', {}).get('Status') != 'healthy'
            or state.get('Restarting') is not False or state.get('OOMKilled') is not False
            or state.get('StartedAt') != expected.get('started_at') or pg.get('RestartCount') != expected.get('restart_count')
            or sorted(pg.get('Mounts', []), key=encoded) != sorted(expected.get('mounts', []), key=encoded)):
        raise ValueError('checkpoint PostgreSQL identity changed')


def verify_inputs(value, run):
    request, receipt_sha, manifest = checkpoint(value['checkpoint_dir'])
    app = app_profile(run, value['instance'], value['app_id'], True, Path(value['deploy_dir']))
    if request['app'] != {key: app[key] for key in ('id', 'image_id', 'started_at', 'restart_count')}:
        raise ValueError('checkpoint app boot identity differs')
    verify_database(value, manifest, run)
    return request, receipt_sha, app


def fence(root, value):
    _, pending, control = pending_control(root, value['token'], 'probed')
    if pending['kind'] != 'update' or pending['control']['proxy'] is None:
        raise ValueError('legacy handoff requires a fenced update')
    session, _, _, _ = verified_session(root, value['instance'], pending, control)
    session.close()
    confirm_denials(control['public_origin'], value['token'])
    session, _, _, _ = verified_session(root, value['instance'], pending, control)
    session.close()
    return {'token': pending['token'], 'proxy': control['proxy'], 'source': pending['source']}


def handoff(root, value, run=system_docker, verify_fence=fence):
    if (root / STATE).exists() or (root / STATE).is_symlink():
        raise ValueError('legacy handoff was already issued; no retry or inferred stopped success')
    request, receipt_sha, before = verify_inputs(value, run)
    bound = verify_fence(root, value)
    if verify_inputs(value, run) != (request, receipt_sha, before):
        raise ValueError('legacy checkpoint changed before stop')
    (root / STATE).mkdir(mode=0o700)
    directory = private_directory(root / STATE)
    try:
        issued = {'schema': 1, 'kind': 'legacy-offline-stop-issued', 'checkpoint_sha256': receipt_sha,
                  'host': host_identity(), 'app': before, 'fence': bound, 'snapshot': request['snapshot'],
                  'dump_sha256': request['dump_sha256'], 'restore_proof_sha256': request['restore_proof_sha256'],
                  'accepted_boundary': BOUNDARY}
        write_exclusive(directory, 'issued.json', encoded(issued))
        os.fsync(directory)
        parent = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(parent)
        finally:
            os.close(parent)
        # Infinite daemon grace prevents Docker's default SIGKILL escalation.
        # A bounded client failure is UNKNOWN; neither retry nor restart is allowed.
        run(['docker', 'stop', '--signal', 'SIGTERM', '--timeout', '-1', before['id']], 60, 65536)
        after = app_profile(run, value['instance'], before['id'], False, root)
        if before != after or verify_fence(root, value) != bound or checkpoint(value['checkpoint_dir'])[:2] != (request, receipt_sha):
            raise ValueError('legacy handoff changed after stop; recovery required')
        receipt = {**issued, 'kind': 'legacy-offline-handoff', 'exit_code': 0}
        write_exclusive(directory, 'receipt.json', encoded(receipt))
        os.fsync(directory)
        return receipt
    finally:
        os.close(directory)


def verify_completed(root, value, run=system_docker, verify_fence=fence):
    directory = private_directory(root / STATE)
    try:
        issued, _ = read_json(directory, 'issued.json')
        receipt, _ = read_json(directory, 'receipt.json')
    finally:
        os.close(directory)
    if receipt != {**issued, 'kind': 'legacy-offline-handoff', 'exit_code': 0}:
        raise ValueError('legacy handoff completion differs')
    request, receipt_sha, manifest = checkpoint(value['checkpoint_dir'])
    if (issued.get('schema') != 1 or issued.get('kind') != 'legacy-offline-stop-issued'
            or issued.get('host') != host_identity() or issued.get('checkpoint_sha256') != receipt_sha
            or issued.get('dump_sha256') != request['dump_sha256'] or issued.get('restore_proof_sha256') != request['restore_proof_sha256']
            or issued.get('app', {}).get('id') != value['app_id']
            or app_profile(run, value['instance'], value['app_id'], False, root) != issued['app']
            or verify_fence(root, value) != issued.get('fence')):
        raise ValueError('stopped legacy identity, checkpoint or fence changed')
    verify_database(value, manifest, run)


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in ('preflight', 'stop', 'verify'):
        raise ValueError('explicit legacy preflight or stop action required')
    raw = sys.stdin.buffer.read(MAX_RECORD + 1)
    if len(raw) > MAX_RECORD:
        raise ValueError('legacy handoff request exceeds its bound')
    value = json.loads(raw, object_pairs_hook=unique_object)
    keys = {'deploy_dir', 'instance', 'data_volume', 'config_volume', 'token', 'checkpoint_dir', 'app_id', 'postgres_id'}
    if not isinstance(value, dict) or set(value) != keys or any(not isinstance(value[k], str) for k in keys):
        raise ValueError('invalid legacy handoff request')
    if not SHA.fullmatch(value['app_id']) or not SHA.fullmatch(value['postgres_id']):
        raise ValueError('invalid immutable legacy service ID')
    root = validate_request({k: value[k] for k in ('deploy_dir', 'instance', 'data_volume', 'config_volume')})
    validate_system()
    if os.uname().machine != 'x86_64':
        raise ValueError('legacy handoff requires the qualified native AMD64 host')
    lock = acquire_lock(root, allow_control=sys.argv[1] != 'preflight')
    try:
        if sys.argv[1] != 'verify' and ((root / STATE).exists() or (root / STATE).is_symlink()):
            raise ValueError('legacy handoff already issued; reconcile before further action')
        if sys.argv[1] == 'verify':
            verify_completed(root, value)
        elif sys.argv[1] == 'preflight':
            verify_inputs(value, system_docker)
        else:
            print(json.dumps(handoff(root, value), sort_keys=True))
    finally:
        os.close(lock)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('Legacy handoff refused; keep ingress fenced and inspect recovery evidence: ' + str(error), file=sys.stderr)
        sys.exit(1)
