#!/usr/bin/env python3
"""Turn a control file export into the private inputs build_replica.py needs.

export_control_files.py replaced every secret with a named placeholder. This
script, run on the replica, gives each placeholder a fresh random value that
exists nowhere else, writes the completed files to a private folder and writes
the inputs file: environment values, each service's environment and the
content source for each deployment file.

Run it in a private working folder that holds:

    inventory.json     the live inventory
    control-files/     the unpacked export
    known.json         optional: placeholder name -> a value an operator knows is
                       not secret, such as a volume name the export hid

    prepare_inputs.py

It writes prepared/files/, prepared/secrets.json and prepared/inputs.json.
Every other placeholder gets 32 random bytes, as base64 when its name ends in
_KEY and as hex otherwise: the forms the application requires of its keys and
secrets. Random values are kept in prepared/secrets.json so a second run
produces the same files.

A service's environment is what Docker Compose itself resolves from the
completed Compose files and environment file that the container's labels name.
When Compose cannot resolve them, the environment declared in the JSON overlays
is used instead and the report says so. Nothing is printed but names and counts.
"""
import base64
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import sys

INVENTORY, CONTROL, KNOWN, OUTPUT = 'inventory.json', 'control-files', 'known.json', 'prepared'
MANIFEST = 'MANIFEST.json'
PLACEHOLDER = re.compile(r'__DOLLHOUSE_REPLICA_([A-Z0-9_]+?)__')
ASSIGNMENT = re.compile(r'(?:export\s+)?([A-Za-z_]\w*)=(.*)\Z', re.ASCII)
PROJECT, SERVICE = 'com.docker.compose.project', 'com.docker.compose.service'
CONFIG_FILES, ENVIRONMENT_FILE = PROJECT + '.config_files', PROJECT + '.environment_file'


def private(path, data, mode=0o600):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    with os.fdopen(fd, 'wb') as stream:
        stream.write(data)
    os.chmod(path, mode)


def assignments(text):
    result = {}
    for line in text.split('\n'):
        match = None if line.lstrip().startswith('#') else ASSIGNMENT.match(line.strip())
        if match:
            value = match.group(2).strip()
            quoted = len(value) >= 2 and value[0] == value[-1] and value[0] in '"\''
            result[match.group(1)] = value[1:-1] if quoted else value
    return result


class Values:
    """The value of each placeholder: a known one, or a random one that is made once and kept."""

    def __init__(self, known, stored):
        self.known, self.stored, self.used_known, self.used_random = known, stored, set(), set()

    def __call__(self, match):
        name = match.group(1)
        if name in self.known:
            self.used_known.add(name)
            return self.known[name]
        self.used_random.add(name)
        if name not in self.stored:
            raw = secrets.token_bytes(32)
            self.stored[name] = base64.b64encode(raw).decode('ascii') if name.endswith('_KEY') else raw.hex()
        return self.stored[name]


def complete_files(control, output, modes, values):
    """Write every exported file with its placeholders completed. Paths come from the folder itself."""
    staged = {}
    for folder, _, names in sorted(os.walk(control)):
        for name in sorted(names):
            source = Path(folder) / name
            relative = source.relative_to(control).as_posix()
            if relative != MANIFEST:
                staged[relative] = output / 'files' / relative
                text = PLACEHOLDER.sub(values, source.read_text(encoding='utf-8'))
                private(staged[relative], text.encode('utf-8'), modes.get(relative, 0o600))
    return staged


def compose_model(project, files, environment_file, directory):
    """The model Docker Compose resolves from completed files, or None when it cannot."""
    command = ['/usr/bin/docker', 'compose', '--project-name', project, '--project-directory', str(directory)]
    if environment_file is not None:
        command += ['--env-file', str(environment_file)]
    for path in files:
        command += ['-f', str(path)]
    try:
        done = subprocess.run(command + ['config', '--format', 'json'], capture_output=True, check=False, timeout=60)
        return json.loads(done.stdout) if done.returncode == 0 else None
    except (OSError, subprocess.TimeoutExpired, ValueError):
        return None


def declared(service, files):
    """What the JSON overlays alone declare for a service: the fallback when Compose cannot resolve."""
    found = {}
    for path in files:
        if path.suffix == '.json':
            overlay = json.loads(path.read_text(encoding='utf-8'))
            found.update(((overlay.get('services') or {}).get(service) or {}).get('environment') or {})
    return (found, 'overlay') if found else None


def service_environment(labels, staged, root, directory, models):
    """One container's environment and where it came from, or None when its Compose files were not exported."""
    service, configured = labels.get(SERVICE), labels.get(CONFIG_FILES)
    if not isinstance(service, str) or not isinstance(configured, str):
        return None
    named = [path[len(root) + 1:] for path in configured.split(',') if path.startswith(root + '/')]
    files = [staged[path] for path in named if path in staged]
    if not files or len(files) != len(configured.split(',')):
        return declared(service, files)
    environment_file = staged.get(str(labels.get(ENVIRONMENT_FILE, ''))[len(root) + 1:])
    key = (labels.get(PROJECT), tuple(files), environment_file)
    if key not in models:
        models[key] = compose_model(labels.get(PROJECT) or 'replica', files, environment_file, directory)
    if models[key] is None:
        return declared(service, files)
    return ((models[key].get('services') or {}).get(service) or {}).get('environment') or {}, 'compose'


def prepare(inventory, control, output, known):
    store = output / 'secrets.json'
    values = Values(known, json.loads(store.read_text(encoding='utf-8')) if store.exists() else {})
    manifest = json.loads((control / MANIFEST).read_text(encoding='utf-8'))
    modes = {record['path']: int(record['mode'], 8) for record in manifest['files']}
    staged = complete_files(control, output, modes, values)
    private(store, json.dumps(values.stored, indent=1).encode('utf-8'))

    root, environment, services, sources, models = inventory['deployment']['path'], {}, {}, {}, {}
    for name in ('.env', '.env.production'):
        if name in staged:
            environment.update(assignments(staged[name].read_text(encoding='utf-8')))
    for container in inventory['containers']:
        found = service_environment(container['config'].get('labels') or {}, staged, root, output / 'files', models)
        if found is not None:
            services[container['name']] = {key: str(item) for key, item in found[0].items() if item is not None}
            sources[container['name']] = found[1]
    inputs = {'environment': environment, 'container_environment': services,
              'files': {root + '/' + relative: str(path) for relative, path in staged.items()}}
    private(output / 'inputs.json', json.dumps(inputs, indent=1).encode('utf-8'))
    return {'schema': 1, 'kind': 'replica-inputs', 'files': len(staged), 'environment_names': len(environment),
            'service_environments': dict(sorted(sources.items())), 'placeholders_known': sorted(values.used_known),
            'placeholders_random': len(values.used_random)}


def main(argv):
    if len(argv) != 1:
        raise ValueError('usage: prepare_inputs.py (no arguments; see the header for the working folder)')
    inventory = json.loads(Path(INVENTORY).read_text(encoding='utf-8'))
    known = json.loads(Path(KNOWN).read_text(encoding='utf-8')) if Path(KNOWN).exists() else {}
    print(json.dumps(prepare(inventory, Path(CONTROL), Path(OUTPUT), known), indent=1))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
