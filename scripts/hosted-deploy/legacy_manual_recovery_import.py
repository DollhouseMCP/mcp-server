"""One-time adoption of the accepted, pre-journal legacy recovery.

These hashes identify retained private evidence, not live credentials. No
operator override can bless a different historical recovery or replay its stop.
The caller still verifies current service/profile/DB state before reconciliation.
"""
import io
import json
import os
from pathlib import Path
import stat
import tarfile

from caddy_recovery_receipt import MAX_RECORD, read_private
from caddy_release_action import pending_control
from caddy_volume_migration import inspect_one
from image_scan_intake import unique_object
import legacy_handoff as handoff
from legacy_control_resolution import raw_state
from legacy_recovery_action import LEGACY_VERSION
from legacy_recovery_boundary import FILES, REQUIRED, checkpoint_database, database_fingerprint, read_configuration, window_path
from legacy_recovery_guards import lifecycle
from legacy_recovery_profile import profile, profile_hash

ACCEPTED = {
    'manual_receipt': 'b77bda432e549d0bf845db01478d48aed31466862c58dbb7ee61819b5a012ce8',
    'filesystem_manifest': '72ecd5eb03de630dbbc56e8eabaf872a98d94c6a75a07699a08c74628b99b2ee',
    'filesystem_archive': 'd41d5b6ebc31b2be9efd3da862d53dc6cb1634412af027b897f2bdbc5ac8c809',
    'original_inspect': '043f7a02827c69b45b1fa247164bc6de6bdb4ededfa124cec33b2ecad0da52df',
    'checkpoint': '889da12d0cfebd94897fee9f708d2af901aee5a59a397f3731cadf7cbd6f254b',
    'state': '7314e3eeafd54d858ef04a1d9b20d17f56ed03a6070cf9f3913ddad6797acb2f',
    'retained_proxy_profile': '37b4e87fdebabe8c03c561e834d330072d1c86628f853088cf0c3ce3ea15b642',
    'schema': 'dec500413de4922ab9c15b705905e2105eabbd279cbdd8d1011049b8b56801dc',
    'globals': '644f17c169b0586139455794d710b130c81f9712c8ef784967741bf9a1868975',
}
OVERLAYS = {'original-candidate-overlay.json': 'cutover-staging-e544-20261013-r2/candidate-overlay.json',
            'original-caddy-rebind-overlay.json': 'cutover-staging-e544-20261013-r2/caddy-rebind-overlay.json'}
ARCHIVE_LIMIT = 64 * 1024 * 1024


def fixed_members(root, raw):
    members = {str(root.relative_to('/')) + '/' + path: name
               for name, path in ({name: name for name in FILES} | OVERLAYS).items()}
    result = {}
    with tarfile.open(fileobj=io.BytesIO(raw), mode='r:') as archive:
        for count, item in enumerate(archive, 1):
            if count > 100000:
                raise ValueError('legacy filesystem archive member count exceeds its bound')
            name = members.get(item.name)
            if name is None:
                continue
            if (name in result or item.type not in (tarfile.REGTYPE, tarfile.AREGTYPE)
                    or item.uid != os.geteuid() or item.size > MAX_RECORD or item.mode & 0o7022):
                raise ValueError('original configuration archive member is unsafe')
            mode = stat.S_IMODE(item.mode)
            if name in ('.env', '.env.production') and mode != 0o600:
                raise ValueError('original archived environment was not private')
            with archive.extractfile(item) as stream:
                content = stream.read(MAX_RECORD + 1)
            if len(content) != item.size:
                raise ValueError('original configuration archive member is truncated')
            result[name] = (content, mode)
    if not (REQUIRED | set(OVERLAYS)) <= set(result):
        raise ValueError('original configuration archive or overlay inventory is incomplete')
    return result


def artifact(directory, name, expected, maximum):
    raw = read_private(directory, name, maximum)
    if handoff.digest(raw) != expected:
        raise ValueError('accepted manual recovery artifact hash differs: ' + name)
    return raw


def archive_inputs(root, evidence_dir, pending):
    directory = handoff.private_root(evidence_dir)
    try:
        final, _ = handoff.read_json(directory, 'FINAL-RECOVERY-RECEIPT.json', ACCEPTED['manual_receipt'])
        manifest, _ = handoff.read_json(directory, 'manifest.json', ACCEPTED['filesystem_manifest'])
        raw = artifact(directory, 'filesystem.tar', ACCEPTED['filesystem_archive'], ARCHIVE_LIMIT)
        inspect_raw = artifact(directory, 'recovery.inspect.json', ACCEPTED['original_inspect'], MAX_RECORD)
    finally:
        os.close(directory)
    if (manifest.get('schema') != 1 or manifest.get('kind') != 'legacy-window-filesystem-recovery'
            or manifest.get('prepared_receipt') != str(Path(pending['receipt']) / 'receipt.json')
            or manifest.get('prepared_receipt_sha256') != pending['receipt_sha256']
            or manifest['artifacts']['filesystem.tar'] != {'sha256': ACCEPTED['filesystem_archive'], 'bytes': len(raw)}
            or manifest['artifacts']['recovery.inspect.json']['sha256'] != ACCEPTED['original_inspect']):
        raise ValueError('accepted filesystem archive does not bind the failed transition')
    original = json.loads(inspect_raw, object_pairs_hook=unique_object)
    if not isinstance(original, list) or len(original) != 3 or len({item['Id'] for item in original}) != 3:
        raise ValueError('original app/Postgres/proxy inspect inventory differs')
    return final, manifest, {item['Id']: item for item in original}, fixed_members(root, raw)


