"""Check and arm a protected legacy rollback baseline, and fence the first forward DB write.

This action never starts/stops a service or restores data. A write intent is
durable before migrations, grants or bootstrap can begin, even if they fail.
"""
import json
import os
from pathlib import Path
import re
import stat
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from caddy_active_config import system_docker, validate_system
from caddy_bundle_identity import bundle_identity
from caddy_clone_action import acquire_lock, validate_request
from caddy_recovery_receipt import MAX_RECORD, private_directory, read_private, stable, write_exclusive
from caddy_transition_state import read_state
from caddy_volume_migration import inspect_one
from image_scan_intake import unique_object
import legacy_handoff as handoff
from legacy_recovery_profile import profile

DIRECTORY = '.legacy-recovery'
FILES = ('compose.yml', '.env', '.env.production', 'Caddyfile', 'init-db.sh',
         'post-migration-grants.sql', 'apply-post-migration-grants.sh', 'bootstrap-admin.sh',
         'DEPLOYED_REVISION', 'DEPLOYED_AT')
REQUIRED = set(FILES[:4])
TOKEN = re.compile(r'[0-9a-f]{32}\Z')
KEYS = {'deploy_dir', 'instance', 'data_volume', 'config_volume', 'token',
        'checkpoint_dir', 'app_id', 'postgres_id'}
IMPLEMENTATION = Path(__file__).resolve().parent


def window_path(root, token):
    if not isinstance(token, str) or not TOKEN.fullmatch(token):
        raise ValueError('invalid legacy recovery token')
    return root / DIRECTORY / ('window-' + token)


def normalized_dump(raw):
    return b'\n'.join(line for line in raw.splitlines() if line and not line.startswith(
        (b'--', b'\\restrict ', b'\\unrestrict '))) + b'\n'


def database_fingerprint(run, identifier):
    commands = {
        'schema_sha256': 'exec pg_dump --no-password --schema-only --create --username "$POSTGRES_USER" --dbname dollhousemcp',
        'globals_sha256': 'exec pg_dumpall --no-password --globals-only --username "$POSTGRES_USER"',
    }
    result = {}
    for name, command in commands.items():
        raw = run(['docker', 'exec', identifier, 'sh', '-c', command], 45, MAX_RECORD)
        result[name] = handoff.digest(normalized_dump(raw))
    query = 'BEGIN READ ONLY; SELECT json_agg(hash ORDER BY id) FROM drizzle.__drizzle_migrations; COMMIT;'
    command = ('exec psql --no-password --no-psqlrc --set ON_ERROR_STOP=1 --quiet --tuples-only --no-align '
               '--username "$POSTGRES_USER" --dbname dollhousemcp --command ' + "'" + query + "'")
    raw = run(['docker', 'exec', identifier, 'sh', '-c', command], 30, MAX_RECORD)
    hashes = json.loads(raw, object_pairs_hook=unique_object)
    if not isinstance(hashes, list) or len(hashes) != 62 or any(
            not isinstance(item, str) or not handoff.SHA.fullmatch(item) for item in hashes):
        raise ValueError('legacy recovery requires the exact 62-entry migration ledger')
    result['ledger'] = hashes
    return result


def checkpoint_database(value, fingerprint):
    directory = handoff.private_root(value['checkpoint_dir'])
    try:
        globals_raw = read_private(directory, 'globals.sql', MAX_RECORD)
        source = handoff.observation(read_private(directory, 'observation.jsonl', MAX_RECORD))
    finally:
        os.close(directory)
    if (fingerprint['globals_sha256'] != handoff.digest(normalized_dump(globals_raw))
            or fingerprint['ledger'] != source[0]):
        raise ValueError('live database globals or ledger differ from the qualified checkpoint')


def validate_configuration_stat(info, name):
    if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid()
            or info.st_nlink != 1 or info.st_mode & 0o7022 or info.st_size > MAX_RECORD):
        raise ValueError('unsafe legacy configuration snapshot')
    if name in ('.env', '.env.production') and stat.S_IMODE(info.st_mode) != 0o600:
        raise ValueError('legacy environment must already be private')


