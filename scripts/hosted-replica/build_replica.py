#!/usr/bin/env python3
"""Build live-shaped Docker state on a throwaway replica host from a live inventory.

The inventory is the one live_inventory.py writes. This script replays it
against the local Docker Engine: the networks, the volumes with their folder
layout, the deployment files and every container with its recorded image,
command, labels, limits, mounts, network aliases and state. A rehearsal then
runs the real deploy tooling against a host that looks like production,
leftovers included.

It refuses to run anywhere but a declared replica:
- /etc/dollhouse-replica-host must hold the SHA-256 of this host's machine ID.
  An operator writes that file by hand on a host that may be destroyed.
- The inventory must describe a different host.
- The Engine must hold no container, volume or user network that an earlier
  run of this script did not create.

The inventory holds no secret and no file content. A private inputs file
supplies what it cannot:
  environment   values for environment names; a missing one gets a synthetic value
  overrides     environment name -> {"value", "reason"}: a setting the replica must
                not share with production, applied to every container; a null
                value leaves the variable out
  labels        values for labels the inventory redacted
  files         host path -> file to copy its content from; other files get filler
  trees         host folder -> folder to copy into it, with owners and modes kept
  images        live image ID -> local image to use instead, with a reason
  commands      container name -> {"cmd": [...], "reason": ...} for a stand-in command
  skip          container name -> reason
  package_name  the package name of the source bundles, which the inventory redacts
  database      {"container", "superuser", "name", "globals", "dump", "urls"}: once that
                container is healthy, restore the dump into it and give each role in
                a URL that URL's password
Every substitution is listed in the receipt on standard output. The inventory,
the inputs and the receipt hold host detail and stay on the replica.

    build_replica.py build INVENTORY.json INPUTS.json STATE.json
    build_replica.py destroy STATE.json

Exit status is 0 when every object reached its recorded state and 3 otherwise.
"""
import hashlib
import http.client
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import time
import urllib.parse

SOCKET = '/var/run/docker.sock'
DECLARATION = '/etc/dollhouse-replica-host'
BUILTIN_NETWORKS = ('bridge', 'host', 'none')
HEALTH_WAIT = 180
EXIT_WAIT = 60
HOST_KEYS = ('AutoRemove', 'Binds', 'CapAdd', 'CapDrop', 'CgroupnsMode', 'Dns', 'ExtraHosts', 'GroupAdd', 'Init',
             'IpcMode', 'Memory', 'NanoCpus', 'NetworkMode', 'PidMode', 'PidsLimit', 'PortBindings', 'Privileged',
             'ReadonlyRootfs', 'RestartPolicy', 'Runtime', 'SecurityOpt', 'Tmpfs', 'Ulimits', 'UsernsMode', 'VolumesFrom')


class Refused(Exception):
    pass


class Engine:
    """The local Docker Engine API. Paths are fixed by the caller, never by input."""

    def __init__(self, path=SOCKET):
        self.path = path

    def call(self, method, path, body=None, expect=(200, 201, 204)):
        connection = http.client.HTTPConnection('localhost', timeout=300)
        connection.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        connection.sock.settimeout(300)
        connection.sock.connect(self.path)
        try:
            payload = None if body is None else json.dumps(body).encode('utf-8')
            connection.request(method, path, payload, {'Content-Type': 'application/json'} if payload else {})
            response = connection.getresponse()
            raw = response.read()
        finally:
            connection.close()
        if response.status not in expect:
            # The receipt and this error stay on the replica, so the Engine's own message is kept.
            message = json.loads(raw).get('message', '') if raw[:1] == b'{' else ''
            raise RuntimeError('Engine %s %s answered %d: %s' % (method, path.split('?')[0], response.status, message[:300]))
        return json.loads(raw) if raw[:1] in (b'{', b'[') else None


def machine_identity():
    return hashlib.sha256(Path('/etc/machine-id').read_bytes()).hexdigest()


def guard(inventory, engine, state):
    """Refuse every host that is not a declared, otherwise empty replica."""
    identity = machine_identity()
    try:
        declared = Path(DECLARATION).read_text(encoding='ascii').split()
    except OSError:
        raise Refused('this host is not declared as a replica') from None
    if declared[:1] != [identity]:
        raise Refused('the replica declaration names another host')
    host = inventory.get('host') or {}
    if host.get('machine_id_sha256') == identity or host.get('hostname') == socket.gethostname():
        raise Refused('the inventory describes this host; a replica is never built on its own source')
    known = set(state['containers']) | set(state['volumes']) | set(state['networks'])
    foreign = [item['Names'][0] for item in engine.call('GET', '/containers/json?all=1') if item['Names'][0] not in known]
    foreign += [item['Name'] for item in engine.call('GET', '/volumes')['Volumes'] or [] if item['Name'] not in known]
    foreign += [item['Name'] for item in engine.call('GET', '/networks')
                if item['Name'] not in BUILTIN_NETWORKS and item['Name'] not in known]
    if foreign:
        raise Refused('the Engine holds %d objects this script did not create' % len(foreign))


