"""Read-only admission for a receipt-bound previous Caddy proxy."""
import json
import os
from pathlib import Path
import re

from caddy_bundle_identity import bundle_identity
from caddy_hardened_profile import validate_hardened_profile
from caddy_legacy_profile import default_command, legacy_network
from caddy_prepared_action import PREVIOUS, read_candidate
from caddy_recovery_receipt import private_directory, read_receipt
from caddy_service_guard import unique_proxy
from caddy_volume_migration import inspect_one, verify_original_volumes


def find_previous_receipt(root, previous):
    if previous.parent != root or not PREVIOUS.fullmatch(previous.name):
        raise ValueError('previous source bundle is outside the deployment')
    identity = bundle_identity(previous)
    recovery = root / '.caddy-recovery'
    directory = private_directory(recovery)
    try:
        names = []
        with os.scandir(directory) as entries:
            for entry in entries:
                names.append(entry.name)
                if len(names) > 1000:
                    raise ValueError('recovery inventory exceeds limit')
        matches = []
        for name in sorted(names):
            if not re.fullmatch(r'proxy-[0-9a-f]{32}', name):
                raise ValueError('unsupported recovery directory entry')
            path = recovery / name
            candidate = read_candidate(path)
            if not isinstance(candidate, dict) or not isinstance(candidate.get('bundle'), str):
                raise ValueError('invalid recovery receipt')
            candidate_path = Path(candidate['bundle'])
            if candidate_path.parent != root or not PREVIOUS.fullmatch(candidate_path.name):
                raise ValueError('recovery bundle is outside the deployment')
            record = read_receipt(path, candidate_path, candidate.get('bundle_identity'))
            if candidate_path == previous and record['bundle_identity'] == identity:
                matches.append((path, record))
        if len(matches) != 1:
            raise ValueError('exactly one receipt for the selected previous bundle is required')
        return matches[0]
    finally:
        os.close(directory)


def validate_old_image(image, profile, admit):
    if image.get('Id') != profile['image_id']:
        raise ValueError('previous proxy image identity changed')
    if profile.get('kind') == 'hardened':
        if admit(profile['reference']) != profile['admission']:
            raise ValueError('previous hardened image no longer matches its admission')
        return
    if image.get('Os') + '/' + str(image.get('Architecture')) != profile['platform']:
        raise ValueError('previous proxy image platform changed')
    rootfs = image.get('RootFS')
    if not isinstance(rootfs, dict) or rootfs.get('Type') != 'layers' or rootfs.get('Layers') != profile['diff_ids']:
        raise ValueError('previous proxy image layers changed')
    config = image.get('Config')
    if not isinstance(config, dict) or default_command(config, config) != profile['public_env']:
        raise ValueError('previous proxy image defaults changed')


def validate_replacement(container, image, instance, image_reference, admission, record, caddyfile):
    if not isinstance(container, dict) or container.get('Name') != '/' + instance + '-caddy':
        raise ValueError('replacement proxy is not the selected service')
    if container.get('Image') != admission['store_id']:
        raise ValueError('replacement proxy image differs from admitted image')
    config = container.get('Config')
    if not isinstance(config, dict) or config.get('Image') != image_reference:
        raise ValueError('replacement proxy reference differs from admission')
    labels = config.get('Labels')
    if not isinstance(labels, dict) or labels.get('com.docker.compose.project') != instance or labels.get('com.docker.compose.service') != 'caddy':
        raise ValueError('replacement proxy does not belong to the selected Compose service')
    names = [item['name'] for item in record['clone']['volumes'][2:]]
    host = container.get('HostConfig')
    if not isinstance(host, dict):
        raise ValueError('replacement proxy host settings are unavailable')
    ports, _ = legacy_network(container, host, instance + '_default')
    profile = validate_hardened_profile(container, image, admission, instance, str(caddyfile), names, ports)
    identifier = container.get('Id')
    if not isinstance(identifier, str) or not re.fullmatch(r'[0-9a-f]{64}', identifier):
        raise ValueError('replacement proxy identity is unavailable')
    state = container.get('State')
    if not isinstance(state, dict) or not isinstance(state.get('Running'), bool):
        raise ValueError('replacement proxy state is unavailable')
    return identifier, state['Running'], profile


def preflight(root, instance, previous, image_reference, run, qualify):
    """No source/image/proxy mutation; owned read-only verifier may be created."""
    path, record = find_previous_receipt(root, previous)
    image = inspect_one(run, 'image', record['profile']['image_id'])
    validate_old_image(image, record['profile'], qualify)
    helper = Path(__file__).with_name('caddy_volume_copy.mjs')
    verify_original_volumes(run, record['clone'], helper, os.environ.get('DOCKER_HOST'))
    admission = qualify(image_reference)
    current = inspect_one(run, 'container', unique_proxy(run, instance))
    current_image = inspect_one(run, 'image', image_reference)
    current_id, current_running, current_profile = validate_replacement(current, current_image, instance, image_reference, admission, record, root / 'Caddyfile')
    return {'receipt': path, 'record': record, 'previous': previous, 'current_id': current_id,
            'current_running': current_running, 'current_profile': current_profile,
            'image_reference': image_reference, 'admission': admission, 'caddyfile': root / 'Caddyfile'}
