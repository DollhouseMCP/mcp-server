#!/usr/bin/env python3
"""Finish a legacy update that stopped after the upgraded app started, with the update's own remaining steps.

After the upgraded app has started, legacy-offline-update has four steps left: the public acceptance probe, the
release of the normal proxy profile, the completion record and the deployed markers. If one of them does not
pass, the update stops there. The upgraded app runs on the migrated database, the proxy stays in its verification
profile and answers 503, and every other action refuses the pending release. recover-legacy cannot apply: the
forward write was issued.

This action runs the steps that are left, as the update runs them, and nothing else. It first proves that only
they are left:

- the forward write of this transition was issued, so the legacy stop, the migrations and the grants are behind it;
- the pending transition is this update: staged, with this token and these volumes, its source and receipt unchanged;
- its release stands at probed, accepted or released, for this public origin;
- the app is another container than the legacy app that was stopped, it was created from the upgraded runtime
  image named in the request, and it runs. Starting that container is the update's last step before acceptance.

Then, from where the release stands: the acceptance probe, the release, the markers, the completion record. Each
is the update's own function, and a step that fails leaves what it leaves in the update. A failed acceptance
changes nothing, so this action can be named again. A release that fails stops the proxy and stands at
"releasing": this action refuses that, as every action does.

The update writes the markers after the completion record. Here they come before it, so that a run which ends
between the two can be named again: until the record is written the transition is pending, and this action applies.

    legacy_update_completion.py complete-legacy-update < request.json

    {"deploy_dir": ..., "instance": ..., "data_volume": ..., "config_volume": ..., "token": ...,
     "public_base_url": ..., "timeout": ..., "runtime_image": ..., "revision": ...}

`revision` is the commit the update staged, as the update itself would write it to DEPLOYED_REVISION.
"""
import datetime
import json
import os
from pathlib import Path
import re
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from caddy_active_config import system_docker, validate_system
from caddy_clone_action import acquire_lock, validate_request
from caddy_recovery_receipt import MAX_RECORD, private_directory
from caddy_release_action import accept, pending_control, public_origin, release
from caddy_transition_action import complete
from caddy_volume_migration import inspect_one
from image_scan_intake import unique_object
import legacy_handoff as handoff
from legacy_recovery_boundary import window_path

ACTION = 'complete-legacy-update'
KEYS = {'deploy_dir', 'instance', 'data_volume', 'config_volume', 'token', 'public_base_url', 'timeout',
        'runtime_image', 'revision'}
LEFT = ('probed', 'accepted', 'released')
IMAGE = re.compile(r'[a-z0-9][a-z0-9./_-]*@sha256:[0-9a-f]{64}\Z')
REVISION = re.compile(r'[0-9a-f]{40}\Z')
IDENTIFIER = re.compile(r'[0-9a-f]{64}\Z')
SERVICE = 'dollhousemcp'


def validate(value):
    if not isinstance(value, dict) or set(value) != KEYS:
        raise ValueError('invalid legacy update completion request')
    root = validate_request({key: value[key] for key in ('deploy_dir', 'instance', 'data_volume', 'config_volume')})
    if (not all(isinstance(value[key], str) for key in ('runtime_image', 'revision', 'public_base_url'))
            or not IMAGE.fullmatch(value['runtime_image']) or not REVISION.fullmatch(value['revision'])):
        raise ValueError('the request must name the runtime image by digest and the staged revision by commit')
    if type(value['timeout']) is not int or not 0 <= value['timeout'] <= 600:
        raise ValueError('invalid public acceptance timeout')
    public_origin(value['public_base_url'])
    return root


def forward_write(directory, token):
    """The forward-write record of this transition, bound to its armed baseline. Returns the legacy app it stopped."""
    try:
        armed, armed_sha = handoff.read_json(directory, 'armed.json')
        issued, _ = handoff.read_json(directory, 'forward-write-issued.json')
    except FileNotFoundError:
        raise ValueError('no forward write was issued for this transition; this action does not apply') from None
    request = armed.get('request')
    if (issued.get('kind') != 'legacy-forward-write-issued' or issued.get('token') != token
            or issued.get('armed_sha256') != armed_sha or issued.get('host') != handoff.host_identity()
            or not isinstance(request, dict) or request.get('token') != token
            or not isinstance(request.get('app_id'), str) or not IDENTIFIER.fullmatch(request['app_id'])):
        raise ValueError('the forward-write record does not bind this transition on this host')
    return request['app_id']


