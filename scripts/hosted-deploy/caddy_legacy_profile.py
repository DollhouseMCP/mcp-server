"""Validate the narrow legacy Caddy Compose profile for a protected receipt.

Inputs must be actual singleton Docker inspect objects obtained on the local
trusted daemon. This module never persists or prints arbitrary container env.
"""
import re
import ipaddress

DIGEST = re.compile(r'sha256:[0-9a-f]{64}\Z')
CONTAINER_ID = re.compile(r'[0-9a-f]{64}\Z')
VOLUME = re.compile(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\Z')
PUBLIC_ENV = {'PATH', 'CADDY_VERSION', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME'}
COMMANDS = (
    (('caddy',), ('run', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile')),
    ((), ('caddy', 'run', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile')),
)
MASKED_PATHS = ['/proc/asound', '/proc/acpi', '/proc/kcore', '/proc/keys', '/proc/latency_stats',
                '/proc/timer_list', '/proc/timer_stats', '/proc/sched_debug', '/proc/scsi',
                '/sys/firmware', '/sys/devices/virtual/powercap']
READONLY_PATHS = ['/proc/bus', '/proc/fs', '/proc/irq', '/proc/sys', '/proc/sysrq-trigger']


def public_environment(values):
    if not isinstance(values, list):
        raise ValueError('invalid legacy environment')
    result = {}
    for value in values:
        if not isinstance(value, str) or '=' not in value:
            raise ValueError('invalid legacy environment')
        key, text = value.split('=', 1)
        if key not in PUBLIC_ENV or key in result or not text or any(c in text for c in '\n\r\x00'):
            raise ValueError('unsupported legacy environment')
        result[key] = text
    if 'PATH' not in result or 'CADDY_VERSION' not in result:
        raise ValueError('missing legacy public environment')
    if result.get('XDG_CONFIG_HOME', '/config') != '/config' or result.get('XDG_DATA_HOME', '/data') != '/data':
        raise ValueError('unsupported legacy storage environment')
    return result


def default_command(container, image):
    for field in ('Cmd', 'Entrypoint', 'WorkingDir'):
        if container.get(field) != image.get(field):
            raise ValueError('legacy command differs from image default')
    if (container.get('User') or '') != (image.get('User') or ''):
        raise ValueError('legacy user differs from image default')
    if (container.get('User') or '') not in ('', '0', 'root'):
        raise ValueError('unsupported legacy user')
    command = (tuple(container.get('Entrypoint') or ()), tuple(container.get('Cmd') or ()))
    if command not in COMMANDS:
        raise ValueError('unsupported legacy Caddy command')
    env = public_environment(container.get('Env'))
    if env != public_environment(image.get('Env')):
        raise ValueError('legacy environment differs from image default')
    return env


def legacy_mounts(mounts, caddyfile):
    if not isinstance(mounts, list) or len(mounts) != 3:
        raise ValueError('unsupported legacy mounts')
    by_target = {m.get('Destination'): m for m in mounts if isinstance(m, dict)}
    if set(by_target) != {'/data', '/config', '/etc/caddy/Caddyfile'}:
        raise ValueError('unsupported legacy mount destinations')
    conf = by_target['/etc/caddy/Caddyfile']
    if conf.get('Type') != 'bind' or conf.get('RW') is not False or conf.get('Source') != caddyfile:
        raise ValueError('unsupported legacy Caddyfile mount')
    names = []
    for target in ('/data', '/config'):
        mount = by_target[target]
        name = mount.get('Name')
        if mount.get('Type') != 'volume' or mount.get('RW') is not True or not isinstance(name, str) or not VOLUME.fullmatch(name):
            raise ValueError('unsupported legacy volume')
        names.append(name)
    if names[0] == names[1]:
        raise ValueError('legacy volumes must be distinct')
    return names


def legacy_aliases(container, host, expected_network):
    if not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}', expected_network):
        raise ValueError('invalid expected network')
    networks = container.get('NetworkSettings', {}).get('Networks')
    if host.get('NetworkMode') != expected_network or not isinstance(networks, dict) or set(networks) != {expected_network}:
        raise ValueError('unsupported legacy network')
    network = networks[expected_network]
    if not isinstance(network, dict) or not isinstance(network.get('Aliases'), list):
        raise ValueError('missing legacy network aliases')
    aliases = network['Aliases']
    container_name = container.get('Name', '').removeprefix('/')
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,127}', container_name):
        raise ValueError('invalid legacy container name')
    if len(set(aliases)) != len(aliases) or not set(aliases) <= {'caddy', container_name, container['Id'][:12]}:
        raise ValueError('unsupported legacy network aliases')
    return aliases


def legacy_port(port, entries):
    if not re.fullmatch(r'[1-9][0-9]{0,4}/tcp', port) or int(port[:-4]) > 65535:
        raise ValueError('unsupported legacy port')
    if not isinstance(entries, list) or len(entries) != 1 or not isinstance(entries[0], dict):
        raise ValueError('unsupported legacy port binding')
    entry = entries[0]
    if set(entry) != {'HostIp', 'HostPort'}:
        raise ValueError('unsupported legacy port binding')
    ipaddress.ip_address(entry['HostIp'])
    value = entry['HostPort']
    if not isinstance(value, str) or not re.fullmatch(r'[1-9][0-9]{0,4}', value) or int(value) > 65535:
        raise ValueError('unsupported legacy port binding')
    return {'container_port': port, 'host_ip': entry['HostIp'], 'host_port': value}


def legacy_network(container, host, expected_network):
    aliases = legacy_aliases(container, host, expected_network)
    bindings = host.get('PortBindings')
    if not isinstance(bindings, dict) or len(bindings) not in (1, 2):
        raise ValueError('unsupported legacy ports')
    result = [legacy_port(port, entries) for port, entries in sorted(bindings.items())]
    if len(result) == 2 and set(bindings) != {'80/tcp', '443/tcp'}:
        raise ValueError('unsupported legacy TLS ports')
    return result, aliases


def validate_common_host(host):
    for key in ('Devices', 'DeviceRequests', 'ExtraHosts', 'GroupAdd', 'Links',
                'VolumesFrom', 'Dns', 'DnsOptions', 'DnsSearch'):
        if host.get(key) not in (None, []):
            raise ValueError('unsupported legacy host profile')
    if host.get('PidMode') not in ('', None) or host.get('IpcMode') not in ('private', '', None):
        raise ValueError('unsupported legacy namespace')
    if any(host.get(key) not in ('', None) for key in ('UsernsMode', 'UTSMode')):
        raise ValueError('unsupported legacy namespace')
    if host.get('Runtime') not in ('', None, 'runc') or host.get('Init') not in (None, False):
        raise ValueError('unsupported legacy runtime')
    if host.get('CgroupnsMode') not in ('private', '', None):
        raise ValueError('unsupported legacy cgroup namespace')
    if host.get('MaskedPaths') != MASKED_PATHS or host.get('ReadonlyPaths') != READONLY_PATHS:
        raise ValueError('unsupported legacy proc filesystem restrictions')
    for key in ('Memory', 'MemorySwap', 'MemoryReservation', 'KernelMemory', 'CpuShares',
                'CpuPeriod', 'CpuQuota', 'NanoCpus', 'PidsLimit'):
        if host.get(key) not in (None, 0):
            raise ValueError('unsupported Caddy resource limit')
    if host.get('CpusetCpus') not in (None, '') or host.get('CpusetMems') not in (None, ''):
        raise ValueError('unsupported Caddy CPU affinity')
    if host.get('ShmSize') != 67108864:
        raise ValueError('unsupported Caddy shared-memory size')


def validate_host_profile(host):
    validate_common_host(host)
    for key in ('Privileged', 'ReadonlyRootfs'):
        if host.get(key) is not False:
            raise ValueError('unsupported legacy host profile')
    for key in ('CapAdd', 'CapDrop', 'SecurityOpt'):
        if host.get(key) not in (None, []):
            raise ValueError('unsupported legacy host profile')
    if host.get('Sysctls') not in (None, {}):
        raise ValueError('unsupported legacy runtime')


def legacy_restart_and_logging(host):
    restart = host.get('RestartPolicy')
    if not isinstance(restart, dict) or restart.get('Name') != 'unless-stopped' or restart.get('MaximumRetryCount', 0) != 0:
        raise ValueError('unsupported legacy restart policy')
    logging = host.get('LogConfig')
    if not isinstance(logging, dict) or logging.get('Type') != 'json-file' or not isinstance(logging.get('Config'), dict):
        raise ValueError('unsupported legacy logging')
    options = logging['Config']
    if set(options) != {'max-size', 'max-file'}:
        raise ValueError('unsupported legacy logging options')
    if not re.fullmatch(r'[1-9][0-9]*[kKmMgG]', options.get('max-size', '')) or not re.fullmatch(r'[1-9][0-9]*', options.get('max-file', '')):
        raise ValueError('invalid legacy logging options')
    return dict(options)


def legacy_image_metadata(image):
    rootfs = image.get('RootFS')
    if not isinstance(rootfs, dict) or rootfs.get('Type') != 'layers' or not isinstance(rootfs.get('Layers'), list) or not rootfs['Layers'] or not all(isinstance(x, str) and DIGEST.fullmatch(x) for x in rootfs['Layers']):
        raise ValueError('invalid legacy image layers')
    arch = image.get('Architecture')
    if image.get('Os') != 'linux' or arch not in ('amd64', 'arm64'):
        raise ValueError('unsupported legacy image platform')
    digests = image.get('RepoDigests')
    if digests is None:
        digests = []
    if not isinstance(digests, list) or not all(isinstance(value, str) and re.fullmatch(r'[^\s@]+@sha256:[0-9a-f]{64}', value) for value in digests):
        raise ValueError('invalid legacy registry digests')
    return rootfs['Layers'], 'linux/' + arch, digests


def validate_legacy_profile(container, image, caddyfile, expected_network):
    if not isinstance(container, dict) or not isinstance(image, dict):
        raise ValueError('legacy inspect must be objects')
    container_id, image_id = container.get('Id'), container.get('Image')
    if not isinstance(container_id, str) or not CONTAINER_ID.fullmatch(container_id):
        raise ValueError('invalid legacy container ID')
    if not isinstance(image_id, str) or not DIGEST.fullmatch(image_id) or image.get('Id') != image_id:
        raise ValueError('legacy image identity mismatch')
    conf, image_conf, host = container.get('Config'), image.get('Config'), container.get('HostConfig')
    if not all(isinstance(value, dict) for value in (conf, image_conf, host)):
        raise ValueError('missing legacy configuration')
    if not expected_network.endswith('_default'):
        raise ValueError('unsupported Compose network name')
    instance = expected_network[:-len('_default')]
    labels = conf.get('Labels')
    if (container.get('Name') != '/' + instance + '-caddy' or not isinstance(labels, dict)
            or labels.get('com.docker.compose.project') != instance
            or labels.get('com.docker.compose.service') != 'caddy'):
        raise ValueError('legacy proxy is not the expected Compose service')
    env = default_command(conf, image_conf)
    validate_host_profile(host)
    logging = legacy_restart_and_logging(host)
    names = legacy_mounts(container.get('Mounts'), caddyfile)
    ports, aliases = legacy_network(container, host, expected_network)
    layers, platform, digests = legacy_image_metadata(image)
    return {'container_id': container_id, 'image_id': image_id, 'diff_ids': layers,
            'data_volume': names[0], 'config_volume': names[1], 'public_env': env,
            'network': expected_network, 'aliases': aliases, 'ports': ports,
            'platform': platform, 'repo_digests': digests, 'logging': logging}