def read_configuration(root, name):
    directory = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        try:
            before = os.fstat(fd)
            validate_configuration_stat(before, name)
            raw = os.read(fd, MAX_RECORD + 1)
            linked = os.stat(name, dir_fd=directory, follow_symlinks=False)
            if len(raw) != before.st_size or stable(os.fstat(fd)) != stable(before) or stable(linked) != stable(before):
                raise ValueError('legacy configuration changed during capture')
            return raw, stat.S_IMODE(before.st_mode)
        finally:
            os.close(fd)
    finally:
        os.close(directory)


def capture_files(root, directory):
    result = {}
    for name in FILES:
        try:
            raw, mode = read_configuration(root, name)
        except FileNotFoundError:
            if name in REQUIRED:
                raise ValueError('required legacy configuration is absent') from None
            result[name] = None
            continue
        write_exclusive(directory, name, raw)
        result[name] = {'sha256': handoff.digest(raw), 'mode': mode, 'bytes': len(raw)}
    os.fsync(directory)
    return result


def verify_live_files(root, files):
    for name, expected in files.items():
        try:
            raw, mode = read_configuration(root, name)
        except FileNotFoundError:
            if expected is None:
                continue
            raise ValueError('legacy configuration disappeared during capture') from None
        if expected != {'sha256': handoff.digest(raw), 'mode': mode, 'bytes': len(raw)}:
            raise ValueError('legacy configuration changed before arming completed')


def prepared_transition(root, value):
    pending = read_state(root)['pending']
    if (not isinstance(pending, dict) or pending['kind'] != 'update' or pending['token'] != value['token']
            or pending['phase'] not in ('prepared', 'admitted') or pending.get('control') is not None
            or pending['source'] != bundle_identity(root / 'server')):
        raise ValueError('recovery must be armed before rendering or staging the legacy update')
    return pending


def create_window(root, token):
    parent = root / DIRECTORY
    parent.mkdir(mode=0o700, exist_ok=True)
    owner = private_directory(parent)
    try:
        os.mkdir('window-' + token, 0o700, dir_fd=owner)
        os.fsync(owner)
    finally:
        os.close(owner)
    return private_directory(window_path(root, token))


def check(root, value, run=system_docker):
    """Everything arming verifies that needs no pending transition, with nothing written.

    It runs before the update transition begins, so that a refusal leaves nothing
    pending. Arming repeats every check against the transition it then binds.
    """
    handoff.verify_inputs(value, run)
    checkpoint_database(value, database_fingerprint(run, value['postgres_id']))
    for identifier in (value['app_id'], value['postgres_id']):
        profile(inspect_one(run, 'container', identifier))
    for name in FILES:
        try:
            read_configuration(root, name)
        except FileNotFoundError:
            if name in REQUIRED:
                raise ValueError('required legacy configuration is absent') from None


def arm(root, value, run=system_docker):
    pending = prepared_transition(root, value)
    request, checkpoint_sha, app = handoff.verify_inputs(value, run)
    fingerprint = database_fingerprint(run, value['postgres_id'])
    checkpoint_database(value, fingerprint)
    snapshots = {name: profile(inspect_one(run, 'container', identifier))
                 for name, identifier in (('app', value['app_id']), ('postgres', value['postgres_id']))}
    directory = create_window(root, value['token'])
    try:
        files = capture_files(root, directory)
        verify_live_files(root, files)
        if prepared_transition(root, value) != pending or handoff.verify_inputs(value, run) != (request, checkpoint_sha, app):
            raise ValueError('legacy baseline changed before arming completed')
        if database_fingerprint(run, value['postgres_id']) != fingerprint:
            raise ValueError('database changed while recovery baseline was captured')
        record = {'schema': 'legacy-recovery-window-v1', 'host': handoff.host_identity(), 'request': value,
                  'checkpoint_sha256': checkpoint_sha, 'app': app, 'profiles': snapshots,
                  'source': pending['source'], 'previous': pending['previous'], 'receipt': pending['receipt'],
                  'receipt_sha256': pending['receipt_sha256'], 'database': fingerprint, 'files': files,
                  'implementation': bundle_identity(IMPLEMENTATION)}
        write_exclusive(directory, 'armed.json', handoff.encoded(record))
        os.fsync(directory)
        return record
    finally:
        os.close(directory)


