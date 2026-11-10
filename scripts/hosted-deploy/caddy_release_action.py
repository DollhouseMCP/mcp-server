"""Receipt-bound verification fence and final normal-profile activation."""
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import sys
import time
from urllib.parse import urlsplit

SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))
sys.dont_write_bytecode = True
from caddy_active_config import ActiveConfig, CURL, DOCKER, bounded_input, executable, read_snapshots, snapshot_files, validate_system, write_startup_file
from caddy_bundle_identity import bundle_identity
from caddy_clone_action import acquire_lock, capture_profile, validate_request
from caddy_image_admission import qualify
from caddy_recovery_receipt import read_current_caddyfile
from caddy_service_guard import unique_proxy
from caddy_transition_state import read_state, write_state
from caddy_unchanged_action import no_other_writers
from caddy_volume_migration import inspect_one, inspect_volumes
from image_scan_intake import unique_object


def digest(data):
    return hashlib.sha256(data).hexdigest()


def object_digest(value):
    return digest(json.dumps(value, sort_keys=True, separators=(',', ':')).encode('utf-8'))


def validate_renderer(renderer):
    keys = {'PROXY_MODE', 'HOSTNAME', 'HTTP_BIND_PORT', 'MCP_PORT', 'CADDY_TRUSTED_PROXIES', 'CADDY_ACCESS_LOG'}
    if not isinstance(renderer, dict) or set(renderer) != keys or any(
            not isinstance(value, str) or any(char in value for char in '\n\r\x00') for value in renderer.values()):
        raise ValueError('invalid fixed Caddy renderer inputs')
    if renderer['PROXY_MODE'] not in ('caddy-http', 'caddy-tls') or renderer['CADDY_ACCESS_LOG'] not in ('true', 'false'):
        raise ValueError('invalid fixed Caddy renderer mode')
    if (not re.fullmatch(r'[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?', renderer['HOSTNAME'])
            or '..' in renderer['HOSTNAME']):
        raise ValueError('invalid fixed Caddy renderer host')
    for key in ('HTTP_BIND_PORT', 'MCP_PORT'):
        value = renderer[key]
        if not re.fullmatch(r'[1-9]\d{0,4}', value, flags=re.ASCII) or int(value) > 65535:
            raise ValueError('invalid fixed Caddy renderer port')
    if not re.fullmatch(r'[0-9A-Fa-f:.,/]*', renderer['CADDY_TRUSTED_PROXIES']):
        raise ValueError('invalid fixed Caddy trusted proxy list')
    if renderer['CADDY_TRUSTED_PROXIES']:
        for network in renderer['CADDY_TRUSTED_PROXIES'].split(','):
            if '/' not in network:
                raise ValueError('invalid fixed Caddy trusted proxy list')
            ipaddress.ip_network(network, strict=False)


def render_profiles(renderer, token):
    validate_renderer(renderer)
    executable('/bin/bash')
    script = str(Path(__file__).with_name('render.sh'))
    if not re.fullmatch(r'[0-9a-f]{32}', token):
        raise ValueError('invalid Caddy verification token')
    command = ['/bin/bash', '-e', '-c', 'source "$1"; caddyfile_content "$2" "$3"', 'caddy-render', script]
    env = {'PATH': '/usr/bin:/bin', 'LC_ALL': 'C', **renderer}
    normal = bounded_input([*command, 'false', token], env=env)
    verification = bounded_input([*command, 'true', token], env=env)
    return normal, verification


def pending_control(root, token, phase=None):
    state = read_state(root)
    pending = state['pending']
    if not isinstance(pending, dict) or pending['token'] != token or pending['phase'] != 'staged':
        raise ValueError('no matching staged Caddy transition')
    if bundle_identity(root / 'server') != pending['staged_source']:
        raise ValueError('staged Caddy source changed')
    if pending['kind'] == 'rollback' and pending['staged_source'] != pending['source']:
        raise ValueError('rollback source changed')
    if pending['kind'] == 'update':
        from caddy_recover_action import recovery_kind
        from caddy_transition_action import receipt_hash
        previous = Path(pending['previous'])
        if bundle_identity(previous) != pending['source'] or receipt_hash(Path(pending['receipt'])) != pending['receipt_sha256']:
            raise ValueError('previous Caddy source or receipt changed')
        _, _, receipt = recovery_kind(root, previous)
        if str(receipt) != pending['receipt']:
            raise ValueError('previous Caddy receipt selection changed')
    control = pending.get('control')
    if phase is not None and (not isinstance(control, dict) or control['phase'] != phase):
        raise ValueError('Caddy verification phase is not eligible')
    return state, pending, control