def label_values(labels, inputs, note, owner, inherited=()):
    """Label values for one object. A redacted value the image does not supply becomes a stable identifier."""
    result = {}
    for key, value in (labels or {}).items():
        if not isinstance(value, dict):
            result[key] = value
        elif key in inherited:
            continue  # the image sets it; the container inherits the same value
        elif key in inputs['labels']:
            result[key] = inputs['labels'][key]
            note('label', owner + ' ' + key, 'supplied')
        else:
            # Redacted by the inventory. Tokens are hexadecimal, so the stand-in is too.
            length = int(value.get('length', 8))
            result[key] = (hashlib.sha256((owner + ' ' + key).encode('utf-8')).hexdigest() * (length // 64 + 1))[:length]
            note('label', owner + ' ' + key, 'synthetic')
    return result


def build_networks(inventory, inputs, engine, state, note):
    for network in inventory['networks']:
        name = network['name']
        if name in BUILTIN_NETWORKS or name in state['networks']:
            continue
        engine.call('POST', '/networks/create', {
            'Name': name, 'Driver': network['Driver'], 'Internal': network['Internal'],
            'Attachable': network['Attachable'], 'EnableIPv6': network['EnableIPv6'],
            'IPAM': {'Driver': network['ipam']['driver'],
                     'Config': [{key: value for key, value in item.items() if value} for item in network['ipam']['config']]},
            'Options': network.get('options') or {}, 'Labels': label_values(network.get('labels'), inputs, note, name)})
        state['networks'].append(name)


def content(path, entry, inputs, note):
    """A file's bytes: supplied content, or filler that a parser of that kind of file accepts."""
    source = inputs['files'].get(str(path))
    if source is not None:
        return Path(source).read_bytes()
    if isinstance(entry.get('env'), dict):
        # An environment file without supplied content: the recorded names, with no real value.
        note('file', str(path), 'filler with the recorded names')
        return ''.join('%s=%s\n' % (name, '' if name in entry['env'].get('empty', ()) else 'replica')
                       for name in entry['env'].get('names', ())).encode('utf-8')
    note('file', str(path), 'filler')
    return b'{}' if path.suffix == '.json' else b'\0' * int(entry.get('size', 0))


def write_tree(root, entries, inputs, note):
    """Folders and files with the recorded mode and owner. Shallow paths first."""
    for entry in sorted(entries, key=lambda item: item['path'].count('/')):
        path = Path(root) / entry['path']
        if entry['type'] == 'dir':
            path.mkdir(exist_ok=True)
        elif entry['type'] == 'file':
            path.write_bytes(content(path, entry, inputs, note))
        else:
            note('file', str(path), 'not created: ' + entry['type'])
            continue
        os.chown(path, entry['uid'], entry['gid'])
        os.chmod(path, int(entry['mode'], 8))


def build_volumes(inventory, inputs, engine, state, note):
    for volume in inventory['volumes']:
        name = volume['Name']
        if name in state['volumes']:
            continue
        created = engine.call('POST', '/volumes/create', {
            'Name': name, 'Driver': volume['Driver'], 'DriverOpts': volume.get('options') or {},
            'Labels': label_values(volume.get('labels'), inputs, note, name)})
        state['volumes'].append(name)
        root = volume.get('root')
        if isinstance(root, dict):
            os.chown(created['Mountpoint'], root['uid'], root['gid'])
            os.chmod(created['Mountpoint'], int(root['mode'], 8))
        tree = volume.get('tree')
        if isinstance(tree, dict):
            write_tree(created['Mountpoint'], tree.get('entries') or [], inputs, note)


def environment(record, inputs, note, image):
    names = record['config']['env']['names']
    public = record['config']['env'].get('public') or {}
    inherited = dict(item.split('=', 1) for item in image.get('Env') or [])
    own = inputs['container_environment'].get(record['name'], {})
    result = []
    for name in names:
        if name in inputs['overrides']:
            value = inputs['overrides'][name]['value']
            note('override', name, inputs['overrides'][name]['reason'])
            if value is None:
                continue
        elif name in own:
            value = own[name]
        elif name in public:
            value = public[name]
        elif name in inputs['environment']:
            value = inputs['environment'][name]
        elif name in inherited:
            value = inherited[name]
        else:
            value = 'replica-' + name.lower()
            note('environment', record['name'] + ' ' + name, 'synthetic')
        result.append('%s=%s' % (name, value))
    return result


def mounts(record):
    """Mounts the recorded bind list does not already express."""
    bound = {item.split(':')[1] for item in record['host_config'].get('Binds') or []}
    result = []
    for mount in record['mounts']:
        if mount['Destination'] in bound:
            continue
        item = {'Type': mount['Type'], 'Target': mount['Destination'], 'ReadOnly': not mount['RW'],
                'Source': mount['Name'] if mount['Type'] == 'volume' else mount['Source']}
        if mount['Type'] == 'bind' and mount.get('Propagation'):
            item['BindOptions'] = {'Propagation': mount['Propagation']}
        result.append(item)
    return result


def creation(record, inputs, note, engine, created):
    config, recorded = record['config'], record['host_config']
    image = record['image_id']
    if image in inputs['images']:
        note('image', record['name'], inputs['images'][image]['reason'])
        image = inputs['images'][image]['image']
    defaults = engine.call('GET', '/images/%s/json' % urllib.parse.quote(image))['Config']
    reference = record.get('image_reference')
    if reference and reference != image and image == record['image_id']:
        named = engine.call('GET', '/images/%s/json' % urllib.parse.quote(reference, safe=''), expect=(200, 404))
        if named and named.get('Id') == image:
            image = reference  # create by the same name the live container was created by
    command = config['cmd']
    if record['name'] in inputs['commands']:
        note('command', record['name'], inputs['commands'][record['name']]['reason'])
        command = inputs['commands'][record['name']]['cmd']
    host = {key: recorded[key] for key in HOST_KEYS if recorded.get(key) is not None}
    host['LogConfig'] = {'Type': recorded.get('log_driver') or 'json-file'}
    if host.get('NetworkMode', '').startswith('container:'):
        # The recorded mode names a live container ID. Join the replica's container of the same name.
        host['NetworkMode'] = 'container:' + created[host['NetworkMode'].split(':', 1)[1]]
    host['Mounts'] = mounts(record)
    health = config.get('healthcheck')
    body = {'Image': image, 'Cmd': command, 'Entrypoint': config['entrypoint'],
            'Env': environment(record, inputs, note, defaults),
            'ExposedPorts': {port: {} for port in config.get('exposed_ports') or []},
            'Labels': label_values(config.get('labels'), inputs, note, record['name'], defaults.get('Labels') or {}),
            'User': config.get('user') or '',
            'WorkingDir': config.get('working_dir') or '', 'Volumes': {path: {} for path in config.get('volumes') or []},
            'HostConfig': host,
            'NetworkingConfig': {'EndpointsConfig': {
                name: {'Aliases': list(dict.fromkeys(endpoint['Aliases']))} if endpoint.get('Aliases') else {}
                for name, endpoint in record['networks'].items()}}}
    if host.get('NetworkMode', '').startswith('container:'):
        # A container that joins another's network has no ports or endpoints of its own.
        del body['ExposedPorts'], body['NetworkingConfig']
    if config.get('stop_signal'):
        body['StopSignal'] = config['stop_signal']
    if health:
        body['Healthcheck'] = {'Test': health['test'], **{key: health[key] for key in (
            'Interval', 'Timeout', 'Retries', 'StartPeriod', 'StartInterval') if health.get(key) is not None}}
    return body


def settle(engine, identifier, record, note):
    """Bring a created container to its recorded state. Returns what it reached.

    A container recorded as exited is started and left to finish. One that keeps
    running, such as a retained proxy, is stopped the way an operator stops it.
    """
    wanted = record['state']
    if wanted['Status'] == 'created':
        return 'created'
    engine.call('POST', '/containers/%s/start' % identifier, expect=(204, 304))
    health = record.get('health')
    health = health.get('Status') if isinstance(health, dict) else health
    deadline = time.monotonic() + (HEALTH_WAIT if wanted['Running'] else EXIT_WAIT)
    while True:
        state = engine.call('GET', '/containers/%s/json' % identifier)['State']
        reached = state['Status'] + ('' if state['Running'] else ' %d' % state['ExitCode'])
        if wanted['Running'] and state['Running'] and (health != 'healthy' or (state.get('Health') or {}).get('Status') == 'healthy'):
            return reached
        if not wanted['Running'] and not state['Running']:
            return reached
        if not wanted['Running'] and time.monotonic() > deadline:
            engine.call('POST', '/containers/%s/stop?t=20' % identifier, expect=(204, 304))
            note('container', record['name'], 'stopped by the builder after it kept running')
            deadline = float('inf')
        elif (wanted['Running'] and not state['Running'] and not state.get('Restarting')) or time.monotonic() > deadline:
            return reached + ' (not the recorded state)'
        time.sleep(1)


def database_command(identifier, program, superuser, source):
    """Run psql or pg_restore inside the database container, over its local socket, reading a file or SQL."""
    command = ['/usr/bin/docker', 'exec', '--interactive', identifier, program, '--username', superuser, '--dbname', 'postgres']
    command += ['--no-psqlrc', '--quiet'] if program == 'psql' else ['--exit-on-error', '--create']
    if isinstance(source, bytes):
        return subprocess.run(command, input=source, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False).returncode
    with open(source, 'rb') as stream:
        return subprocess.run(command, stdin=stream, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False).returncode


def restore_database(identifier, spec):
    """Replace the freshly initialised database with the dump. Passwords travel on standard input only."""
    superuser, name = spec['superuser'], spec['name']
    if not all(part.replace('_', '').isalnum() for part in (superuser, name)):
        raise ValueError('unsupported database or role name')
    steps = [('psql', ('DROP DATABASE IF EXISTS "%s" WITH (FORCE);\n' % name).encode('ascii')),
             ('psql', spec['globals']),  # roles that already exist report an error and are then altered
             ('pg_restore', spec['dump'])]
    codes = [database_command(identifier, program, superuser, source) for program, source in steps]
    for url in spec['urls']:
        parsed = urllib.parse.urlsplit(url)
        if not parsed.username.replace('_', '').isalnum() or "'" in parsed.password or '\\' in parsed.password:
            raise ValueError('unsupported role or password in a database URL')
        sql = "ALTER ROLE \"%s\" PASSWORD '%s';\n" % (parsed.username, parsed.password)
        codes.append(database_command(identifier, 'psql', superuser, b'\\set ON_ERROR_STOP on\n' + sql.encode('utf-8')))
    return {'drop': codes[0], 'globals': codes[1], 'restore': codes[2], 'passwords': codes[3:]}


def build_containers(inventory, inputs, engine, state, note):
    results = {}
    names = {record['id']: record['name'] for record in inventory['containers']}
    for record in sorted(inventory['containers'], key=lambda item: item['created']):
        name = record['name']
        if name in inputs['skip']:
            note('container', name, 'skipped: ' + inputs['skip'][name])
            continue
        if name not in state['containers']:
            created = engine.call('POST', '/containers/create?name=' + urllib.parse.quote(name[1:]),
                                  creation(record, inputs, note, engine, {
                                      live: state['containers'].get(name) for live, name in names.items()}))
            state['containers'][name] = created['Id']
        wanted = record['state']
        expected = wanted['Status'] + ('' if wanted['Running'] else ' %d' % wanted['ExitCode'])
        reached = settle(engine, state['containers'][name], record, note)
        results[name] = {'recorded': expected, 'reached': reached}
        database = inputs['database']
        if database.get('container') == name and reached == expected and not state.get('database'):
            state['database'] = restore_database(state['containers'][name], database)
            results[name]['database'] = state['database']
    return results


def load(path, default=None):
    try:
        with open(path, encoding='utf-8') as stream:
            return json.load(stream)
    except FileNotFoundError:
        if default is None:
            raise
        return default


def save(path, value):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    with os.fdopen(fd, 'w', encoding='utf-8') as stream:
        json.dump(value, stream, indent=1)


def claim(path, state):
    """Create a folder this build owns. A folder that already exists is only ever one an earlier run claimed."""
    if str(path) not in state['files']:
        if path.exists():
            raise Refused('a folder this build must create already exists')
        path.mkdir(parents=True, mode=0o700)
        state['files'].append(str(path))


def bundle_packages(root, bundles, inputs, note):
    """An empty bundle folder still names its package, as the inventory reads it."""
    for name, bundle in (bundles or {}).items():
        package = root / name / 'package.json'
        if isinstance(bundle, dict) and bundle.get('name') and (root / name).is_dir() and not package.exists():
            named = bundle['name'] if isinstance(bundle['name'], str) else inputs['package_name'] or 'replica'
            package.write_text(json.dumps({'name': named, 'version': bundle.get('version')}), encoding='utf-8')
            note('file', str(package), 'filler naming the recorded package')


def referenced_files(inventory, inputs, state, note):
    """Files that containers mount from deeper or other folders."""
    for path, record in sorted((inventory.get('referenced_files') or {}).items()):
        if isinstance(record, dict) and 'type' in record and not Path(path).exists():
            missing = Path(path).parent
            while not missing.parent.exists():
                missing = missing.parent
            if not missing.exists():
                claim(missing, state)
            Path(path).parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            write_tree('/', [dict(record, path=path.lstrip('/'))], inputs, note)


def named_entries(entries):
    return [dict(entry, path=entry['name']) for entry in entries or [] if 'type' in entry]


def build_files(inventory, inputs, state, note):
    deployment = inventory['deployment']
    root = Path(deployment['path'])
    claim(root, state)
    os.chown(root, deployment['root']['uid'], deployment['root']['gid'])
    os.chmod(root, int(deployment['root']['mode'], 8))
    write_tree(root, named_entries(deployment['entries']), inputs, note)
    bundle_packages(root, deployment.get('bundles'), inputs, note)
    for marker, tree in (deployment.get('markers') or {}).items():
        write_tree(root / marker, tree.get('entries') or [], inputs, note)
    for path, neighbour in (inventory.get('neighbours') or {}).items():
        claim(Path(path), state)
        if 'mode' in neighbour:
            os.chown(path, neighbour['uid'], neighbour['gid'])
            os.chmod(path, int(neighbour['mode'], 8))
        write_tree(path, named_entries(neighbour.get('entries')), inputs, note)
    referenced_files(inventory, inputs, state, note)
    for target, source in sorted(inputs['trees'].items()):
        subprocess.run(['/usr/bin/cp', '--archive', '--no-target-directory', source, target], check=True)
        note('tree', target, 'copied from a supplied folder')


def build(inventory_path, inputs_path, state_path):
    inventory = load(inventory_path)
    inputs = {key: {} for key in ('environment', 'container_environment', 'labels', 'files', 'images', 'commands',
                                  'skip', 'database', 'trees', 'overrides')}
    inputs['package_name'] = None
    inputs.update(load(inputs_path))
    state = load(state_path, {'containers': {}, 'volumes': [], 'networks': [], 'files': []})
    engine, substitutions = Engine(), []

    def note(kind, subject, what):
        substitutions.append({'kind': kind, 'subject': subject, 'what': what})

    guard(inventory, engine, state)
    try:
        build_networks(inventory, inputs, engine, state, note)
        build_volumes(inventory, inputs, engine, state, note)
        build_files(inventory, inputs, state, note)
        containers = build_containers(inventory, inputs, engine, state, note)
    finally:
        save(state_path, state)
    restored = state.get('database') or {}
    complete = (all(item['recorded'] == item['reached'] for item in containers.values())
                and not restored.get('drop') and not restored.get('restore') and not any(restored.get('passwords') or []))
    return {'schema': 1, 'kind': 'replica-build', 'host': socket.gethostname(), 'containers': containers,
            'substitutions': substitutions, 'complete': complete}


def destroy(state_path):
    state, engine = load(state_path), Engine()
    for identifier in state['containers'].values():
        engine.call('DELETE', '/containers/%s?force=1&v=0' % identifier, expect=(204, 404))
    for name in state['volumes']:
        engine.call('DELETE', '/volumes/' + urllib.parse.quote(name), expect=(204, 404))
    for name in state['networks']:
        engine.call('DELETE', '/networks/' + urllib.parse.quote(name), expect=(204, 404))
    for path in state['files']:
        shutil.rmtree(path, ignore_errors=True)
    save(state_path, {'containers': {}, 'volumes': [], 'networks': [], 'files': []})
    return {'schema': 1, 'kind': 'replica-destroy', 'removed_folders': len(state['files'])}


def main(argv):
    try:
        if len(argv) == 5 and argv[1] == 'build':
            report = build(*argv[2:])
        elif len(argv) == 3 and argv[1] == 'destroy':
            if machine_identity() not in Path(DECLARATION).read_text(encoding='ascii').split()[:1]:
                raise Refused('the replica declaration names another host')
            report = destroy(argv[2])
        else:
            raise ValueError('usage: build_replica.py build INVENTORY INPUTS STATE | destroy STATE')
    except Refused as error:
        print(json.dumps({'refused': str(error)}))
        return 3
    print(json.dumps(report, indent=1))
    return 0 if report.get('complete', True) else 3


if __name__ == '__main__':
    sys.exit(main(sys.argv))
