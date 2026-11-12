#!/usr/bin/env python3
"""Write a replica's own recovery evidence, in the shape of the accepted live evidence.

Legacy reconciliation and its read-only preflight read the evidence of one
manual recovery on the live host: a final receipt, a filesystem manifest, an
archive of the original configuration and an inspect record, with a database
checkpoint, the Caddy recovery receipt and the transition state. All of it
names the live host's containers, boots and volumes. A replica built by
build_replica.py has other containers, so a rehearsal needs the same records
about the replica itself. This script writes them from what the replica's own
Docker Engine and files say.

It refuses on any host that is not a declared replica. In order, and
repeatably:

1. Stops and starts the legacy application once, with the stop command the
   handoff uses, so that its boot differs from the checkpoint's boot as on live.
2. Creates, inspects and removes an "original proxy": a container with the
   serving proxy's settings. On live the original proxy was removed in the
   recovery; only its inspect record and ID remain.
3. Rewrites the Caddy recovery receipt: the original proxy ID and the four
   volume identities become the replica's.
4. Rewrites the transition state with the tooling's own write_state: the
   receipt hash, and the retained proxy's ID, boot and volume hash. The process
   and namespace numbers stay: on live, too, they describe a process that no
   longer runs.
5. Writes the manual evidence folder. The archive holds the original
   configuration files: export_archived_originals.py output, completed with the
   replica's own values as prepare_inputs.py completes the current files.
6. Writes accepted-replica.json: the nine hashes run_with_replica_pins.py
   puts in place of the live pins.

The handoff markers are left as exported: reconciliation checks them by hash.
Every record this script writes says that it is a rehearsal record.

Run it in the private working folder of prepare_inputs.py, which must also hold
original-control-files.tar. The request is the one the tooling's request
preparation takes:

    write_recovery_evidence.py < input.json > evidence-report.json

    {"deploy_dir": ..., "instance": ..., "checkpoint_dir": ..., "manual_evidence_dir": ...}

Each folder is an absolute path as written, without a "." or ".." part, that
exists and that no link leads to: the rule of the tooling that reads them next.

The checkpoint is taken beforehand, with the procedure a deployment window
uses. Nothing is printed but names, counts and hashes.
"""
import datetime
import hashlib
import io
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tarfile
import time

# The tooling's identity is a hash of its folder. A bytecode cache written there would change it.
sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
sys.path[:0] = [str(HERE.parent / 'hosted-deploy'), str(HERE.parent), str(HERE)]
from build_replica import Engine, Refused, declared_replica
import prepare_inputs

DOCKER = '/usr/bin/docker'
ORIGINALS, ORIGINAL_PROXY, PINS = 'original-control-files.tar', 'original-proxy.inspect.json', 'accepted-replica.json'
TOKEN_LABEL = 'org.dollhousemcp.proxy-recovery-token'
NOTE = 'written on a replica by write_recovery_evidence.py; a rehearsal record, not a record of a real recovery'
HEALTH_WAIT = 180
REQUEST = {'deploy_dir', 'instance', 'checkpoint_dir', 'manual_evidence_dir'}
INSTANCE = re.compile(r'[a-z0-9][a-z0-9_-]{0,62}\Z')
FOLDER = re.compile(r'(?:/[A-Za-z0-9_][A-Za-z0-9_.-]*)+\Z')


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def digest(data):
    return hashlib.sha256(data).hexdigest()


def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()


def canonical(text):
    """One folder of the request: it exists, and no link leads to it."""
    path = Path(text)
    if not path.is_dir() or path.resolve(strict=True) != path:
        raise ValueError('a folder of the request does not exist, or a link leads to it')
    return path


def private(path, data):
    """Replace one private file: a new inode, mode 0600, one link. Returns its hash."""
    temporary = path.with_name('.' + path.name + '.new')
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)
    return digest(data)


def restart_application(inspect, name, header):
    """Give the application a boot that differs from the checkpoint's, as the live recovery did."""
    app = inspect(name)
    if app['Id'] != header['app']['id']:
        raise ValueError('the checkpoint names another application container')
    if app['State']['StartedAt'] != header['app']['started_at']:
        return 'already done'
    subprocess.run([DOCKER, 'stop', '--signal', 'SIGTERM', '--timeout', '-1', app['Id']], capture_output=True, check=True)
    subprocess.run([DOCKER, 'start', app['Id']], capture_output=True, check=True)
    deadline = time.monotonic() + HEALTH_WAIT
    while (inspect(name)['State'].get('Health') or {}).get('Status') != 'healthy':
        if time.monotonic() > deadline:
            raise ValueError('the application did not become healthy after its restart')
        time.sleep(2)
    return 'stopped with the handoff stop command and started again'


