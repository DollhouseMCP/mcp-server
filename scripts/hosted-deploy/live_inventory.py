#!/usr/bin/env python3
"""Read-only inventory of a hosted deployment host, printed as one JSON document.

The inventory records what a replica must reproduce: tool versions, containers,
images, volumes, networks, file modes, deployment markers and listeners. It is
the source for rehearsal fixtures, so it describes the host as it is and never
as the tooling expects it to be.

Read-only contract, enforced by tests/scripts/test_hosted_live_inventory.py:
- Docker is observed only through allowlisted HTTP GET requests on the local
  Engine socket. No container command is executed and no log is read.
- The only child processes are the local version commands in TOOL_VERSIONS.
- Files are opened read-only without following a final symlink and, where the
  kernel permits it (always for root), without updating access times. Nothing
  is created, changed, locked or removed, and no TCP or UDP connection is made.
- Environment values and file contents are never emitted. Deployment marker
  JSON is reduced to its structure plus recognisably public values. Hexadecimal
  strings are treated as identifiers.

Run from a controller:
    ssh HOST python3 -I - < live_inventory.py > inventory.json
A failed section is recorded under "errors", one unreadable object under
"partial", and the remaining work still runs. Exit status is 0 when complete
and 3 when anything could not be read.
"""
import argparse
import datetime
import hashlib
import http.client
import ipaddress
import json
import os
import platform
import re
import shutil
import socket
import stat
import subprocess
import sys
import time

SCHEMA = 'dollhouse-hosted-live-inventory/1'
DEPLOY_DIR = '/opt/dollhousemcp'
SOCKET = '/var/run/docker.sock'
TIMEOUT = 20
MAX_RESPONSE = 16 * 1024 * 1024
MAX_HASH_BYTES = 16 * 1024 * 1024
MAX_JSON_BYTES = 512 * 1024
MAX_ENTRIES = 2000
MAX_DEPTH = 8
MAX_ITEMS = 500
NOATIME = getattr(os, 'O_NOATIME', 0)
# Marks one object that could not be read. collect() lists every such place under "partial".
FAILED = 'inventory_error'

# Local version queries only. Neither command contacts the daemon.
TOOL_VERSIONS = {
    'docker': ('/usr/bin/docker', '--version'),
    'compose': ('/usr/bin/docker', 'compose', 'version', '--short'),
}
TOOLS = ('caddy', 'curl', 'docker', 'flock', 'jq', 'node', 'python3', 'sha256sum', 'tar')
COMPOSE_FILE_LABELS = ('com.docker.compose.project.config_files', 'com.docker.compose.project.environment_file')
COMPOSE_PLUGINS = ('/usr/libexec/docker/cli-plugins/docker-compose', '/usr/local/lib/docker/cli-plugins/docker-compose',
                   '/usr/lib/docker/cli-plugins/docker-compose', '/root/.docker/cli-plugins/docker-compose')

IDENTIFIER = r'[0-9a-f]{64}'
ENGINE_PATHS = re.compile(
    r'/(version|info|volumes|networks|images/json|containers/json\?all=true'
    r'|containers/%s/json|images/sha256:%s/json|networks/%s)\Z' % (IDENTIFIER, IDENTIFIER, IDENTIFIER), flags=re.ASCII)

SENSITIVE = re.compile(r'pass|secret|credential|authori[sz]ation|cookie|private|bearer|token|dsn|database_url'
                       r'|(api|access|signing|encryption)[_-]?key', flags=re.IGNORECASE)
# Operation tokens name receipt directories and are identifiers, so marker keys named "token" stay visible.
SENSITIVE_KEY = re.compile(r'pass|secret|credential|authori[sz]ation|cookie|private|bearer|dsn|database_url'
                           r'|(^|[_-])key($|[_-])', flags=re.IGNORECASE)
USERINFO = re.compile(r'://[^/\s@]+@')
# Short options that commonly carry a credential, as in curl -u, mysql -p and redis-cli -a.
CREDENTIAL_FLAG = re.compile(r'(?:^|\s)(?:-[upaP]|--user)')
PUBLIC_VALUES = tuple(re.compile(pattern, flags=re.ASCII) for pattern in (
    r'[0-9a-f]{8,64}',
    r'sha256:[0-9a-f]{64}',
    r'\d{4}-\d{2}-\d{2}T[0-9:.]+(Z|[+-]\d{2}:\d{2})',
    r'/[A-Za-z0-9._/@:+-]{0,400}',
    r'[a-z0-9][a-z0-9._-]{0,62}',
    r'[A-Z][A-Z0-9_-]{0,31}',
    r'[a-z0-9][a-z0-9._/-]{0,200}(:[A-Za-z0-9._-]{1,128})?(@sha256:[0-9a-f]{64})?',
    r'https://[a-z0-9.-]{1,253}(:\d{1,5})?(/[A-Za-z0-9._/-]{0,200})?',
    r'\d{1,5}/(tcp|udp)',
))
PUBLIC_ENV = re.compile(r'(CADDY_VERSION|GOSU_VERSION|LANG|NODE_ENV|NODE_VERSION|PATH|PGDATA|PG_MAJOR|PG_SHA256'
                        r'|PG_VERSION|TZ|XDG_CONFIG_HOME|XDG_DATA_HOME|YARN_VERSION)\Z')
