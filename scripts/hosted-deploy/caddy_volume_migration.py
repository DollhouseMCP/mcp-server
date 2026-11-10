"""Offline named-volume cloning under an already-held deployment lock.

All inputs come from the validated legacy profile and explicit volume selection.
The caller must keep trusted administrators from introducing concurrent writers;
Docker has no atomic volume-writer lease. Failure never deletes either volume.
"""
import json
import re
import secrets
from pathlib import Path

from caddy_volume_guard import exact_capabilities, refuse_writers, require_local_endpoint, validate_volume_pair, volume_identity
from caddy_legacy_profile import validate_legacy_profile
from caddy_image_admission import native_architecture, qualify
from caddy_hardened_profile import validate_hardened_profile
from image_scan_intake import unique_object

HELPER_IMAGE = 'docker.io/library/node@sha256:43b9ba1142b8dcf33fa8f922ca1be85714adc444e0586c7cf7726daaeabc1bea'
NAME = re.compile(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\Z')
ID = re.compile(r'[0-9a-f]{64}\Z')


COPY_SCRIPT_PATH = '/caddy-volume-copy.mjs'
CLONE_TOKEN_LABEL = 'org.dollhousemcp.caddy-clone-token'


def docker_json(run, args, timeout=15, limit=1024 * 1024):
    raw = run(['docker', *args], timeout, limit)
    return json.loads(raw, object_pairs_hook=unique_object)


def inspect_one(run, kind, value):
    values = docker_json(run, [kind, 'inspect', value])
    if not isinstance(values, list) or len(values) != 1 or not isinstance(values[0], dict):
        raise ValueError('Docker inspect must identify exactly one object')
    return values[0]


def running_containers(run):
    raw = run(['docker', 'ps', '--no-trunc', '--quiet'], 15, 1024 * 1024)
    identifiers = raw.decode('ascii').splitlines()
    if len(identifiers) > 1000 or len(set(identifiers)) != len(identifiers):
        raise ValueError('Docker running inventory is too large or ambiguous')
    if any(not ID.fullmatch(value) for value in identifiers):
        raise ValueError('invalid running container identity')
    return [inspect_one(run, 'container', value) for value in identifiers]


def inspect_volumes(run, names):
    return [volume_identity(inspect_one(run, 'volume', name), name) for name in names]


def check_stopped_proxy(run, profile, caddyfile, admit=qualify):
    proxy_id = profile['container_id']
    if not ID.fullmatch(proxy_id):
        raise ValueError('invalid original proxy identity')
    proxy = inspect_one(run, 'container', proxy_id)
    state = proxy.get('State')
    if proxy.get('Id') != proxy_id or not isinstance(state, dict) or state.get('Running') is not False:
        raise ValueError('original proxy is not stopped')
    image = inspect_one(run, 'image', profile['image_id'])
    if profile.get('kind') == 'hardened':
        if not profile['network'].endswith('_default'):
            raise ValueError('unsupported hardened Caddy network')
        admission = admit(profile['reference'])
        actual = validate_hardened_profile(proxy, image, admission, profile['network'][:-len('_default')],
                                           caddyfile, [profile['data_volume'], profile['config_volume']], profile['ports'])
    else:
        actual = validate_legacy_profile(proxy, image, caddyfile, profile['network'])
    if actual != profile:
        raise ValueError('original proxy no longer matches its recovery profile')


def check_local_daemon(run, docker_host):
    context = docker_json(run, ['context', 'inspect'])
    if not isinstance(context, list) or len(context) != 1 or not isinstance(context[0], dict):
        raise ValueError('Docker context is ambiguous')
    endpoint = context[0].get('Endpoints', {}).get('docker', {}).get('Host')
    require_local_endpoint(endpoint, docker_host)


def require_helper_image(run):
    image = inspect_one(run, 'image', HELPER_IMAGE)
    digests = image.get('RepoDigests')
    suffix = HELPER_IMAGE.split('@', 1)[1]
    accepted = {HELPER_IMAGE, 'node@' + suffix, 'library/node@' + suffix}
    if not isinstance(digests, list) or len([value for value in digests if value in accepted]) != 1:
        raise ValueError('the approved Node helper image is not locally available')
    daemon = docker_json(run, ['info', '--format', '{{json .}}'])
    if image.get('Os') != 'linux' or image.get('Architecture') != native_architecture(daemon):
        raise ValueError('the approved Node helper image is not native to this daemon')
    image_id = image.get('Id')
    if not isinstance(image_id, str) or not re.fullmatch(r'sha256:[0-9a-f]{64}', image_id):
        raise ValueError('invalid helper image identity')
    return image_id


def helper_args(names, helper_path, token, mode=None):
    if mode not in (None, '--verify', '--verify-source', '--verify-fresh'):
        raise ValueError('unsupported helper mode')
    if len(names) not in (2, 4) or (len(names) == 2 and mode != '--verify-source'):
        raise ValueError('source-only helper requires exactly two names and source verification')
    source = str(Path(helper_path).resolve(strict=True))
    if ',' in source or '\n' in source:
        raise ValueError('unsupported helper path')
    args = ['docker', 'create', '--pull', 'never', '--name', 'dollhouse-caddy-copy-' + token,
            '--label', 'org.dollhousemcp.caddy-clone-token=' + token, '--network', 'none', '--read-only',
            '--security-opt', 'no-new-privileges:true', '--cap-drop', 'ALL', '--cap-add', 'CHOWN', '--cap-add', 'FOWNER',
            '--cap-add', 'DAC_READ_SEARCH', '--user', '0:0']
    for index, target in enumerate(('/source/data', '/source/config', '/target/data', '/target/config')[:len(names)]):
        mount = 'type=volume,src=' + names[index] + ',dst=' + target + ',volume-nocopy'
        if index < 2 or mode:
            mount += ',readonly'
        args.extend(['--mount', mount])
    args.extend(['--mount', 'type=bind,src=' + source + ',dst=/caddy-volume-copy.mjs,readonly',
                 HELPER_IMAGE, 'node', COPY_SCRIPT_PATH])
    if mode:
        args.append(mode)
    return args


def validate_helper_host(host):
    if host.get('Privileged') is not False or host.get('AutoRemove') is not False:
        raise ValueError('owned helper lifecycle settings changed')
    if not isinstance(host.get('RestartPolicy'), dict) or host['RestartPolicy'].get('Name') != 'no':
        raise ValueError('owned helper restart policy changed')
    if host.get('PidMode') not in ('', None) or host.get('IpcMode') not in ('', 'private', None):
        raise ValueError('owned helper namespace changed')
    if not exact_capabilities(host, {'CHOWN', 'FOWNER', 'DAC_READ_SEARCH'}):
        raise ValueError('owned helper capabilities changed')
    if host.get('SecurityOpt') != ['no-new-privileges:true']:
        raise ValueError('owned helper privilege setting changed')


def validate_helper_runtime(config, host, token, mode):
    if not isinstance(config, dict) or config.get('Labels', {}).get(CLONE_TOKEN_LABEL) != token:
        raise ValueError('owned helper label is missing')
    command = ['node', COPY_SCRIPT_PATH] + ([mode] if mode else [])
    if config.get('Image') != HELPER_IMAGE or config.get('User') != '0:0' or config.get('Cmd') != command:
        raise ValueError('owned helper command changed')
    if not isinstance(host, dict) or host.get('NetworkMode') != 'none' or host.get('ReadonlyRootfs') is not True:
        raise ValueError('owned helper isolation changed')
    validate_helper_host(host)


def validate_helper_mounts(mounts, names, helper_path, mode):
    if len(names) not in (2, 4) or (len(names) == 2 and mode != '--verify-source'):
        raise ValueError('invalid source-only helper mode')
    if not isinstance(mounts, list) or len(mounts) != len(names) + 1:
        raise ValueError('owned helper mounts changed')
    by_target = {item.get('Destination'): item for item in mounts if isinstance(item, dict)}
    for index, target in enumerate(('/source/data', '/source/config', '/target/data', '/target/config')[:len(names)]):
        item = by_target.get(target, {})
        if item.get('Type') != 'volume' or item.get('Name') != names[index] or item.get('RW') is not (index >= 2 and not mode):
            raise ValueError('owned helper volume mounts changed')
    helper = by_target.get(COPY_SCRIPT_PATH, {})
    if helper.get('Type') != 'bind' or helper.get('RW') is not False or helper.get('Source') != str(Path(helper_path).resolve(strict=True)):
        raise ValueError('owned helper script mount changed')


def inspect_helper(run, selector, token, image_id, names, helper_path, mode=None):
    container = inspect_one(run, 'container', selector)
    identifier = container.get('Id')
    config, host, state = container.get('Config'), container.get('HostConfig'), container.get('State')
    if not isinstance(identifier, str) or not ID.fullmatch(identifier):
        raise ValueError('invalid owned helper identity')
    if container.get('Name') != '/dollhouse-caddy-copy-' + token or container.get('Image') != image_id:
        raise ValueError('owned helper name or image changed')
    validate_helper_runtime(config, host, token, mode)
    validate_helper_mounts(container.get('Mounts'), names, helper_path, mode)
    if not isinstance(state, dict) or not isinstance(state.get('Running'), bool):
        raise ValueError('owned helper state is unavailable')
    return container


def cleanup_helper(run, selector, token, image_id, names, helper_path, mode=None):
    container = inspect_helper(run, selector, token, image_id, names, helper_path, mode)
    identifier = container['Id']
    if container['State']['Running']:
        run(['docker', 'stop', '--time', '5', identifier], 10, 65536)
        container = inspect_helper(run, identifier, token, image_id, names, helper_path, mode)
    if container['State']['Running'] is not False:
        raise ValueError('owned helper termination is UNKNOWN')
    run(['docker', 'rm', identifier], 10, 65536)


def run_owned_helper(run, names, helper_path, token, image_id, mode=None):
    selector = 'dollhouse-caddy-copy-' + token
    try:
        raw_id = run(helper_args(names, helper_path, token, mode), 15, 65536).decode('ascii').strip()
        if not ID.fullmatch(raw_id):
            raise ValueError('helper creation did not return an immutable identity')
        container = inspect_helper(run, raw_id, token, image_id, names, helper_path, mode)
        if container['Id'] != raw_id or container['State']['Running']:
            raise ValueError('new helper is not owned and stopped')
        selector = raw_id
        raw = run(['docker', 'start', '--attach', raw_id], 180, 1024 * 1024)
        container = inspect_helper(run, raw_id, token, image_id, names, helper_path, mode)
        if container['State']['Running'] or container['State'].get('ExitCode') != 0:
            raise ValueError('volume-copy helper did not finish successfully')
    except BaseException as original:
        try:
            cleanup_helper(run, selector, token, image_id, names, helper_path, mode)
        except Exception as cleanup:
            original.add_note('Owned helper cleanup is UNKNOWN: ' + str(cleanup))
        raise
    cleanup_helper(run, selector, token, image_id, names, helper_path, mode)
    return raw


def validate_copy_receipt(result):
    fields = {'schema', 'entries', 'bytes', 'root_modes', 'inventory_sha256', 'certificate_sha256'}
    if (not isinstance(result, dict) or set(result) not in (fields, fields | {'legacy_directory_modes'})
            or result['schema'] != 'caddy-volume-clone-v1'):
        raise ValueError('invalid volume-copy receipt')
    for key, limit in (('entries', 100_000), ('bytes', 1024 ** 3)):
        value = result[key]
        if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= limit:
            raise ValueError('invalid volume-copy limits')
    if 'legacy_directory_modes' in result:
        legacy = result['legacy_directory_modes']
        if (not isinstance(legacy, dict) or not legacy or not set(legacy) <= {'data/caddy', 'config/caddy'}
                or any(type(mode) is not int or mode != 0o1777 for mode in legacy.values())):
            raise ValueError('invalid legacy Caddy directory modes')
    certs = result['certificate_sha256']
    modes = result['root_modes']
    if not isinstance(modes, dict) or set(modes) != {'data', 'config'} or any(isinstance(mode, bool) or not isinstance(mode, int) or not 0 <= mode <= 0o7777 or mode & 0o700 != 0o700 or mode & 0o022 for mode in modes.values()):
        raise ValueError('invalid volume root modes')
    if not isinstance(result['inventory_sha256'], str) or not ID.fullmatch(result['inventory_sha256']):
        raise ValueError('invalid volume inventory hash')
    if not isinstance(certs, list) or len(certs) > result['entries'] or not all(isinstance(value, str) and ID.fullmatch(value) for value in certs):
        raise ValueError('invalid certificate hashes')
    if certs != sorted(certs):
        raise ValueError('certificate hashes are not canonical')
    return result


def create_destinations(run, source_names, destination_names, token):
    names = [*source_names, *destination_names]
    if len(names) != 4 or any(not isinstance(name, str) or not NAME.fullmatch(name) for name in names) or len(set(names)) != 4:
        raise ValueError('four distinct named volumes are required')
    if not isinstance(token, str) or not re.fullmatch(r'[0-9a-f]{32}', token):
        raise ValueError('invalid fresh-volume transaction token')
    existing = run(['docker', 'volume', 'ls', '--format', '{{.Name}}'], 15, 1024 * 1024).decode('utf-8').splitlines()
    if any(name in existing for name in destination_names):
        raise ValueError('destination volume already exists')
    for name in destination_names:
        created = run(['docker', 'volume', 'create', '--label',
                       'org.dollhousemcp.caddy-clone-token=' + token, name], 15, 65536).decode('utf-8').strip()
        if created != name:
            raise ValueError('destination creation returned an unexpected name')
        labels = inspect_one(run, 'volume', name).get('Labels')
        if not isinstance(labels, dict) or labels.get(CLONE_TOKEN_LABEL) != token:
            raise ValueError('destination is not owned by this transaction')


def qualify_source_volumes(run, sources, helper_path):
    """Read-only copier admission while the original proxy still serves.

    Live content may change before stop. This is an early refusal, never a
    substitute for the frozen source/copy verification after the clean stop.
    No destination names are passed, mounted or implicitly created.
    """
    names = [volume['name'] for volume in sources]
    if len(names) != 2 or len(set(names)) != 2 or inspect_volumes(run, names) != sources:
        raise ValueError('source volume identity changed before qualification')
    image = require_helper_image(run)
    raw = run_owned_helper(run, names, helper_path, secrets.token_hex(16), image, '--verify-source')
    result = validate_copy_receipt(json.loads(raw, object_pairs_hook=unique_object))
    if inspect_volumes(run, names) != sources:
        raise ValueError('source volume identity changed during qualification')
    return result


def migrate_volumes(run, profile, admitted_sources, destination_names, token, helper_path, caddyfile, docker_host=None, admit=qualify):
    """Clone to pre-created, exclusively owned fresh destinations under the lock."""
    source_names = [profile['data_volume'], profile['config_volume']]
    names = [*source_names, *destination_names]
    if len(names) != 4 or any(not isinstance(name, str) or not NAME.fullmatch(name) for name in names) or len(set(names)) != 4:
        raise ValueError('four distinct named volumes are required')
    if not isinstance(token, str) or not re.fullmatch(r'[0-9a-f]{32}', token):
        raise ValueError('invalid fresh-volume transaction token')
    check_local_daemon(run, docker_host)
    helper_image_id = require_helper_image(run)
    check_stopped_proxy(run, profile, caddyfile, admit)
    before = inspect_volumes(run, names)
    if before[:2] != admitted_sources:
        raise ValueError('original volume identity differs from recovery receipt')
    for name in destination_names:
        labels = inspect_one(run, 'volume', name).get('Labels')
        if not isinstance(labels, dict) or labels.get(CLONE_TOKEN_LABEL) != token:
            raise ValueError('destination is not owned by this fresh-volume transaction')
    validate_volume_pair(before)
    refuse_writers(running_containers(run), before)
    raw = run_owned_helper(run, names, helper_path, token, helper_image_id)
    result = json.loads(raw, object_pairs_hook=unique_object)
    validate_copy_receipt(result)
    check_stopped_proxy(run, profile, caddyfile, admit)
    after = inspect_volumes(run, names)
    if after != before:
        raise ValueError('volume identity changed during migration')
    refuse_writers(running_containers(run), after)
    return {'volumes': before, 'copy': result}


def verify_prepared(run, profile, clone, helper_path, caddyfile, docker_host=None, admit=qualify):
    """Recheck the complete source and copied trees immediately before use."""
    check_local_daemon(run, docker_host)
    helper_image_id = require_helper_image(run)
    check_stopped_proxy(run, profile, caddyfile, admit)
    expected = clone['volumes']
    names = [volume['name'] for volume in expected]
    before = inspect_volumes(run, names)
    if before != expected:
        raise ValueError('prepared volume identity changed')
    validate_volume_pair(before)
    refuse_writers(running_containers(run), before)
    raw = run_owned_helper(run, names, helper_path, secrets.token_hex(16), helper_image_id, mode='--verify')
    observed = validate_copy_receipt(json.loads(raw, object_pairs_hook=unique_object))
    if observed != clone['copy']:
        raise ValueError('prepared volume contents changed')
    check_stopped_proxy(run, profile, caddyfile, admit)
    after = inspect_volumes(run, names)
    if after != before:
        raise ValueError('prepared volume identity changed during verification')
    refuse_writers(running_containers(run), after)


def verify_original_volumes(run, clone, helper_path, docker_host=None):
    """Verify stopped prior volumes while the replacement proxy may be live."""
    check_local_daemon(run, docker_host)
    helper_image_id = require_helper_image(run)
    expected = clone['volumes']
    names = [volume['name'] for volume in expected]
    before = inspect_volumes(run, names)
    if before != expected:
        raise ValueError('recovery volume identity changed')
    validate_volume_pair(before)
    refuse_writers(running_containers(run), before[:2])
    raw = run_owned_helper(run, names, helper_path, secrets.token_hex(16), helper_image_id, mode='--verify-source')
    observed = validate_copy_receipt(json.loads(raw, object_pairs_hook=unique_object))
    if observed != clone['copy']:
        raise ValueError('original Caddy volumes changed after capture')
    if inspect_volumes(run, names) != before:
        raise ValueError('recovery volume identity changed during verification')
    refuse_writers(running_containers(run), before[:2])