def original_proxy_request(serving):
    """The create request for a container with the serving proxy's settings and no recovery ownership."""
    config = {key: value for key, value in serving['Config'].items() if key != 'Hostname'}
    config['Labels'] = {key: value for key, value in config['Labels'].items() if key != TOKEN_LABEL}
    networks = {name: {'Aliases': [alias for alias in endpoint.get('Aliases') or [] if alias != serving['Id'][:12]]}
                for name, endpoint in serving['NetworkSettings']['Networks'].items()}
    return {**config, 'HostConfig': serving['HostConfig'], 'NetworkingConfig': {'EndpointsConfig': networks}}


def original_proxy(inspect, engine, serving, name):
    record = Path(ORIGINAL_PROXY)
    if record.exists():
        return json.loads(record.read_bytes()), 'already recorded'
    created = engine.call('POST', '/containers/create?name=' + name, original_proxy_request(serving))
    try:
        original = inspect(created['Id'])
    finally:
        engine.call('DELETE', '/containers/' + created['Id'])
    private(record, encoded(original))
    return original, 'created as %s, inspected and removed' % name


def completed_originals(root, overrides):
    """The original configuration files, completed and overridden exactly as the current files were."""
    known = json.loads(Path(prepare_inputs.KNOWN).read_bytes()) if Path(prepare_inputs.KNOWN).exists() else {}
    stored = json.loads((Path(prepare_inputs.OUTPUT) / 'secrets.json').read_bytes())
    values, before, files = prepare_inputs.Values(known, stored), set(stored), {}
    with tarfile.open(ORIGINALS, 'r:') as archive:
        manifest = json.loads(archive.extractfile('control-files/' + prepare_inputs.MANIFEST).read())
        modes = {record['path']: int(record['mode'], 8) for record in manifest['files']}
        for item in archive:
            relative = item.name[len('control-files/'):]
            if relative in modes:
                text = prepare_inputs.PLACEHOLDER.sub(values, archive.extractfile(item).read().decode('utf-8'))
                if relative in prepare_inputs.ENVIRONMENT_FILES:
                    text = prepare_inputs.overridden(text, overrides)
                files[relative] = (text.encode('utf-8'), modes[relative])
    if set(stored) != before:
        raise ValueError('an original file names a placeholder the replica has no value for')
    same = sorted(name for name, (raw, _) in files.items() if (root / name).is_file() and (root / name).read_bytes() == raw)
    return files, {'count': len(files), 'equal_to_the_current_file': same,
                   'differ_from_the_current_file': sorted(set(files) - set(same))}