PUBLIC_ENV_VALUE = re.compile(r'[A-Za-z0-9._/:+-]{0,400}\Z', flags=re.ASCII)
PUBLIC_LABELS = ('com.docker.compose.', 'org.opencontainers.image.')
KEY_NAME = re.compile(r'[A-Za-z0-9_.:/@ -]{1,200}\Z', flags=re.ASCII)
TOOL_OUTPUT = re.compile(r'[A-Za-z0-9 ._,:+()/-]{1,200}\Z', flags=re.ASCII)
ENV_FILE = re.compile(r'\.env(\..+)?\Z')
ENV_LINE = re.compile(r'\s*(?:export\s+)?([A-Za-z_]\w*)\s*=(.*)\Z', flags=re.ASCII)
MARKER = re.compile(r'\.(caddy|legacy)-')
BUNDLE = re.compile(r'server([.-].*)?\Z')
DEPLOY_PROCESS = re.compile(rb'hosted-(?:remote-)?deploy\.sh|hosted-maintenance[a-z-]*\.sh|(?:caddy|legacy)_[a-z_]+\.py')
REVISION_FILES = ('DEPLOYED_AT', 'DEPLOYED_REVISION')


def redacted(value):
    record = {'redacted': type(value).__name__}
    if isinstance(value, (str, bytes, list, dict)):
        record['length'] = len(value)
    return record


def key_name(name):
    return name if KEY_NAME.fullmatch(name) else '<key:%d>' % len(name)


def capped(items, limit=None):
    """The first items, and a failure record whenever any were left out, so no limit is silent."""
    items = list(items) if isinstance(items, (list, tuple)) else []
    limit = MAX_ITEMS if limit is None else limit
    omitted = len(items) - limit
    return items[:limit], [{FAILED: '%d entries beyond the limit were omitted' % omitted}] * (omitted > 0)


def noted(result, note):
    for record in note:
        result.update(record)
    return result


def public_text(value):
    """Return a string only when it is recognisably an identifier, path, time or name."""
    if isinstance(value, str) and any(pattern.fullmatch(value) for pattern in PUBLIC_VALUES):
        return value
    return redacted(value)


def public_json(value, key='', depth=12):
    if value is None:
        return None
    if SENSITIVE_KEY.search(key) or depth <= 0:
        return redacted(value)
    if isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, dict):
        kept, note = capped(list(value.items()))
        return noted({key_name(name): public_json(item, name, depth - 1) for name, item in kept}, note)
    if isinstance(value, list):
        kept, note = capped(value)
        return [public_json(item, key, depth - 1) for item in kept] + note
    if isinstance(value, str) and '=' in value:
        return public_assignment(value)
    return public_text(value)


def public_assignment(value):
    name, _, content = value.partition('=')
    if PUBLIC_ENV.fullmatch(name) and PUBLIC_ENV_VALUE.fullmatch(content):
        return value
    return redacted(value)


def public_argv(values):
    """Keep command words; drop anything that names or carries a credential."""
    if not isinstance(values, list):
        return None if values is None else redacted(values)
    kept, note = capped(values, 64)
    result = []
    follows_sensitive_flag = False
    for value in kept:
        sensitive = not isinstance(value, str) or carries_credential(value)
        result.append(redacted(value) if sensitive or follows_sensitive_flag else value)
        follows_sensitive_flag = bool(sensitive and isinstance(value, str)
                                      and value.startswith('-') and '=' not in value)
    return result + note


def carries_credential(value):
    return bool(len(value) > 400 or SENSITIVE.search(value) or USERINFO.search(value)
                or CREDENTIAL_FLAG.search(value))


def environment(values):
    """Names only, plus the values of a short list of version and path variables."""
    names = []
    public = {}
    for value in values if isinstance(values, list) else []:
        if not isinstance(value, str):
            continue
        name, _, content = value.partition('=')
        names.append(key_name(name))
        if PUBLIC_ENV.fullmatch(name) and PUBLIC_ENV_VALUE.fullmatch(content):
            public[name] = content
    return {'names': sorted(names), 'public': public}


