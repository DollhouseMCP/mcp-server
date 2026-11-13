"""Rootful, disposable CI witness for the actual private Caddy adapter."""
import hashlib
import json
import os
from pathlib import Path
import sys
import time

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'hosted-deploy'))
from caddy_active_config import ActiveConfig, read_snapshots, snapshot_files, system_docker, validate_system, write_startup_file
from caddy_release_action import render_profiles
from caddy_control_failure import ControlFailure
from caddy_volume_migration import inspect_one
from legacy_recovery_guards import exact_container, lifecycle
from legacy_recovery_profile import profile


def stop_witness(identifier):
    before = inspect_one(system_docker, 'container', identifier)
    boot = lifecycle(before, True)
    started = time.monotonic()
    output = system_docker(['docker', 'stop', '--signal', 'SIGTERM', '--timeout', '-1', identifier], 90, 65536)
    if output not in (identifier.encode(), (identifier + '\n').encode()):
        raise ValueError('fixture Docker stop did not acknowledge its immutable ID')
    exact_container(system_docker, identifier, profile(before), before['Name'][1:], False, boot)
    return {'id': identifier, 'exit_code': 0, 'elapsed_seconds': time.monotonic() - started,
            'stdout_sha256': hashlib.sha256(output).hexdigest(), 'boot': boot, 'clean_stop': True}


def refused_load(session, fenced):
    if session.read() != fenced:
        raise ValueError('fixture must already be fenced before the refused load')
    try:
        # Deliberately invalid disposable config, sent to the real bound API.
        session.request('POST', '/load', b'fixture-invalid-json')
    except ControlFailure as error:
        diagnostic = error.diagnostic
    else:
        raise ValueError('fixture invalid private load unexpectedly succeeded')
    if (diagnostic['outcome'] != 'UNKNOWN' or diagnostic['exit_code'] != 22
            or diagnostic.get('identity_verified') is not True or not diagnostic['stderr']):
        raise ValueError('native private load failure lacks its expected diagnostic')
    if session.read() != fenced:
        raise ValueError('fixture refused load changed the active fence')
    return {'failure': diagnostic, 'later_get_observed_unchanged_fence': True, 'forward_applied': False}


def main():
    action, identifier, volume_root, state_root, token, trusted = sys.argv[1:]
    root, state = Path(volume_root), Path(state_root)
    validate_system()
    renderer = {'PROXY_MODE': 'caddy-http', 'HOSTNAME': 'fixture.local', 'HTTP_BIND_PORT': '80',
                'MCP_PORT': '8081', 'CADDY_TRUSTED_PROXIES': trusted, 'CADDY_ACCESS_LOG': 'true'}
    normal, verification = render_profiles(renderer, token)
    if action == 'begin':
        hashes = snapshot_files(state, token, normal, verification)
    else:
        hashes = {'normal_sha256': hashlib.sha256(normal).hexdigest(),
                  'verification_sha256': hashlib.sha256(verification).hexdigest()}
        read_snapshots(state, token, hashes)
    if action == 'stop-witness':
        print(json.dumps(stop_witness(identifier)))
        return
    session = ActiveConfig(identifier, system_docker)
    try:
        before, fenced = session.adapt(normal), session.adapt(verification)
        if action == 'begin':
            if session.read() != before:
                raise ValueError('fixture normal configuration changed')
            write_startup_file(root, normal, verification, session.identity['pid'])
            session.load(fenced)
        elif action == 'check':
            if session.read() != fenced or (root / 'Caddyfile').read_bytes() != verification:
                raise ValueError('fixture verification configuration did not survive restart')
        elif action == 'refuse-load':
            print(json.dumps(refused_load(session, fenced)))
            return
        elif action == 'finish':
            if session.read() != fenced:
                raise ValueError('fixture verification configuration changed')
            write_startup_file(root, verification, normal, session.identity['pid'])
            session.load(before)
        else:
            raise ValueError('unsupported fixture action')
        session.recheck()
        print(json.dumps({'action': action, 'container': identifier, 'boot': session.identity,
                          'normal_sha256': hashes['normal_sha256'], 'verification_sha256': hashes['verification_sha256'],
                          'active_sha256': hashlib.sha256(session.read()).hexdigest()}))
    finally:
        session.close()


if __name__ == '__main__':
    main()