def write_archive(path, root, files, trees):
    """The filesystem archive: the given folders, then the original configuration files."""
    temporary = path.with_name('.' + path.name + '.new')
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    prefix = str(root.relative_to('/')) + '/'
    with os.fdopen(fd, 'wb') as stream, tarfile.open(fileobj=stream, mode='w') as archive:
        for name, source in trees.items():
            archive.add(source, arcname=prefix + name)
        for relative, (raw, mode) in sorted(files.items()):
            item = tarfile.TarInfo(prefix + relative)
            item.uid, item.gid, item.mode, item.size, item.mtime = os.geteuid(), os.getegid(), mode, len(raw), int(time.time())
            archive.addfile(item, io.BytesIO(raw))
    os.replace(temporary, path)
    result = hashlib.sha256()
    with open(path, 'rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            result.update(block)
    return {'sha256': result.hexdigest(), 'bytes': path.stat().st_size}


def container_row(item):
    state = item['State']
    return {'id': item['Id'], 'name': item['Name'], 'image': item['Image'], 'running': state['Running'],
            'started_at': state['StartedAt'], 'finished_at': state.get('FinishedAt'),
            'health': (state.get('Health') or {}).get('Status'), 'restart_count': item['RestartCount']}


def final_receipt(origin, version, public, services, markers):
    """The final recovery receipt. `public` is what the tooling's own public acceptance returned."""
    app, postgres, serving, retained = services
    return {'observed_utc': now(), 'replica_rehearsal': NOTE, 'status': 'RECOVERED LEGACY; FORWARD ABORTED',
            'recovered': {'app': app['Id'], 'app_started_at': app['State']['StartedAt'],
                          'future_forward_deploy': 'blocked; separate reconciliation required', 'markers_preserved': True,
                          'postgres': postgres['Id'], 'restored_old_profile_proxy': serving['Id'],
                          'retained_aborted_proxy': retained['Id'], 'status': 'MANUALLY RECOVERED LEGACY; FORWARD ABORTED',
                          'version': version},
            'public_acceptance': [{'path': origin + row['path'], 'status': str(row['status']), 'completed_utc': now(),
                                   'body_version': row['version'], 'body_sha256': row['body_sha256'],
                                   'verification_marker_absent': True} for row in public],
            'containers': [container_row(item) for item in services],
            'proxy_serving_mounts': [{key: mount.get(key) for key in ('Type', 'Name', 'Source', 'Destination', 'RW')}
                                     for mount in serving['Mounts']],
            'markers_unchanged': markers, 'no_app_restart_in_this_continuation': True}


def filesystem_manifest(root, header, source_database, app, original, pending, receipt, archive, inspect_raw, names):
    return {'schema': 1, 'kind': 'legacy-window-filesystem-recovery', 'replica_rehearsal': NOTE, 'captured_utc': now(),
            'app': {'id': app['Id'], 'image_id': app['Image'], 'mounts': app['Mounts'],
                    'restart_count': header['app']['restart_count'], 'started_at': header['app']['started_at']},
            'database_container': source_database,
            'artifacts': {'filesystem.tar': archive,
                          'recovery.inspect.json': {'gid': os.getegid(), 'mode': 0o600, 'present': True, 'uid': os.geteuid(),
                                                    'sha256': digest(inspect_raw), 'size': len(inspect_raw)}},
            'original_proxy_id': original['Id'],
            'original_volumes': [receipt['profile']['data_volume'], receipt['profile']['config_volume']],
            'paths': [str(root / 'server'), str(root / 'portfolio')] + [str(root / name) for name in sorted(names)],
            'prepared_receipt': str(Path(pending['receipt']) / 'receipt.json'),
            'prepared_receipt_sha256': pending['receipt_sha256'],
            'limits': ['persisted filesystem observation, not atomic with database snapshot',
                       'does not prove acknowledged in-memory settlement',
                       'raw inspect/archive includes secrets; retain privately; never print contents']}


def write(request):
    from caddy_active_config import system_docker
    from caddy_release_action import object_digest
    from caddy_transition_state import read_state, write_state
    from caddy_volume_migration import inspect_one, inspect_volumes
    import legacy_handoff as handoff
    import legacy_manual_recovery_import as manual
    import legacy_recovery_action as recovery
    import legacy_recovery_boundary as boundary
    from legacy_recovery_profile import profile_hash

    def inspect(name):
        return inspect_one(system_docker, 'container', name)

    root, instance = canonical(request['deploy_dir']), request['instance']
    checkpoint, evidence = canonical(request['checkpoint_dir']), canonical(request['manual_evidence_dir'])
    report = {'kind': 'replica-evidence', 'written_utc': now(), 'note': NOTE}
    header = json.loads((checkpoint / 'checkpoint.json').read_bytes())
    report['application_restart'] = restart_application(inspect, instance, header)
    serving = inspect(instance + '-caddy')
    original, report['original_proxy'] = original_proxy(inspect, Engine(), serving, instance + '-caddy-original')

    pending = read_state(root)['pending']
    receipt_path = Path(pending['receipt']) / 'receipt.json'
    receipt = json.loads(receipt_path.read_bytes())
    receipt['profile']['container_id'] = original['Id']
    receipt['clone']['volumes'] = inspect_volumes(system_docker, [item['name'] for item in receipt['clone']['volumes']])
    names = subprocess.run([DOCKER, 'ps', '--all', '--format', '{{.Names}}'], capture_output=True, check=True).stdout.decode().split()
    retained_names = [name for name in names if re.fullmatch(re.escape(instance) + r'-caddy-aborted-[0-9a-f]{16}', name)]
    if len(retained_names) != 1:
        raise ValueError('exactly one retained aborted proxy is expected')
    retained = inspect(retained_names[0])
    state = read_state(root)
    state['pending']['receipt_sha256'] = private(receipt_path, json.dumps(receipt, sort_keys=True, separators=(',', ':')).encode())
    state['pending']['control']['proxy'].update(
        id=retained['Id'], started_at=retained['State']['StartedAt'], restart_count=retained['RestartCount'],
        volumes_sha256=object_digest(inspect_volumes(system_docker, state['pending']['volumes'])))
    write_state(root, state)
    pending = read_state(root)['pending']
    report['rewritten'] = {'recovery receipt': ['profile.container_id', 'clone.volumes'],
                           'transition state': ['pending.receipt_sha256', 'pending.control.proxy id, started_at, '
                                                'restart_count, volumes_sha256']}

    overrides = json.loads((Path(prepare_inputs.OUTPUT) / 'inputs.json').read_bytes()).get('overrides') or {}
    files, report['original_files'] = completed_originals(root, overrides)
    app, postgres = inspect(instance), inspect(instance + '-postgres')
    archive = write_archive(evidence / 'filesystem.tar', root, files,
                            {'server': pending['previous'], 'portfolio': root / 'portfolio'})
    inspect_raw = encoded([app, postgres, original])
    pins = {'filesystem_archive': archive['sha256'], 'original_inspect': private(evidence / 'recovery.inspect.json', inspect_raw)}
    source_database = json.loads((checkpoint / 'manifest.json').read_bytes())['source_database']
    pins['filesystem_manifest'] = private(evidence / 'manifest.json', encoded(filesystem_manifest(
        root, header, source_database, app, original, pending, receipt, archive, inspect_raw, files)))
    markers = {'.caddy-state/state.json': digest((root / '.caddy-state' / 'state.json').read_bytes())}
    for path in sorted((root / handoff.STATE).glob('*.json')):
        markers[handoff.STATE + '/' + path.name] = digest(path.read_bytes())
    origin = pending['control']['public_origin']
    public = [dict(row, path=path) for path, row in zip(('/healthz', '/readyz', '/mcp'), recovery.public_acceptance(origin))]
    pins['manual_receipt'] = private(evidence / 'FINAL-RECOVERY-RECEIPT.json', encoded(final_receipt(
        origin, recovery.LEGACY_VERSION, public, (app, postgres, serving, retained), markers)))
    database = boundary.database_fingerprint(system_docker, postgres['Id'])
    pins.update(checkpoint=digest((checkpoint / 'checkpoint.json').read_bytes()), state=markers['.caddy-state/state.json'],
                retained_proxy_profile=profile_hash(retained), schema=database['schema_sha256'],
                globals=database['globals_sha256'])
    if set(pins) != set(manual.ACCEPTED):
        raise ValueError('the replica pins do not cover the pinned names')
    private(Path(PINS), json.dumps(pins, indent=1, sort_keys=True).encode())
    report.update(markers=sorted(markers), pins_replaced=sorted(pins),
                  pins_equal_to_live=sorted(name for name, value in pins.items() if manual.ACCEPTED[name] == value),
                  evidence_files=sorted(os.listdir(evidence)))
    return report


def main(argv):
    if len(argv) != 1:
        raise ValueError('usage: write_recovery_evidence.py < input.json (see the header for the working folder)')
    request = json.loads(sys.stdin.read())
    if not isinstance(request, dict) or set(request) != REQUEST or any(not isinstance(item, str) for item in request.values()):
        raise ValueError('the request holds exactly: ' + ', '.join(sorted(REQUEST)))
    if not INSTANCE.fullmatch(request['instance']):
        raise ValueError('the instance name is not valid')
    if (not FOLDER.fullmatch(request['deploy_dir']) or not FOLDER.fullmatch(request['checkpoint_dir'])
            or not FOLDER.fullmatch(request['manual_evidence_dir'])):
        raise ValueError('each folder is an absolute path as written, without a "." or ".." part')
    declared_replica()
    print(json.dumps(write(request), indent=1))
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main(sys.argv))
    except Refused as error:
        print('refused: %s' % error, file=sys.stderr)
        sys.exit(3)