def check_acceptance(final, origin):
    recovered = final.get('recovered', {})
    if (final.get('status') != 'RECOVERED LEGACY; FORWARD ABORTED' or recovered.get('version') != LEGACY_VERSION
            or recovered.get('markers_preserved') is not True or final.get('no_app_restart_in_this_continuation') is not True):
        raise ValueError('accepted manual recovery verdict differs')
    public = final.get('public_acceptance')
    expected = [(origin + '/healthz', '200', LEGACY_VERSION), (origin + '/readyz', '200', LEGACY_VERSION),
                (origin + '/mcp', '401', None)]
    if not isinstance(public, list) or len(public) != 3 or any(
            (row['path'], row['status'], row['body_version']) != want or row['verification_marker_absent'] is not True
            for row, want in zip(public, expected)):
        raise ValueError('accepted manual public proof differs')
    return recovered


def verify_boot(final, actual, running):
    evidence = [row for row in final['containers'] if row['id'] == actual['Id']]
    if len(evidence) != 1:
        raise ValueError('manual recovery container inventory is ambiguous')
    row = evidence[0]
    if row['name'] != actual['Name'] or row['image'] != actual['Image'] or row['running'] is not running:
        raise ValueError('manual recovery container identity changed')
    return lifecycle(actual, running, {key: row[key] for key in ('started_at', 'restart_count')})


def validate_failed_state(root, value, state, pending):
    if (state['completed'] is not None or handoff.digest(raw_state(root)) != ACCEPTED['state']
            or pending['volumes'] != [value['data_volume'], value['config_volume']]):
        raise ValueError('current failed controls differ from the accepted manual recovery')


def import_accepted(root, value, evidence_dir, run):
    window = window_path(root, value['token'])
    if window.exists() or window.is_symlink():
        raise ValueError('manual adoption cannot replace an armed recovery window')
    state, pending, control = pending_control(root, value['token'], 'probed')
    validate_failed_state(root, value, state, pending)
    final, manifest, originals, files = archive_inputs(root, evidence_dir, pending)
    recovered = check_acceptance(final, control['public_origin'])
    if recovered['app'] != value['app_id'] or recovered['postgres'] != value['postgres_id']:
        raise ValueError('manual recovery services differ from the request')
    request, checkpoint_sha, db_manifest = handoff.checkpoint(value['checkpoint_dir'])
    if (checkpoint_sha != ACCEPTED['checkpoint'] or manifest['app']['id'] != request['app']['id']
            or manifest['database_container']['id'] != db_manifest['source_database']['id']
            or manifest['original_proxy_id'] not in originals):
        raise ValueError('accepted checkpoint or original filesystem service binding differs')
    handoff.verify_database(value, db_manifest, run)
    handoff.app_profile(run, value['instance'], value['app_id'], True, root)
    app = inspect_one(run, 'container', value['app_id'])
    postgres = inspect_one(run, 'container', value['postgres_id'])
    for actual in (app, postgres):
        if profile(actual) != profile(originals[actual['Id']]):
            raise ValueError('manual recovery app or database full profile changed')
        verify_boot(final, actual, True)
    database = database_fingerprint(run, value['postgres_id'])
    checkpoint_database(value, database)
    if database['schema_sha256'] != ACCEPTED['schema'] or database['globals_sha256'] != ACCEPTED['globals']:
        raise ValueError('accepted pre-migration schema/globals boundary changed')
    retained = inspect_one(run, 'container', recovered['retained_aborted_proxy'])
    if retained['Id'] != control['proxy']['id'] or profile_hash(retained) != ACCEPTED['retained_proxy_profile']:
        raise ValueError('accepted retained proxy full profile changed')
    verify_boot(final, retained, False)
    proxy = inspect_one(run, 'container', recovered['restored_old_profile_proxy'])
    verify_boot(final, proxy, True)
    # The historical archive did not promise that unlisted optional files were
    # absent. Preserve any such current metadata rather than inventing deletion.
    unarchived = []
    for name in FILES:
        if name not in files:
            try:
                files[name] = read_configuration(root, name)
            except FileNotFoundError:
                continue
            unarchived.append(name)
    return {'state': state, 'pending': pending, 'files': files, 'database': database, 'app': app,
            'postgres': postgres, 'proxy': proxy, 'retained': retained, 'proxy_token': value['token'],
            'source': pending['source'], 'checkpoint_sha256': checkpoint_sha, 'manual_receipt_sha256': ACCEPTED['manual_receipt'],
            'original_proxy_id': manifest['original_proxy_id'], 'marker_hashes': final['markers_unchanged'],
            'unchanged_unarchived_files': unarchived}