def upgraded_app(run, value, legacy_app):
    """The update's last step before acceptance ran: the app is a new container from the upgraded image, and it runs."""
    found = run(['docker', 'ps', '--all', '--no-trunc', '--filter', 'label=com.docker.compose.project=' + value['instance'],
                 '--filter', 'label=com.docker.compose.service=' + SERVICE, '--format', '{{.ID}}'], 15, MAX_RECORD)
    identifiers = found.decode('ascii').splitlines()
    if len(identifiers) != 1 or not IDENTIFIER.fullmatch(identifiers[0]):
        raise ValueError('the app container is missing or ambiguous')
    app = inspect_one(run, 'container', identifiers[0])
    config, state = app.get('Config') or {}, app.get('State') or {}
    if (app.get('Id') != identifiers[0] or app['Id'] == legacy_app or app.get('Name') != '/' + value['instance']
            or config.get('Image') != value['runtime_image'] or state.get('Running') is not True
            or state.get('Restarting') is not False):
        raise ValueError('the app is not a running container that this update created from the upgraded runtime image')
    return app['Id']


def write_markers(root, revision, clock):
    """DEPLOYED_REVISION and DEPLOYED_AT, as the update writes them once the replacement has succeeded."""
    directory = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for name, text in (('DEPLOYED_REVISION', revision), ('DEPLOYED_AT', clock().strftime('%Y-%m-%dT%H:%M:%SZ'))):
            descriptor = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o644, dir_fd=directory)
            with os.fdopen(descriptor, 'w', encoding='ascii') as handle:
                handle.write(text + '\n')
                handle.flush()
                os.fsync(handle.fileno())
        os.fsync(directory)
    finally:
        os.close(directory)


def complete_update(root, value, run=system_docker, clock=None):
    clock = clock or (lambda: datetime.datetime.now(datetime.timezone.utc))
    token = value['token']
    try:
        directory = private_directory(window_path(root, token))
    except FileNotFoundError:
        raise ValueError('no legacy recovery window exists for this transition; this action does not apply') from None
    try:
        legacy_app = forward_write(directory, token)
    finally:
        os.close(directory)
    _, pending, control = pending_control(root, token)
    if pending['kind'] != 'update' or pending['volumes'] != [value['data_volume'], value['config_volume']]:
        raise ValueError('the pending transition is not this update')
    if not isinstance(control, dict) or control['phase'] not in LEFT:
        raise ValueError('the release does not stand at acceptance, release or completion; this action does not apply')
    if public_origin(value['public_base_url']) != control['public_origin']:
        raise ValueError('public acceptance origin changed')
    app = upgraded_app(run, value, legacy_app)
    stood = control['phase']
    request = {**value, 'allow_bootstrap': True}
    for stage, step in (('probed', accept), ('accepted', release)):
        if pending_control(root, token)[2]['phase'] == stage:
            step(request, root)
    write_markers(root, value['revision'], clock)
    complete(root, token, value['instance'])
    return {'outcome': 'COMPLETED', 'stood_at': stood, 'token': token, 'app_id': app}


def main():
    if len(sys.argv) != 2 or sys.argv[1] != ACTION:
        raise ValueError('explicit %s action required' % ACTION)
    raw = sys.stdin.buffer.read(MAX_RECORD + 1)
    if len(raw) > MAX_RECORD:
        raise ValueError('request exceeds its bound')
    value = json.loads(raw, object_pairs_hook=unique_object)
    root = validate(value)
    validate_system()
    lock = acquire_lock(root, allow_control=True)
    try:
        print(json.dumps(complete_update(root, value), sort_keys=True))
    finally:
        os.close(lock)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('Legacy update completion refused or failed; read the release state before anything else: ' + str(error),
              file=sys.stderr)
        for note in getattr(error, '__notes__', ()):
            print(note, file=sys.stderr)
        sys.exit(1)