def labels(values):
    result = {}
    for name, value in sorted(values.items()) if isinstance(values, dict) else []:
        name = key_name(name)
        # Compose and OCI image labels are generated metadata: project, service, paths and revisions.
        public = name.startswith(PUBLIC_LABELS) and isinstance(value, str) and len(value) <= 2000 \
            and not USERINFO.search(value)
        result[name] = value if public else redacted(value)
    return result


def selected(value, keys):
    value = value if isinstance(value, dict) else {}
    return {key: value.get(key) for key in keys}


def utc(seconds):
    return datetime.datetime.fromtimestamp(seconds, datetime.timezone.utc).isoformat()


def open_read(path, extra=0, dir_fd=None):
    """The single file entry point: read-only, final symlinks refused, FIFOs never block."""
    flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC | extra
    try:
        return os.open(path, flags | NOATIME, dir_fd=dir_fd)
    except PermissionError:
        if not NOATIME:
            raise
        return os.open(path, flags, dir_fd=dir_fd)


def read_file(path, limit, dir_fd=None):
    descriptor = open_read(path, dir_fd=dir_fd)
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode):
            raise ValueError('not a regular file')
        chunks = []
        remaining = limit + 1
        while remaining > 0:
            chunk = os.read(descriptor, min(65536, remaining))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        data = b''.join(chunks)
        if len(data) > limit:
            raise ValueError('file exceeds the read limit')
        return data
    finally:
        os.close(descriptor)


def file_type(mode):
    for name, test in (('file', stat.S_ISREG), ('dir', stat.S_ISDIR), ('symlink', stat.S_ISLNK),
                       ('socket', stat.S_ISSOCK), ('fifo', stat.S_ISFIFO)):
        if test(mode):
            return name
    return 'device'


def entry(path, dir_fd=None):
    """Metadata of one path. A symlink reports its target and is never followed."""
    info = os.lstat(path, dir_fd=dir_fd)
    record = {'type': file_type(info.st_mode), 'mode': format(stat.S_IMODE(info.st_mode), '04o'),
              'uid': info.st_uid, 'gid': info.st_gid, 'size': info.st_size, 'links': info.st_nlink,
              'modified_utc': utc(info.st_mtime)}
    if stat.S_ISLNK(info.st_mode):
        record['target'] = os.readlink(path, dir_fd=dir_fd)
    return info, record


def digest(path, info, dir_fd=None):
    """Return (record, bytes) for a regular file small enough to hash."""
    if info.st_size > MAX_HASH_BYTES:
        return {'sha256': None, 'skipped': 'size'}, None
    data = read_file(path, MAX_HASH_BYTES, dir_fd)
    return {'sha256': hashlib.sha256(data).hexdigest()}, data


def env_file(data):
    names = []
    empty = []
    for line in data.decode('utf-8', 'replace').splitlines():
        match = ENV_LINE.match(line)
        if match:
            names.append(match.group(1))
            if match.group(2).strip() in ('', '""', "''"):
                empty.append(match.group(1))
    return {'names': sorted(set(names)), 'empty': sorted(set(empty)), 'assignments': len(names)}


def config_detail(name, info, dir_fd=None):
    """Hash a deployment file. Environment files add names; a Caddyfile adds its length."""
    record, data = digest(name, info, dir_fd)
    base = os.path.basename(name)
    if data is not None and ENV_FILE.fullmatch(base):
        record['env'] = env_file(data)
    elif data is not None and base == 'Caddyfile':
        record['lines'] = data.count(b'\n')
    elif data is not None and base in REVISION_FILES:
        record['text'] = public_text(data.decode('ascii', 'replace').strip())
    return record


def marker_detail(name, info, dir_fd=None):
    """Hash a marker file and keep the structure of marker JSON without private values."""
    record, data = digest(name, info, dir_fd)
    if data is not None and name.endswith('.json') and len(data) <= MAX_JSON_BYTES:
        try:
            record['json'] = public_json(json.loads(data))
        except ValueError:
            record['json'] = {FAILED: 'invalid JSON'}
    elif data is not None and os.path.basename(name) == 'Caddyfile':
        record['lines'] = data.count(b'\n')
    return record


def described(name, dir_fd, detail):
    info, record = entry(name, dir_fd)
    if detail and stat.S_ISREG(info.st_mode):
        try:
            record.update(detail(name, info, dir_fd))
        except (OSError, ValueError) as error:
            record[FAILED] = failure(error)
    return info, record