def verify_snapshot(directory, name, expected):
    if expected is None:
        if name in REQUIRED:
            raise ValueError('required legacy configuration snapshot missing')
        return
    if (not isinstance(expected, dict) or set(expected) != {'sha256', 'mode', 'bytes'}
            or type(expected['mode']) is not int or expected['mode'] & ~0o755
            or type(expected['bytes']) is not int):
        raise ValueError('invalid legacy configuration snapshot metadata')
    raw = read_private(directory, name, MAX_RECORD)
    if handoff.digest(raw) != expected['sha256'] or len(raw) != expected['bytes']:
        raise ValueError('legacy configuration snapshot changed')


def read_window(root, token):
    directory = private_directory(window_path(root, token))
    try:
        record, digest = handoff.read_json(directory, 'armed.json')
        if (record.get('schema') != 'legacy-recovery-window-v1' or record.get('host') != handoff.host_identity()
                or record.get('request', {}).get('token') != token
                or record['request'].get('deploy_dir') != str(root) or set(record.get('files', {})) != set(FILES)
                or record.get('implementation') != bundle_identity(IMPLEMENTATION)):
            raise ValueError('legacy recovery window binding differs')
        for name, expected in record['files'].items():
            verify_snapshot(directory, name, expected)
        return record, digest
    finally:
        os.close(directory)


def refuse_forward_write(root, token):
    directory = private_directory(window_path(root, token))
    try:
        try:
            os.stat('forward-write-issued.json', dir_fd=directory, follow_symlinks=False)
        except FileNotFoundError:
            return
        raise ValueError('a forward DB write was issued or is UNKNOWN; qualified checkpoint restoration is required')
    finally:
        os.close(directory)


def issue_forward_write(root, value, run=system_docker):
    armed, armed_sha = read_window(root, value['token'])
    if armed['request'] != value:
        raise ValueError('forward write request differs from armed recovery baseline')
    refuse_forward_write(root, value['token'])
    handoff.verify_completed(root, value, run)
    if database_fingerprint(run, value['postgres_id']) != armed['database']:
        raise ValueError('database changed before the first forward write')
    directory = private_directory(window_path(root, value['token']))
    try:
        write_exclusive(directory, 'forward-write-issued.json', handoff.encoded(
            {'kind': 'legacy-forward-write-issued', 'armed_sha256': armed_sha,
             'host': armed['host'], 'token': value['token'], 'checkpoint_sha256': armed['checkpoint_sha256']}))
        os.fsync(directory)
    finally:
        os.close(directory)


def valid_token(action, token):
    """The check runs before a transition exists, so it has no token. Every other action names its transition."""
    return token == '' if action == 'check' else TOKEN.fullmatch(token) is not None


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in ('check', 'arm', 'write-intent'):
        raise ValueError('explicit legacy recovery check, arm or write-intent action required')
    raw = sys.stdin.buffer.read(MAX_RECORD + 1)
    if len(raw) > MAX_RECORD:
        raise ValueError('legacy recovery request exceeds its bound')
    value = json.loads(raw, object_pairs_hook=unique_object)
    if (not isinstance(value, dict) or set(value) != KEYS or any(not isinstance(v, str) for v in value.values())
            or not valid_token(sys.argv[1], value['token'])
            or any(not handoff.SHA.fullmatch(value[k]) for k in ('app_id', 'postgres_id'))):
        raise ValueError('invalid legacy recovery request')
    root = validate_request({k: value[k] for k in ('deploy_dir', 'instance', 'data_volume', 'config_volume')})
    validate_system()
    if os.uname().machine != 'x86_64':
        raise ValueError('legacy recovery requires the qualified native AMD64 legacy image')
    lock = acquire_lock(root, allow_control=True)
    try:
        if sys.argv[1] == 'check':
            check(root, value)
        elif sys.argv[1] == 'arm':
            arm(root, value)
        else:
            issue_forward_write(root, value)
    finally:
        os.close(lock)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('Legacy recovery boundary refused: ' + str(error), file=sys.stderr)
        sys.exit(1)