def bind_proxy(session, root, instance, pending):
    profile = capture_profile(session.run, root, instance, admit=lambda ref: qualify(ref, docker=DOCKER), expected_running=True)
    if profile.get('kind') != 'hardened' or profile['container_id'] != session.identity['id']:
        raise ValueError('verification requires the selected hardened Caddy proxy')
    if profile['reference'] != pending['image'] or [profile['data_volume'], profile['config_volume']] != pending['volumes']:
        raise ValueError('verification proxy selection changed')
    volumes = inspect_volumes(session.run, pending['volumes'])
    no_other_writers(session.run, profile['container_id'], volumes)
    session.recheck()
    return {**session.identity, 'net_device': session.namespace[0], 'net_inode': session.namespace[1],
            'profile_sha256': object_digest(profile), 'volumes_sha256': object_digest(volumes)}


def check_bound(session, root, instance, pending, control, expected_content, expected_config):
    if bind_proxy(session, root, instance, pending) != control['proxy']:
        raise ValueError('verification proxy identity changed')
    if read_current_caddyfile(root) != expected_content:
        raise ValueError('Caddy startup profile changed')
    mounted = os.stat('/proc/' + str(session.identity['pid']) + '/root/etc/caddy/Caddyfile')
    host = (Path(root) / 'Caddyfile').stat()
    if (mounted.st_dev, mounted.st_ino) != (host.st_dev, host.st_ino):
        raise ValueError('Caddy startup file is not the bound inode')
    if session.read() != expected_config:
        raise ValueError('active Caddy configuration changed')
    session.recheck()


def prepare(value, root):
    state, pending, control = pending_control(root, value['token'])
    if control is not None:
        raise ValueError('Caddy verification already has a pending record')
    validate_system()
    normal, verification = render_profiles(value['renderer'], value['token'])
    origin = public_origin(value['public_base_url'])
    parts = urlsplit(origin)
    renderer = value['renderer']
    if parts.hostname != renderer['HOSTNAME'].lower():
        raise ValueError('public acceptance origin differs from the selected Caddy site')
    if read_current_caddyfile(root) != normal:
        raise ValueError('normal Caddyfile differs from the fixed renderer')
    hashes = snapshot_files(root, value['token'], normal, verification)
    pending['control'] = {'phase': 'prepared', **hashes, 'public_origin': origin, 'normal_config_sha256': None,
                          'verification_config_sha256': None, 'proxy': None}
    write_state(root, state)
    if value['keep_proxy']:
        identifier = unique_proxy(session_run(), value['instance'])
        session = ActiveConfig(identifier)
        try:
            before = bind_proxy(session, root, value['instance'], pending)
            normal_config = session.adapt(normal)
            if session.read() != normal_config:
                raise ValueError('existing active Caddy configuration differs from normal')
            verification_config = session.adapt(verification)
            if bind_proxy(session, root, value['instance'], pending) != before:
                raise ValueError('existing Caddy proxy changed before verification')
            write_startup_file(root, normal, verification, session.identity['pid'])
            session.recheck()
            session.load(verification_config)
        finally:
            session.close()
    else:
        identifier = unique_proxy(session_run(), value['instance'], required=False)
        if identifier is not None:
            observed = inspect_one(session_run(), 'container', identifier)
            if observed.get('Id') != identifier or observed.get('State', {}).get('Running') is not False:
                raise ValueError('original Caddy proxy is not stopped')
        write_startup_file(root, normal, verification)


def session_run():
    from caddy_active_config import system_docker
    return system_docker


