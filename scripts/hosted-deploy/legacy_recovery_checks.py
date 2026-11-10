"""Read-only pre-migration recovery gates, independent of forward Caddy calls."""
import os
from pathlib import Path

from caddy_active_config import ActiveConfig, read_snapshots
from caddy_recover_action import recovery_kind
from caddy_recovery_preflight import preflight, validate_old_image
from caddy_recovery_receipt import private_directory, read_caddy_snapshot
from caddy_release_action import object_digest, pending_control
from caddy_volume_migration import inspect_one, inspect_volumes, verify_original_volumes
import legacy_handoff as handoff
import legacy_recovery_boundary as boundary
from legacy_recovery_guards import exact_container, ingress_available, lifecycle, serving_dns
from legacy_recovery_profile import profile


def database(root, value, armed, run):
    request, checkpoint_sha, manifest = handoff.checkpoint(value['checkpoint_dir'])
    if checkpoint_sha != armed['checkpoint_sha256']:
        raise ValueError('qualified checkpoint differs from the armed recovery baseline')
    handoff.verify_database(value, manifest, run)
    exact_container(run, value['postgres_id'], armed['profiles']['postgres'],
                    value['instance'] + '-postgres', True)
    if boundary.database_fingerprint(run, value['postgres_id']) != armed['database']:
        raise ValueError('database boundary is uncertain; qualified checkpoint restoration is required')
    return request


def forward_state(root, value, armed, expected=None):
    boundary.refuse_forward_write(root, value['token'])
    state, pending, control = pending_control(root, value['token'])
    if (pending['kind'] != 'update' or not isinstance(control, dict)
            or control['phase'] not in ('prepared', 'fenced', 'probed')
            or pending['source'] != armed['source'] or pending['previous'] != armed['previous']
            or pending['receipt'] != armed['receipt'] or pending['receipt_sha256'] != armed['receipt_sha256']
            or (expected is not None and state != expected)):
        raise ValueError('forward controls differ or crossed the pre-migration recovery boundary')
    # Validate protected snapshots without issuing GET /config/ or POST /load.
    read_snapshots(root, value['token'], control)
    return state, pending, control


def handoff_state(root, value, armed, pending, run):
    try:
        directory = private_directory(root / handoff.STATE)
    except FileNotFoundError:
        _, checkpoint_sha, app = handoff.verify_inputs(value, run)
        if checkpoint_sha != armed['checkpoint_sha256'] or app != armed['app']:
            raise ValueError('never-stopped legacy boot differs')
        return {'mode': 'never-stopped', 'app_boot': {k: app[k] for k in ('started_at', 'restart_count')}}
    try:
        issued, issued_sha = handoff.read_json(directory, 'issued.json')
        try:
            receipt, receipt_sha = handoff.read_json(directory, 'receipt.json')
        except FileNotFoundError:
            receipt, receipt_sha = None, None
    finally:
        os.close(directory)
    declared_fence = {'token': value['token'], 'proxy': pending['control']['proxy'], 'source': pending['source']}
    if receipt is None:
        known, ack_sha = handoff.verify_stop_acknowledgement(root, value, declared_fence, run)
        if known['app'] != armed['app']:
            raise ValueError('acknowledged stop is not bound to the armed app')
        return {'mode': 'stop-acknowledged', 'stop_ack_sha256': ack_sha, 'issued_sha256': issued_sha,
                'app_boot': {k: armed['app'][k] for k in ('started_at', 'restart_count')}}
    # A completed clean stop is mandatory. The declared forward fence is NOT
    # promoted: recovery establishes a separate, acknowledged offline fence.
    handoff.verify_completed(root, value, run, verify_fence=lambda *_: declared_fence)
    if issued['app'] != armed['app'] or receipt['app'] != armed['app']:
        raise ValueError('legacy stop is not bound to the armed app')
    _, ack_sha = handoff.verify_stop_acknowledgement(root, value, declared_fence, run)
    return {'mode': 'stopped', 'handoff_sha256': receipt_sha, 'stop_ack_sha256': ack_sha, 'issued_sha256': issued_sha,
            'app_boot': {k: armed['app'][k] for k in ('started_at', 'restart_count')}}


def original_proxy(root, armed, run, admit):
    kind, record, receipt_path = recovery_kind(root, Path(armed['previous']))
    if kind != 'legacy' or str(receipt_path) != armed['receipt']:
        raise ValueError('recovery requires the exact legacy proxy receipt')
    validate_old_image(inspect_one(run, 'image', record['profile']['image_id']), record['profile'], admit)
    verify_original_volumes(run, record['clone'], Path(__file__).with_name('caddy_volume_copy.mjs'),
                            os.environ.get('DOCKER_HOST'))
    return record, receipt_path


def preconditions(root, value, armed, run, admit):
    state, pending, control = forward_state(root, value, armed)
    database(root, value, armed, run)
    app_status = handoff_state(root, value, armed, pending, run)
    plan = preflight(root, value['instance'], Path(armed['previous']), pending['image'], run, admit)
    current = inspect_one(run, 'container', plan['current_id'])
    boot = lifecycle(current, True)
    if control['proxy'] is not None:
        bound = control['proxy']
        if (bound['id'] != current['Id'] or bound['started_at'] != boot['started_at']
                or bound['restart_count'] != boot['restart_count'] or bound['pid'] != current['State']['Pid']
                or bound['profile_sha256'] != object_digest(plan['current_profile'])
                or bound['volumes_sha256'] != object_digest(inspect_volumes(run, pending['volumes']))
                or namespace_identity(bound['pid']) != (bound['net_device'], bound['net_inode'])):
            raise ValueError('failed forward proxy identity changed')
    ingress_available(run, plan['record']['profile']['ports'], excluded=(current['Id'],))
    serving_dns(run, value['instance'], value['app_id'], app_running=app_status['mode'] == 'never-stopped')
    exact_container(run, value['app_id'], armed['profiles']['app'], value['instance'],
                    app_status['mode'] == 'never-stopped', app_status['app_boot'])
    return plan, {'forward_state': state, 'proxy_profile': profile(current), 'proxy_boot': boot,
                  'app': app_status, 'current_id': current['Id']}


def namespace_identity(pid):
    info = os.stat('/proc/' + str(pid) + '/ns/net')
    return info.st_dev, info.st_ino


def behind_offline_fence(root, value, armed, baseline, run):
    forward_state(root, value, armed, baseline['forward_state'])
    exact_container(run, baseline['current_id'], baseline['proxy_profile'], value['instance'] + '-caddy',
                    False, baseline['proxy_boot'])
    database(root, value, armed, run)


def serving_config(identifier, receipt_path, record, boot):
    content = read_caddy_snapshot(receipt_path, record['caddyfile_sha256'])
    session = ActiveConfig(identifier)
    try:
        if (session.identity['started_at'] != boot['started_at']
                or session.identity['restart_count'] != boot['restart_count']):
            raise ValueError('recovered serving proxy boot changed')
        expected = session.adapt(content)
        if session.read() != expected:
            raise ValueError('recovered serving configuration differs from the original receipt')
        session.recheck()
    finally:
        session.close()