def listing(directory, detail=None):
    """Sorted metadata of the direct children of an open directory."""
    rows = []
    names, note = capped(sorted(os.listdir(directory)))
    for name in names:
        try:
            _, record = described(name, directory, detail)
        except OSError as error:
            record = {FAILED: failure(error)}
        record['name'] = name
        rows.append(record)
    return noted({'entries': rows, 'truncated': bool(note)}, note)


def walk(directory, prefix, depth, rows, detail):
    """Append metadata rows below one open directory. False means the entry limit cut it short."""
    for name in sorted(os.listdir(directory)):
        if len(rows) >= MAX_ENTRIES:
            return False
        try:
            info, record = described(name, directory, detail)
        except OSError as error:
            rows.append({'path': prefix + name, FAILED: failure(error)})
            continue
        record['path'] = prefix + name
        rows.append(record)
        if stat.S_ISDIR(info.st_mode) and not descend(name, directory, record, (prefix, depth, rows, detail)):
            return False
    return True


def descend(name, directory, record, context):
    prefix, depth, rows, detail = context
    if depth <= 0:
        record[FAILED] = 'depth limit reached; contents were not listed'
        return True
    try:
        child = open_read(name, os.O_DIRECTORY, directory)
    except OSError as error:
        record[FAILED] = failure(error)
        return True
    try:
        return walk(child, prefix + name + '/', depth - 1, rows, detail)
    finally:
        os.close(child)


def tree(path, detail=None, dir_fd=None):
    """Bounded recursive metadata below a directory, with relative paths."""
    rows = []
    directory = open_read(path, os.O_DIRECTORY, dir_fd)
    try:
        complete = walk(directory, '', MAX_DEPTH, rows, detail)
    finally:
        os.close(directory)
    result = {'entries': rows, 'truncated': not complete}
    if not complete:
        result[FAILED] = 'entry limit reached; later entries were omitted'
    return result


def failure(error):
    text = '%s: %s' % (type(error).__name__, error)
    return text[:300] if not SENSITIVE.search(text) and not USERINFO.search(text) else type(error).__name__


class EngineConnection(http.client.HTTPConnection):
    def __init__(self, path):
        super().__init__('localhost', timeout=TIMEOUT)
        self.socket_path = path

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(TIMEOUT)
        self.sock.connect(self.socket_path)


def engine(socket_path):
    def get(path):
        """The single Docker entry point: one bounded, allowlisted GET."""
        if not ENGINE_PATHS.fullmatch(path):
            raise ValueError('Docker request is outside the read-only allowlist')
        connection = EngineConnection(socket_path)
        try:
            connection.request('GET', path)
            response = connection.getresponse()
            raw = response.read(MAX_RESPONSE + 1)
            if response.status != 200:
                raise ValueError('Docker GET %s returned HTTP %d' % (path, response.status))
            if len(raw) > MAX_RESPONSE:
                raise ValueError('Docker GET %s exceeds the response limit' % path)
            return json.loads(raw)
        finally:
            connection.close()
    return get


def inspected(get, listed, path, public, name):
    """Inspect every listed object. One that fails or disappears is recorded and skipped."""
    listed, result = capped(listed)
    for item in listed:
        identifier = item.get('Id') if isinstance(item, dict) else None
        try:
            result.append(public(get(path % identifier)))
        except (OSError, ValueError, KeyError, TypeError, AttributeError) as error:
            result.append({'id': identifier, FAILED: failure(error)})
    return sorted(result, key=lambda record: str(record.get(name) or record.get('id')))