def confirm(value, root):
    state, pending, control = pending_control(root, value['token'], 'prepared')
    normal, verification = read_snapshots(root, value['token'], control)
    if read_current_caddyfile(root) != verification:
        raise ValueError('verification startup profile changed')
    identifier = unique_proxy(session_run(), value['instance'])
    session = ActiveConfig(identifier)
    try:
        binding = bind_proxy(session, root, value['instance'], pending)
        normal_config, verification_config = session.adapt(normal), session.adapt(verification)
        if session.read() != verification_config:
            raise ValueError('verification profile is not active')
        mounted = os.stat('/proc/' + str(session.identity['pid']) + '/root/etc/caddy/Caddyfile')
        host = (Path(root) / 'Caddyfile').stat()
        if (mounted.st_dev, mounted.st_ino) != (host.st_dev, host.st_ino):
            raise ValueError('verification startup file is not the bound inode')
        session.recheck()
        control.update(phase='fenced', normal_config_sha256=digest(normal_config),
                       verification_config_sha256=digest(verification_config), proxy=binding)
        write_state(root, state)
    finally:
        session.close()


def verified_session(root, instance, pending, control, normal=False):
    normal_file, verification = read_snapshots(root, pending['token'], control)
    session = ActiveConfig(control['proxy']['id'])
    try:
        normal_config, verification_config = session.adapt(normal_file), session.adapt(verification)
        if digest(normal_config) != control['normal_config_sha256'] or digest(verification_config) != control['verification_config_sha256']:
            raise ValueError('adapted Caddy configuration changed')
        check_bound(session, root, instance, pending, control,
                    normal_file if normal else verification, normal_config if normal else verification_config)
        return session, normal_file, verification, normal_config
    except BaseException:
        session.close()
        raise


def public_response(output):
    response, code = output.rsplit(b'\n', 1)
    headers, body = response.split(b'\r\n\r\n', 1)
    lines = headers.split(b'\r\n')
    markers = [line.split(b':', 1)[1].strip() for line in lines[1:]
               if b':' in line and line.split(b':', 1)[0].lower() == b'x-dollhouse-verification']
    return body, code, markers


def public_probe(base, path, expected, allow_bootstrap, timeout, token):
    # timeout is the retry window; every attempt has its own bounded cleanup reserve.
    deadline = time.monotonic() + timeout
    while True:
        remaining = max(0, deadline - time.monotonic())
        call_budget = min(15, max(1, remaining) + 3)
        command = [CURL, '--disable', '--noproxy', '*', '--proto', '=http,https', '--http1.1',
                   '--header', 'Content-Length: 0', '--silent', '--show-error',
                   '--max-time', str(min(10, call_budget - 3)), '--include', '--write-out', '\n%{http_code}', base + path]
        try:
            output = bounded_input(command, timeout=call_budget)
            body, code, markers = public_response(output)
        except (ValueError, OSError):
            body, code, markers = b'', b'000', []
        if markers == [token.encode('ascii')] and (code == expected or (allow_bootstrap and code == b'503' and b'bootstrap_required' in body)):
            return
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise ValueError('public acceptance probe did not meet its required status')
        time.sleep(min(1, remaining))


def public_origin(base):
    if not isinstance(base, str) or any(char in base for char in '\n\r\x00'):
        raise ValueError('invalid public acceptance origin')
    parts = urlsplit(base)
    if (parts.scheme not in ('http', 'https') or not parts.hostname or parts.username is not None
            or parts.password is not None or parts.path or parts.query or parts.fragment):
        raise ValueError('invalid public acceptance origin')
    port = parts.port
    if port is not None and not 1 <= port <= 65535:
        raise ValueError('invalid public acceptance port')
    return parts.scheme + '://' + parts.hostname.lower() + (':' + str(port) if port is not None else '')


def confirm_denials(base, token):
    base = public_origin(base)
    for method, path, headers in (('POST', '/mcp', []),
                                  ('GET', '/healthz', ['--header', 'Authorization: Bearer verification-probe'])):
        command = [CURL, '--disable', '--noproxy', '*', '--proto', '=http,https', '--http1.1', '--request', method,
                   '--header', 'Content-Length: 0', *headers, '--silent', '--show-error', '--max-time', '10',
                   '--include', '--write-out', '\n%{http_code}', base + path]
        output = bounded_input(command, timeout=15)
        _body, code, markers = public_response(output)
        if code != b'503' or markers != [token.encode('ascii')]:
            raise ValueError('public verification fence refused neither unsafe probe')


