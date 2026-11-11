"""Private selection-only Compose model from verified live legacy identities.

Original Compose files and overlays remain evidence. This concrete model records
their running effect without resolving stale tags or interpolating live secrets.
It is not an alternate legacy recreate/deploy route; v2 rendering replaces it
before the guarded update can run migrations or replace the app.
"""
import re

from legacy_recovery_profile import canonical_mounts


def environment(values):
    if not isinstance(values, list):
        raise ValueError('legacy runtime environment is unavailable')
    result = {}
    for value in values:
        if not isinstance(value, str) or '=' not in value or '\x00' in value:
            raise ValueError('legacy environment record is invalid')
        key, text = value.split('=', 1)
        if not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*', key) or key in result:
            raise ValueError('legacy environment names are invalid or duplicated')
        result[key] = text
    return result


def healthcheck(value):
    if value is None:
        return None
    if not isinstance(value, dict) or not isinstance(value.get('Test'), list):
        raise ValueError('legacy health configuration is unavailable')
    if value['Test'] == ['NONE']:
        return {'disable': True}
    keys = {'Test': 'test', 'Interval': 'interval', 'Timeout': 'timeout', 'StartPeriod': 'start_period',
            'StartInterval': 'start_interval', 'Retries': 'retries'}
    if set(value) - set(keys):
        raise ValueError('unknown legacy health configuration field')
    result = {'test': value['Test']}
    for key, item in value.items():
        if key == 'Test':
            continue
        if type(item) is not int or item < 0:
            raise ValueError('legacy health duration/count is invalid')
        result[keys[key]] = item if key == 'Retries' else str(item) + 'ns'
    return result


def mounts(container, volumes):
    result = []
    for item in canonical_mounts(container['Mounts']):
        if type(item.get('RW')) is not bool:
            raise ValueError('legacy mount access is unavailable')
        entry = {'type': item['Type'], 'target': item['Destination'], 'read_only': not item['RW']}
        if item['Type'] == 'bind':
            source = item.get('Source')
            if not isinstance(source, str) or not source.startswith('/'):
                raise ValueError('legacy bind source is unavailable')
            entry.update(source=source, bind={'create_host_path': False})
        elif item['Type'] == 'volume':
            name = item.get('Name')
            if not isinstance(name, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,127}', name):
                raise ValueError('legacy volume identity is unavailable')
            volumes[name] = {'external': True, 'name': name}
            entry['source'] = name
        else:
            raise ValueError('unsupported legacy control mount type')
        result.append(entry)
    return result


def ports(bindings):
    if bindings is None:
        return []
    if not isinstance(bindings, dict):
        raise ValueError('legacy port bindings are unavailable')
    result = []
    for key, entries in bindings.items():
        if not re.fullmatch(r'[1-9]\d{0,4}/tcp', key, flags=re.ASCII) or not isinstance(entries, list):
            raise ValueError('unsupported legacy control port')
        for item in entries:
            if not isinstance(item, dict) or set(item) != {'HostIp', 'HostPort'}:
                raise ValueError('legacy control port record is unavailable')
            result.append({'target': int(key[:-4]), 'published': item['HostPort'],
                           'host_ip': item['HostIp'], 'protocol': 'tcp'})
    return result


def service(container, network, volumes):
    config, host = container['Config'], container['HostConfig']
    connection = container.get('NetworkSettings', {}).get('Networks', {})
    if host.get('NetworkMode') != network or set(connection) != {network}:
        raise ValueError('legacy control requires its one existing serving network')
    aliases = connection[network].get('Aliases') or []
    if not isinstance(aliases, list) or any(not isinstance(item, str) for item in aliases):
        raise ValueError('legacy control aliases are unavailable')
    restart = host.get('RestartPolicy') or {}
    if restart.get('Name') not in ('no', 'always', 'unless-stopped'):
        raise ValueError('unsupported legacy control restart policy')
    result = {'container_name': container['Name'].removeprefix('/'), 'image': container['Image'],
              'environment': environment(config.get('Env')), 'restart': restart['Name'],
              'volumes': mounts(container, volumes), 'networks': {'serving': {'aliases': [
                  item for item in aliases if item != container['Id'][:12]]}}}
    for old, new in (('Cmd', 'command'), ('Entrypoint', 'entrypoint'), ('User', 'user'), ('WorkingDir', 'working_dir'),
                     ('StopSignal', 'stop_signal')):
        if config.get(old) is not None and config[old] != '':
            result[new] = config[old]
    for old, new in (('ReadonlyRootfs', 'read_only'), ('Privileged', 'privileged'), ('Init', 'init'),
                     ('CapAdd', 'cap_add'), ('CapDrop', 'cap_drop'), ('SecurityOpt', 'security_opt'), ('Sysctls', 'sysctls')):
        if host.get(old) is not None:
            result[new] = host[old]
    check = healthcheck(config.get('Healthcheck'))
    if check is not None:
        result['healthcheck'] = check
    logging = host.get('LogConfig')
    if not isinstance(logging, dict) or logging.get('Type') not in ('json-file', 'local'):
        raise ValueError('legacy logging configuration is unavailable')
    result['logging'] = {'driver': logging['Type'], 'options': logging.get('Config') or {}}
    published = ports(host.get('PortBindings'))
    if published:
        result['ports'] = published
    return result


def literal(value):
    if isinstance(value, str):
        return value.replace('$', '$$')
    if isinstance(value, list):
        return [literal(item) for item in value]
    if isinstance(value, dict):
        return {key: literal(item) for key, item in value.items()}
    return value


def model(instance, app, postgres, proxy):
    volumes = {}
    network = instance + '_default'
    services = {name: service(item, network, volumes) for name, item in
                (('dollhousemcp', app), ('postgres', postgres), ('caddy', proxy))}
    return literal({'name': instance, 'services': services, 'volumes': volumes,
                    'networks': {'serving': {'external': True, 'name': network}}})