def public_container(item):
    config = item.get('Config') or {}
    host = item.get('HostConfig') or {}
    state = item.get('State') or {}
    network = item.get('NetworkSettings') or {}
    health = config.get('Healthcheck')
    record = {
        'id': item.get('Id'), 'name': item.get('Name'), 'created': item.get('Created'),
        'image_id': item.get('Image'), 'image_reference': config.get('Image'),
        'platform': item.get('Platform'), 'driver': item.get('Driver'),
        'restart_count': item.get('RestartCount'),
        'path': public_argv([item.get('Path')])[0], 'args': public_argv(item.get('Args')),
        'state': selected(state, ('Status', 'Running', 'Paused', 'Restarting', 'OOMKilled', 'Dead', 'Pid',
                                  'ExitCode', 'StartedAt', 'FinishedAt')),
        'health': (state.get('Health') or {}).get('Status'),
        'config': {
            'user': config.get('User'), 'working_dir': config.get('WorkingDir'),
            'entrypoint': public_argv(config.get('Entrypoint')), 'cmd': public_argv(config.get('Cmd')),
            'env': environment(config.get('Env')), 'labels': labels(config.get('Labels')),
            'exposed_ports': sorted(config.get('ExposedPorts') or {}),
            'volumes': sorted(config.get('Volumes') or {}), 'stop_signal': config.get('StopSignal'),
            'healthcheck': None if not isinstance(health, dict) else {
                'test': public_argv(health.get('Test')),
                **selected(health, ('Interval', 'Timeout', 'Retries', 'StartPeriod', 'StartInterval'))},
        },
        'host_config': {
            **selected(host, ('NetworkMode', 'RestartPolicy', 'PortBindings', 'Binds', 'CapAdd', 'CapDrop',
                              'SecurityOpt', 'ReadonlyRootfs', 'Privileged', 'Tmpfs', 'PidMode', 'IpcMode',
                              'UsernsMode', 'CgroupnsMode', 'Memory', 'NanoCpus', 'PidsLimit', 'Init',
                              'AutoRemove', 'MaskedPaths', 'ReadonlyPaths', 'Ulimits', 'ExtraHosts', 'Dns',
                              'GroupAdd', 'VolumesFrom', 'Runtime')),
            'log_driver': (host.get('LogConfig') or {}).get('Type'),
        },
        'mounts': [selected(mount, ('Type', 'Name', 'Source', 'Destination', 'Driver', 'Mode', 'RW', 'Propagation'))
                   for mount in item.get('Mounts') or []],
        'networks': {name: selected(value, ('NetworkID', 'IPAddress', 'IPPrefixLen', 'Gateway', 'GlobalIPv6Address',
                                            'Aliases', 'DNSNames'))
                     for name, value in sorted((network.get('Networks') or {}).items())},
        'ports': network.get('Ports'),
    }
    if state.get('Error'):
        record['state']['Error'] = public_text(state['Error'])
    return record


def public_image(item):
    config = item.get('Config') or {}
    return {
        'id': item.get('Id'), 'repo_tags': item.get('RepoTags'), 'repo_digests': item.get('RepoDigests'),
        'created': item.get('Created'), 'architecture': item.get('Architecture'), 'os': item.get('Os'),
        'variant': item.get('Variant'), 'size': item.get('Size'),
        'config': {
            'user': config.get('User'), 'working_dir': config.get('WorkingDir'),
            'entrypoint': public_argv(config.get('Entrypoint')), 'cmd': public_argv(config.get('Cmd')),
            'env': environment(config.get('Env')), 'labels': labels(config.get('Labels')),
            'exposed_ports': sorted(config.get('ExposedPorts') or {}),
            'volumes': sorted(config.get('Volumes') or {}), 'stop_signal': config.get('StopSignal'),
        },
        'rootfs': selected(item.get('RootFS'), ('Type', 'Layers')),
    }


def public_network(item):
    return {
        'id': item.get('Id'), 'name': item.get('Name'), 'created': item.get('Created'),
        **selected(item, ('Driver', 'Scope', 'Internal', 'Attachable', 'Ingress', 'EnableIPv4', 'EnableIPv6')),
        'ipam': {'driver': (item.get('IPAM') or {}).get('Driver'),
                 'config': [selected(value, ('Subnet', 'Gateway', 'IPRange'))
                            for value in (item.get('IPAM') or {}).get('Config') or []]},
        'options': public_json(item.get('Options') or {}), 'labels': labels(item.get('Labels')),
        'containers': {identifier: selected(value, ('Name', 'IPv4Address', 'IPv6Address'))
                       for identifier, value in sorted((item.get('Containers') or {}).items())},
    }


def postgres_version(mountpoint):
    try:
        return public_text(read_file(os.path.join(mountpoint, 'PG_VERSION'), 16).decode('ascii', 'replace').strip())
    except (OSError, ValueError):
        return None


def directory_facts(path, walk):
    """Root metadata of a data directory. Only Caddy storage is walked, and never read."""
    record = {}
    try:
        _, record['root'] = entry(path)
        record['postgres_version'] = postgres_version(path)
        if walk:
            record['tree'] = tree(path)
    except (OSError, ValueError) as error:
        record[FAILED] = failure(error)
    return record


def caddy_storage(containers):
    """Volumes that a Caddy container mounts, whatever they are named."""
    return {mount.get('Name') for container in containers
            if 'CADDY_VERSION' in ((container.get('config') or {}).get('env') or {}).get('names', ())
            for mount in container.get('mounts') or [] if mount.get('Type') == 'volume'}


def volumes(get, storage=()):
    listed, result = capped(get('/volumes').get('Volumes'))
    for item in listed:
        record = selected(item, ('Name', 'Driver', 'Scope', 'Mountpoint', 'CreatedAt'))
        record['labels'] = labels(item.get('Labels'))
        record['options'] = public_json(item.get('Options') or {})
        mountpoint = item.get('Mountpoint')
        if isinstance(mountpoint, str) and os.path.isabs(mountpoint):
            # Mounted Caddy storage, plus retained copies that no container mounts any more.
            record.update(directory_facts(mountpoint, item.get('Name') in storage or 'caddy' in str(item.get('Name'))))
        result.append(record)
    return sorted(result, key=lambda record: str(record.get('Name')))


