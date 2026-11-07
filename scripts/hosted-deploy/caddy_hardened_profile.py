"""Exact supported source-built hosted Caddy predecessor profile."""
import re
from caddy_legacy_profile import legacy_mounts, legacy_network, legacy_restart_and_logging, validate_common_host


def validate_tmpfs(host):
    tmpfs = host.get('Tmpfs')
    if not isinstance(tmpfs, dict) or set(tmpfs) != {'/tmp'} or not isinstance(tmpfs['/tmp'], str):
        raise ValueError('invalid Caddy temporary filesystem')
    options = tmpfs['/tmp'].split(',')
    if len(set(options)) != len(options):
        raise ValueError('duplicate Caddy tmpfs option')
    allowed = {'noexec', 'nosuid', 'nodev', 'mode=1777'}
    if set(options) - {'size=64M', 'size=67108864'} != allowed or len(options) != 5:
        raise ValueError('invalid Caddy tmpfs options')


def validate_isolation(config, host):
    validate_common_host(host)
    if config.get('User') != '1001:1001' or host.get('ReadonlyRootfs') is not True or host.get('Privileged') is not False:
        raise ValueError('Caddy user or root filesystem is not qualified')
    if set(host.get('CapDrop') or []) != {'ALL'} or set(host.get('CapAdd') or []) != {'NET_BIND_SERVICE'}:
        raise ValueError('Caddy capabilities are not qualified')
    if host.get('SecurityOpt') != ['no-new-privileges:true']:
        raise ValueError('Caddy privilege setting is not qualified')
    if host.get('Sysctls') != {'net.ipv4.ip_unprivileged_port_start': '1024'}:
        raise ValueError('Caddy port threshold is not qualified')
    validate_tmpfs(host)


def validate_hardened_profile(container, image, admission, instance, caddyfile, volumes, ports):
    if not isinstance(container, dict) or not isinstance(image, dict) or not isinstance(admission, dict):
        raise ValueError('Caddy observations are incomplete')
    if container.get('Name') != '/' + instance + '-caddy' or container.get('Image') != admission.get('store_id'):
        raise ValueError('Caddy service identity differs from admission')
    config, host, image_config = container.get('Config'), container.get('HostConfig'), image.get('Config')
    if not all(isinstance(item, dict) for item in (config, host, image_config)):
        raise ValueError('Caddy configuration is incomplete')
    labels = config.get('Labels')
    if not isinstance(labels, dict) or labels.get('com.docker.compose.project') != instance or labels.get('com.docker.compose.service') != 'caddy':
        raise ValueError('Caddy is not the selected Compose service')
    if config.get('Image') != admission.get('reference') or image.get('Id') != admission.get('store_id'):
        raise ValueError('Caddy image differs from the admitted reference')
    for key in ('Cmd', 'Entrypoint', 'Env', 'WorkingDir'):
        if config.get(key) != image_config.get(key):
            raise ValueError('Caddy runtime overrides image defaults')
    validate_isolation(config, host)
    logging = legacy_restart_and_logging(host)
    if legacy_mounts(container.get('Mounts'), caddyfile) != volumes:
        raise ValueError('Caddy volume mounts differ from the selected volumes')
    actual_ports, aliases = legacy_network(container, host, instance + '_default')
    if actual_ports != ports:
        raise ValueError('Caddy port bindings differ from the requested configuration')
    identifier = container.get('Id')
    if not isinstance(identifier, str) or not re.fullmatch(r'[0-9a-f]{64}', identifier):
        raise ValueError('Caddy container identity is invalid')
    return {'kind': 'hardened', 'container_id': identifier, 'image_id': admission['store_id'],
            'reference': admission['reference'], 'data_volume': volumes[0], 'config_volume': volumes[1],
            'network': instance + '_default', 'ports': actual_ports, 'aliases': aliases,
            'logging': logging, 'admission': admission}
