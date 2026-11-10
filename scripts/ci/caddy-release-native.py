"""Rootful, disposable CI witness for the actual private Caddy adapter."""
import hashlib
import json
import os
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'hosted-deploy'))
from caddy_active_config import ActiveConfig, read_snapshots, snapshot_files, system_docker, validate_system, write_startup_file
from caddy_release_action import render_profiles


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