def referenced_paths(container):
    """Bind sources and Compose files that one container names."""
    paths = {mount['Source'] for mount in container.get('mounts') or []
             if mount.get('Type') == 'bind' and isinstance(mount.get('Source'), str)}
    compose = (container.get('config') or {}).get('labels') or {}
    for key in COMPOSE_FILE_LABELS:
        if isinstance(compose.get(key), str):
            paths.update(part for part in compose[key].split(',') if os.path.isabs(part))
    return paths


def referenced_files(containers):
    """Identity of every bind source and Compose file that a container names."""
    paths = set()
    for container in containers:
        paths.update(referenced_paths(container))
    kept, note = capped(sorted(paths))
    result = {}
    for path in kept:
        try:
            info, record = described(path, None, config_detail)
            if stat.S_ISDIR(info.st_mode):
                record['postgres_version'] = postgres_version(path)
        except OSError as error:
            record = {FAILED: failure(error)}
        result[path] = record
    return noted(result, note)


def tool_version(argv):
    """The single child-process entry point, for the fixed TOOL_VERSIONS commands only."""
    if argv not in TOOL_VERSIONS.values():
        raise ValueError('command is outside the version allowlist')
    child_environment = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LC_ALL': 'C', 'HOME': os.environ.get('HOME', '/root')}
    try:
        done = subprocess.run(list(argv), stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                              timeout=TIMEOUT, env=child_environment, check=False)
    except (OSError, subprocess.SubprocessError) as error:
        return {FAILED: failure(error)}
    text = done.stdout.decode('utf-8', 'replace').strip()
    return {'exit': done.returncode, 'output': text if TOOL_OUTPUT.fullmatch(text) else redacted(text)}


def at(root, path):
    return os.path.join(root, path.lstrip('/'))


def optional_file(path, detail):
    try:
        _, record = described(path, None, detail)
    except FileNotFoundError:
        return {'present': False}
    except OSError as error:
        return {'present': None, FAILED: failure(error)}
    return {'present': True, **record}


def engine_version(get):
    version = get('/version')
    return {**selected(version, ('Version', 'ApiVersion', 'MinAPIVersion', 'Os', 'Arch', 'KernelVersion',
                                 'GoVersion', 'GitCommit')),
            'components': [selected(item, ('Name', 'Version')) for item in version.get('Components') or []]}


def engine_info(get):
    info = get('/info')
    return {**selected(info, ('ServerVersion', 'Driver', 'DriverStatus', 'DockerRootDir', 'OperatingSystem',
                              'OSVersion', 'OSType', 'KernelVersion', 'Architecture', 'NCPU', 'MemTotal',
                              'SecurityOptions', 'CgroupDriver', 'CgroupVersion', 'LiveRestoreEnabled',
                              'LoggingDriver', 'DefaultRuntime', 'InitBinary', 'Containers',
                              'ContainersRunning', 'ContainersPaused', 'ContainersStopped', 'Images')),
            'runtimes': sorted(info.get('Runtimes') or {}),
            'containerd_commit': (info.get('ContainerdCommit') or {}).get('ID'),
            'runc_commit': (info.get('RuncCommit') or {}).get('ID'),
            'swarm': (info.get('Swarm') or {}).get('LocalNodeState')}


def tools(root):
    """Versions and locations of the commands that the deployment tooling calls."""
    return {'versions': {name: tool_version(argv) for name, argv in sorted(TOOL_VERSIONS.items())},
            'paths': {name: shutil.which(name, path='/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin')
                      for name in TOOLS},
            'compose_plugins': {path: optional_file(at(root, path), None) for path in COMPOSE_PLUGINS},
            'daemon_config': optional_file(at(root, '/etc/docker/daemon.json'), marker_detail)}


def os_release(root):
    """Ubuntu links /etc/os-release to /usr/lib/os-release, and a final symlink is never followed."""
    failed = None
    for path in ('/etc/os-release', '/usr/lib/os-release'):
        try:
            data = read_file(at(root, path), 65536)
        except OSError as error:
            failed = error
            continue
        release = {}
        for line in data.decode('utf-8', 'replace').splitlines():
            name, _, value = line.partition('=')
            if name in ('ID', 'VERSION_ID', 'VERSION_CODENAME', 'PRETTY_NAME'):
                release[name] = value.strip('"\'')[:200]
        return release
    raise failed