def probe_fence(value, root):
    state, pending, control = pending_control(root, value['token'], 'fenced')
    if public_origin(value['public_base_url']) != control['public_origin']:
        raise ValueError('public verification origin changed')
    session, _, _, _ = verified_session(root, value['instance'], pending, control)
    try:
        confirm_denials(value['public_base_url'], value['token'])
        session.recheck()
    finally:
        session.close()
    session, _, _, _ = verified_session(root, value['instance'], pending, control)
    session.close()
    control['phase'] = 'probed'
    write_state(root, state)


def accept(value, root):
    state, pending, control = pending_control(root, value['token'], 'probed')
    base = public_origin(value['public_base_url'])
    if base != control['public_origin']:
        raise ValueError('public acceptance origin changed')
    timeout = value['timeout']
    if type(timeout) is not int or timeout < 0:
        raise ValueError('invalid public acceptance timeout')
    session, _, _, _ = verified_session(root, value['instance'], pending, control)
    try:
        public_probe(base, '/healthz', b'200', False, timeout, value['token'])
        public_probe(base, '/readyz', b'200', value['allow_bootstrap'], timeout, value['token'])
        public_probe(base, '/mcp', b'401', False, timeout, value['token'])
        session.recheck()
    finally:
        session.close()
    session, _, _, _ = verified_session(root, value['instance'], pending, control)
    session.close()
    control['phase'] = 'accepted'
    write_state(root, state)


def release(value, root):
    state, pending, control = pending_control(root, value['token'], 'accepted')
    session, normal, verification, normal_config = verified_session(root, value['instance'], pending, control)
    releasing = False
    try:
        control['phase'] = 'releasing'
        write_state(root, state)
        releasing = True
        write_startup_file(root, verification, normal, session.identity['pid'])
        session.recheck()
        session.load(normal_config)
        check_bound(session, root, value['instance'], pending, control, normal, normal_config)
        control['phase'] = 'released'
        write_state(root, state)
    except BaseException as original:
        if releasing:
            try:
                session.stop_after_release_failure()
                original.add_note('Exact Caddy proxy stopped cleanly; pending release state is retained')
            except Exception as stop_error:
                original.add_note('Caddy stop is UNKNOWN; normal ingress may be active: ' + str(stop_error))
        raise
    finally:
        session.close()


def verify_released(root, instance, pending):
    control = pending.get('control')
    if not isinstance(control, dict) or control['phase'] != 'released':
        raise ValueError('Caddy release is not complete')
    session, _, _, _ = verified_session(root, instance, pending, control, normal=True)
    session.close()


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in ('prepare', 'confirm', 'probe-fence', 'accept', 'release'):
        raise ValueError('one fixed Caddy verification action is required')
    raw = sys.stdin.buffer.read(2 * 1024 * 1024 + 1)
    if len(raw) > 2 * 1024 * 1024:
        raise ValueError('Caddy verification request exceeds its limit')
    value = json.loads(raw, object_pairs_hook=unique_object)
    fields = {'deploy_dir', 'instance', 'data_volume', 'config_volume', 'token', 'renderer',
              'keep_proxy', 'public_base_url', 'timeout', 'allow_bootstrap'}
    if not isinstance(value, dict) or set(value) != fields:
        raise ValueError('invalid Caddy verification request')
    if type(value['keep_proxy']) is not bool or type(value['allow_bootstrap']) is not bool:
        raise ValueError('invalid Caddy verification request flags')
    root = validate_request({key: value[key] for key in ('deploy_dir', 'instance', 'data_volume', 'config_volume')})
    lock = acquire_lock(root, allow_control=True)
    try:
        {'prepare': prepare, 'confirm': confirm, 'probe-fence': probe_fence,
         'accept': accept, 'release': release}[sys.argv[1]](value, root)
    finally:
        os.close(lock)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('Caddy verification/release refused; active ingress state may be UNKNOWN: ' + str(error), file=sys.stderr)
        for note in getattr(error, '__notes__', ()):
            print(note, file=sys.stderr)
        sys.exit(1)
