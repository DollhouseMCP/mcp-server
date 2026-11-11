#!/usr/bin/env python3
"""Turn a control file export into the private inputs build_replica.py needs.

export_control_files.py replaced every secret with a named placeholder. This
script, run on the replica, gives each placeholder a fresh random value that
exists nowhere else, writes the completed files to a private folder and writes
the inputs file: environment values, per-service environments from the Compose
overlays, and the content source for each deployment file.

    prepare_inputs.py INVENTORY.json CONTROL_DIR OUTPUT_DIR [KNOWN.json]

KNOWN.json maps a placeholder name to a value an operator knows is not secret,
such as a volume name the export hid as an opaque word. Every other
placeholder gets 32 random bytes, as base64 when its name ends in _KEY and as
hex otherwise: the forms the application requires of its keys and secrets.
Random values are kept in OUTPUT_DIR/secrets.json so a second run produces the
same files. Nothing is printed but a count per kind.
"""
import base64
import json
import os
from pathlib import Path
import re
import secrets
import sys

PLACEHOLDER = re.compile(r'__DOLLHOUSE_REPLICA_([A-Z0-9_]+?)__')


def private(path, data, mode=0o600):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    with os.fdopen(fd, 'wb') as stream:
        stream.write(data)
    os.chmod(path, mode)


def assignments(text):
    result = {}
    for line in text.split('\n'):
        match = re.match(r'(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)\Z', line.strip())
        if match and not line.lstrip().startswith('#'):
            value = match.group(2).strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in '"\'':
                value = value[1:-1]
            result[match.group(1)] = value
    return result


def prepare(inventory, control, output, known):
    store = output / 'secrets.json'
    values = json.loads(store.read_text(encoding='utf-8')) if store.exists() else {}
    manifest = json.loads((control / 'MANIFEST.json').read_text(encoding='utf-8'))
    counts = {'known': set(), 'random': set()}

    def value(match):
        name = match.group(1)
        if name in known:
            counts['known'].add(name)
            return known[name]
        counts['random'].add(name)
        if name not in values:
            raw = secrets.token_bytes(32)
            values[name] = base64.b64encode(raw).decode('ascii') if name.endswith('_KEY') else raw.hex()
        return values[name]

    root, files = inventory['deployment']['path'], {}
    for record in manifest['files']:
        text = PLACEHOLDER.sub(value, (control / record['path']).read_text(encoding='utf-8'))
        staged = output / 'files' / record['path']
        private(staged, text.encode('utf-8'), int(record['mode'], 8))
        files[root + '/' + record['path']] = str(staged)
    private(store, json.dumps(values, indent=1).encode('utf-8'))

    environment = {}
    for name in ('.env', '.env.production'):
        staged = output / 'files' / name
        if staged.exists():
            environment.update(assignments(staged.read_text(encoding='utf-8')))
    services = {}
    for container in inventory['containers']:
        labels = container['config'].get('labels') or {}
        service, configured = labels.get('com.docker.compose.service'), labels.get('com.docker.compose.project.config_files')
        if not isinstance(service, str) or not isinstance(configured, str):
            continue
        for path in configured.split(','):
            if path in files and path.endswith('.json'):
                overlay = json.loads(Path(files[path]).read_text(encoding='utf-8'))
                declared = ((overlay.get('services') or {}).get(service) or {}).get('environment')
                if isinstance(declared, dict):
                    services.setdefault(container['name'], {}).update({key: str(item) for key, item in declared.items()})
    inputs = {'environment': environment, 'container_environment': services, 'files': files}
    private(output / 'inputs.json', json.dumps(inputs, indent=1).encode('utf-8'))
    return {'schema': 1, 'kind': 'replica-inputs', 'files': len(files), 'environment_names': len(environment),
            'service_environments': sorted(services), 'placeholders_known': sorted(counts['known']),
            'placeholders_random': len(counts['random'])}


def main(argv):
    if len(argv) not in (4, 5):
        raise ValueError('usage: prepare_inputs.py INVENTORY.json CONTROL_DIR OUTPUT_DIR [KNOWN.json]')
    inventory = json.loads(Path(argv[1]).read_text(encoding='utf-8'))
    known = json.loads(Path(argv[4]).read_text(encoding='utf-8')) if len(argv) == 5 else {}
    print(json.dumps(prepare(inventory, Path(argv[2]), Path(argv[3]), known), indent=1))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