def proc_field(root, path, prefix):
    for line in read_file(at(root, path), 4 * 1024 * 1024).decode('ascii', 'replace').splitlines():
        if line.startswith(prefix):
            return line.split()[1]
    raise ValueError('%s has no %s field' % (path, prefix.strip()))


def host_facts(root):
    """Operating system identity. One unreadable fact never hides the others."""
    system = os.uname()
    record = {'hostname': system.nodename, 'kernel': system.release, 'machine': system.machine,
              'system': system.sysname, 'python': platform.python_version(), 'effective_uid': os.geteuid(),
              'byte_order': sys.byteorder}
    for name, fact in (
            ('os_release', lambda: os_release(root)),
            ('machine_id_sha256', lambda: hashlib.sha256(read_file(at(root, '/etc/machine-id'), 4096).strip()).hexdigest()),
            ('boot_utc', lambda: utc(int(proc_field(root, '/proc/stat', 'btime ')))),
            ('umask', lambda: proc_field(root, '/proc/self/status', 'Umask:'))):
        try:
            record[name] = fact()
        except (OSError, ValueError) as error:
            record[name] = {FAILED: failure(error)}
    return record


def socket_address(text, byte_order=sys.byteorder):
    """Decode a /proc/net address such as 0100007F:0CEB, stored as host-order 32-bit words."""
    address, _, port = text.partition(':')
    raw = bytes.fromhex(address)
    if byte_order == 'little':
        raw = b''.join(raw[index:index + 4][::-1] for index in range(0, len(raw), 4))
    return str(ipaddress.ip_address(raw)), int(port, 16)


def listeners(root):
    """Listening TCP sockets and bound UDP sockets, from /proc/net. No process is inspected."""
    result = []
    for name, protocol in (('tcp', 'tcp'), ('tcp6', 'tcp'), ('udp', 'udp'), ('udp6', 'udp')):
        try:
            lines = read_file(at(root, '/proc/net/' + name), 8 * 1024 * 1024).decode('ascii', 'replace').splitlines()
        except FileNotFoundError:
            continue
        for line in lines[1:]:
            fields = line.split()
            if len(fields) < 8 or (protocol == 'tcp' and fields[3] != '0A'):
                continue
            address, port = socket_address(fields[1])
            result.append({'protocol': protocol, 'address': address, 'port': port, 'uid': int(fields[7])})
    unique = {json.dumps(item, sort_keys=True): item for item in result}
    kept, note = capped(sorted(unique.values(), key=lambda item: (item['protocol'], item['port'], item['address'])))
    return kept + note


def lock_holders(root, info):
    """Read /proc/locks for an inode. The lock itself is never requested."""
    target = (os.major(info.st_dev), os.minor(info.st_dev), info.st_ino)
    kinds = []
    for line in read_file(at(root, '/proc/locks'), 8 * 1024 * 1024).decode('ascii', 'replace').splitlines():
        fields = line.split()
        for field in fields:
            parts = field.split(':')
            try:
                found = len(parts) == 3 and (int(parts[0], 16), int(parts[1], 16), int(parts[2])) == target
            except ValueError:
                continue
            if found:
                kinds.append(fields[1:4])
    return kinds


def deploy_lock(directory, root):
    try:
        info = os.lstat('.caddy-deploy.lock', dir_fd=directory)
    except FileNotFoundError:
        return {'present': False, 'holders': []}
    try:
        return {'present': True, 'holders': lock_holders(root, info)}
    except (OSError, ValueError) as error:
        return {'present': True, 'holders': None, FAILED: failure(error)}


def deploy_processes(root):
    """Process identifiers that name deployment tooling. Command lines are not emitted."""
    result = []
    for name in sorted(os.listdir(at(root, '/proc'))):
        if not name.isdigit():
            continue
        try:
            raw = read_file(at(root, '/proc/%s/cmdline' % name), 1024 * 1024)
        except (OSError, ValueError):
            continue
        found = sorted({match.decode('ascii') for match in DEPLOY_PROCESS.findall(raw)})
        if found:
            result.append({'pid': int(name), 'scripts': found})
    return result


def bundle(directory, name):
    """Package identity of a staged or retained server bundle."""
    try:
        package = json.loads(read_file(name + '/package.json', 1024 * 1024, directory))
        return {key: public_text(package.get(key)) for key in ('name', 'version')}
    except (OSError, ValueError, AttributeError) as error:
        return {FAILED: failure(error)}


