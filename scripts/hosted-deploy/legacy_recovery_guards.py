"""Recovery-specific identities, ingress ownership and serving-network DNS.

These observations do not change a forward control phase or infer that an
unacknowledged command completed. An isolated canary is not serving ingress.
"""
import ipaddress
import re

from caddy_volume_migration import inspect_one, running_containers
from legacy_recovery_profile import profile

PORT = re.compile(r'[1-9][0-9]{0,4}\Z')


def lifecycle(container, running, boot=None):
    state = container.get('State')
    if (not isinstance(state, dict) or state.get('Running') is not running
            or state.get('Restarting') is not False or state.get('OOMKilled') is not False
            or type(container.get('RestartCount')) is not int or container['RestartCount'] < 0
            or not isinstance(state.get('StartedAt'), str) or not state['StartedAt'] or state['StartedAt'].startswith('0001-')):
        raise ValueError('recovery container lifecycle is UNKNOWN')
    actual = {'started_at': state['StartedAt'], 'restart_count': container['RestartCount']}
    if boot is not None and actual != boot:
        raise ValueError('recovery container boot changed')
    if not running and (state.get('ExitCode') != 0 or type(state.get('ExitCode')) is not int
                        or not state.get('FinishedAt') or state['FinishedAt'].startswith('0001-')):
        raise ValueError('recovery container did not stop cleanly')
    return actual


def exact_container(run, identifier, expected, name, running, boot=None):
    current = inspect_one(run, 'container', identifier)
    if current.get('Id') != identifier or current.get('Name') != '/' + name or profile(current) != expected:
        raise ValueError('full recovery container profile changed')
    lifecycle(current, running, boot)
    return current


def published(bindings):
    if not isinstance(bindings, dict):
        raise ValueError('published-port inventory is unavailable')
    result = set()
    for port, entries in bindings.items():
        if not isinstance(port, str) or not re.fullmatch(r'[1-9][0-9]{0,4}/(tcp|udp)', port):
            raise ValueError('published-port protocol is unavailable')
        if entries is None:
            continue
        if not isinstance(entries, list):
            raise ValueError('published-port records are unavailable')
        for item in entries:
            if (not isinstance(item, dict) or set(item) != {'HostIp', 'HostPort'}
                    or not isinstance(item['HostPort'], str) or not PORT.fullmatch(item['HostPort'])
                    or int(item['HostPort']) > 65535):
                raise ValueError('published-port identity is invalid')
            address = ipaddress.ip_address(item['HostIp'] or '0.0.0.0')
            result.add((str(address), int(item['HostPort']), port.split('/')[1]))
    return result


def overlaps(left, right):
    a, port, protocol = left
    b, other_port, other_protocol = right
    # Conservatively treat an IPv6 wildcard as possibly dual-stack.
    return (port == other_port and protocol == other_protocol
            and (a == b or ipaddress.ip_address(a).is_unspecified or ipaddress.ip_address(b).is_unspecified))


def ingress_available(run, ports, excluded=()):
    targets = {(str(ipaddress.ip_address(item['host_ip'])), int(item['host_port']), 'tcp') for item in ports}
    for item in running_containers(run):
        if item.get('Id') in excluded:
            continue
        host = item.get('HostConfig')
        settings = item.get('NetworkSettings')
        if (not isinstance(host, dict) or host.get('NetworkMode') == 'host' or not isinstance(settings, dict)):
            raise ValueError('another running container has UNKNOWN ingress ownership')
        # Check both configured and actual bindings; never infer absence from a missing inspect field.
        actual = published(settings.get('Ports')) | published(host.get('PortBindings'))
        if any(overlaps(a, b) for a in targets for b in actual):
            raise ValueError('another running container owns recovery ingress')


def serving_dns(run, instance, app_id, app_running=True):
    selected = []
    network_name = instance + '_default'
    for item in running_containers(run):
        settings = item.get('NetworkSettings')
        networks = settings.get('Networks') if isinstance(settings, dict) else None
        if not isinstance(networks, dict):
            raise ValueError('running network inventory is unavailable')
        if network_name not in networks:
            continue
        connection = networks[network_name]
        aliases = connection.get('Aliases') if isinstance(connection, dict) else None
        if aliases is None:
            aliases = []
        if not isinstance(aliases, list) or any(not isinstance(alias, str) for alias in aliases):
            raise ValueError('serving network aliases are unavailable')
        names = {item.get('Name', '').removeprefix('/'), *aliases}
        if names & {instance, 'dollhousemcp'}:
            selected.append(item.get('Id'))
    if selected != ([app_id] if app_running else []):
        raise ValueError('serving-network application DNS is missing or ambiguous')