def deployment(path, root):
    """Top-level layout, configuration identities, markers and lock of the deployment directory."""
    directory = open_read(path, os.O_DIRECTORY)
    try:
        _, record = entry(path)
        result = {'path': path, 'root': record, **listing(directory, config_detail), 'markers': {}, 'bundles': {}}
        usage = os.statvfs(directory)
        result['filesystem'] = {'total_bytes': usage.f_blocks * usage.f_frsize,
                                'available_bytes': usage.f_bavail * usage.f_frsize}
        for item in result['entries']:
            name = item['name']
            if item.get('type') == 'dir' and MARKER.match(name):
                try:
                    result['markers'][name] = tree(name, marker_detail, directory)
                except OSError as error:
                    result['markers'][name] = {FAILED: failure(error)}
            elif item.get('type') == 'dir' and BUNDLE.fullmatch(name):
                result['bundles'][name] = bundle(directory, name)
            elif item.get('type') == 'dir' and name == 'pgdata':
                item['postgres_version'] = postgres_version(os.path.join(path, name))
        result['lock'] = deploy_lock(directory, root)
        return result
    finally:
        os.close(directory)


def neighbours(root, parent, prefix, skip):
    """Names beside the deployment, such as a canary or retained evidence. One level only."""
    result = {}
    try:
        directory = open_read(at(root, parent), os.O_DIRECTORY)
    except OSError as error:
        return {parent: {FAILED: failure(error)}}
    try:
        names, note = capped(sorted(name for name in os.listdir(directory) if name.startswith(prefix)))
        for name in names:
            if os.path.join(parent, name) == skip:
                continue
            try:
                info, record = entry(name, directory)
                if stat.S_ISDIR(info.st_mode):
                    child = open_read(name, os.O_DIRECTORY, directory)
                    try:
                        record.update(listing(child))
                    finally:
                        os.close(child)
            except OSError as error:
                record = {FAILED: failure(error)}
            result[os.path.join(parent, name)] = record
    finally:
        os.close(directory)
    return noted(result, note)


def partial_failures(value, path=''):
    """Every place where one object could not be read, so that none hides inside a section."""
    found = []
    if isinstance(value, dict):
        if FAILED in value:
            found.append({'at': path or '/', 'error': value[FAILED]})
        for name, item in value.items():
            found.extend(partial_failures(item, '%s/%s' % (path, name)))
    elif isinstance(value, list):
        for index, item in enumerate(value):
            found.extend(partial_failures(item, '%s/%d' % (path, index)))
    return found


def collect(deploy_dir=DEPLOY_DIR, get=None, root='/'):
    """Run every section. A failure is recorded and never stops the remaining sections."""
    started = time.monotonic()
    result = {'schema': SCHEMA, 'observed_utc': utc(time.time()), 'deploy_dir': deploy_dir}
    errors = []

    def section(name, function, *arguments):
        try:
            result[name] = function(*arguments)
        except Exception as error:  # Every failure is evidence; the inventory continues.
            result[name] = None
            errors.append({'section': name, 'error': failure(error)})
        return result[name]

    section('host', host_facts, root)
    section('engine_version', engine_version, get)
    section('engine_info', engine_info, get)
    section('tools', tools, root)
    containers = section('containers', lambda: inspected(
        get, get('/containers/json?all=true'), '/containers/%s/json', public_container, 'name'))
    section('images', lambda: inspected(get, get('/images/json'), '/images/%s/json', public_image, 'id'))
    section('networks', lambda: inspected(get, get('/networks'), '/networks/%s', public_network, 'name'))
    section('volumes', volumes, get, caddy_storage(containers or []))
    section('referenced_files', referenced_files, containers or [])
    section('deployment', deployment, deploy_dir, root)
    section('neighbours', lambda: {**neighbours(root, '/opt', 'dollhousemcp', deploy_dir),
                                   **neighbours(root, '/root', 'dollhousemcp', deploy_dir)})
    section('listeners', listeners, root)
    section('deploy_processes', deploy_processes, root)
    result['partial'] = partial_failures(result)
    result['errors'] = errors
    result['elapsed_seconds'] = round(time.monotonic() - started, 3)
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description='Print a read-only JSON inventory of a hosted deployment host.')
    parser.add_argument('--deploy-dir', default=DEPLOY_DIR, help='deployment directory (default: %(default)s)')
    parser.add_argument('--socket', default=SOCKET, help='Docker Engine socket (default: %(default)s)')
    parser.add_argument('--system-root', default='/', help='prefix for /proc, /etc, /opt and /root; for tests')
    options = parser.parse_args(argv)
    if not os.path.isabs(options.deploy_dir) or not os.path.isabs(options.socket):
        parser.error('paths must be absolute')
    result = collect(options.deploy_dir, engine(options.socket), options.system_root)
    print(json.dumps(result, indent=1, sort_keys=True))
    return 3 if result['errors'] or result['partial'] else 0


if __name__ == '__main__':
    raise SystemExit(main())
