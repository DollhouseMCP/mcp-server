#!/usr/bin/env python3
"""Check locally pulled digest references and the supported image-pair contract.

Image labels establish pair consistency, not provenance or security qualification.
"""
import importlib.util
import json
from pathlib import Path
import re
import sys

SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))
sys.dont_write_bytecode = True
from image_scan_intake import unique_object

spec = importlib.util.spec_from_file_location('registry_scanner_helpers', SCRIPTS / 'scan-built-image.py')
scanner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scanner)
REFERENCE = re.compile(r'[a-z0-9][a-z0-9.-]*(?::(?a:\d)+)?(?:/[a-z0-9]+(?:[._-][a-z0-9]+)*)+@sha256:[0-9a-f]{64}')
DIGEST = re.compile(r'sha256:[0-9a-f]{64}')
SOURCE = re.compile(r'[0-9a-f]{40}')
SOURCE_LABEL = 'org.dollhousemcp.engine-proof-source'


def native_platform(image, daemon):
    arch = {'x86_64': 'amd64', 'amd64': 'amd64', 'aarch64': 'arm64', 'arm64': 'arm64'}.get(daemon.get('Architecture'))
    if daemon.get('OSType') != 'linux' or arch is None or image.get('Os') != 'linux' or image.get('Architecture') != arch:
        raise ValueError('image platform does not match native Linux daemon')
    return arch


def image_identity(reference, image):
    if not REFERENCE.fullmatch(reference):
        raise ValueError('invalid digest reference')
    image_id = image.get('Id')
    if not isinstance(image_id, str) or not DIGEST.fullmatch(image_id):
        raise ValueError('invalid image identity')
    refs = image.get('RepoDigests')
    if not isinstance(refs, list) or refs.count(reference) != 1:
        raise ValueError('image does not have requested RepoDigest')
    return image_id


def validate_health(config, role):
    health = config.get('Healthcheck')
    if not isinstance(health, dict) or not isinstance(health.get('Test'), list):
        raise ValueError('image health contract is missing')
    if role == 'migration' and health['Test'] != ['NONE']:
        raise ValueError('migration health contract differs')
    if role == 'runtime' and (not health['Test'] or health['Test'][0] != 'CMD'):
        raise ValueError('runtime health contract differs')


def source_label(config, role):
    labels = config.get('Labels')
    if not isinstance(labels, dict) or not isinstance(labels.get(SOURCE_LABEL), str) or not SOURCE.fullmatch(labels[SOURCE_LABEL]):
        raise ValueError('image pair source label missing')
    if role == 'runtime' and labels.get('org.dollhousemcp.memory-upgrade-drain') != 'v2':
        raise ValueError('runtime drain contract missing')
    return labels[SOURCE_LABEL]


def image_profile(image, role):
    config = image.get('Config')
    if not isinstance(config, dict) or config.get('User') != '1001:1001' or config.get('WorkingDir') != '/app' or config.get('Entrypoint') not in (None, []):
        raise ValueError('unsupported image profile')
    command = ['node', '--trace-warnings', 'dist/index.js'] if role == 'runtime' else ['node', 'dist/cli/migrate-database.js']
    if config.get('Cmd') != command:
        raise ValueError('image role does not match')
    validate_health(config, role)
    return source_label(config, role)


def image_layers(image):
    rootfs = image.get('RootFS')
    if not isinstance(rootfs, dict) or rootfs.get('Type') != 'layers' or not isinstance(rootfs.get('Layers'), list) or not rootfs['Layers'] or any(not isinstance(x, str) or not DIGEST.fullmatch(x) for x in rootfs['Layers']):
        raise ValueError('invalid image layers')
    return rootfs['Layers']


def observe(reference, image, daemon, role):
    arch = native_platform(image, daemon)
    image_id = image_identity(reference, image)
    source = image_profile(image, role)
    return {'reference': reference, 'id': image_id, 'platform': 'linux/' + arch, 'source': source, 'layers': image_layers(image)}


def check_pair(runtime, migration, images, daemon):
    if runtime == migration or len(images) != 2:
        raise ValueError('distinct image roles are required')
    result = [observe(runtime, images[0], daemon, 'runtime'), observe(migration, images[1], daemon, 'migration')]
    if result[0]['source'] != result[1]['source']:
        raise ValueError('image pair source labels differ')
    return result


def docker_json(arguments):
    status, raw, _, error = scanner.bounded_process(['docker', *arguments], 10, 1024 * 1024, stderr_maximum=65536)
    if status != 0 or error:
        raise ValueError('Docker inspection failed')
    return json.loads(raw, object_pairs_hook=unique_object)


def main():
    if len(sys.argv) != 4 or sys.argv[1] not in ('prepare', 'inspect'):
        raise ValueError('invalid operation')
    operation, runtime, migration = sys.argv[1:]
    if not REFERENCE.fullmatch(runtime) or not REFERENCE.fullmatch(migration) or runtime == migration:
        raise ValueError('invalid references')
    if operation == 'prepare':
        for reference in (runtime, migration):
            status, _, _, error = scanner.bounded_process(['docker', 'pull', reference], 180, 1024 * 1024, stderr_maximum=65536)
            if status != 0 or error:
                raise ValueError('image pull failed')
    daemon = docker_json(['info', '--format', '{{json .}}'])
    images = []
    for reference in (runtime, migration):
        values = docker_json(['image', 'inspect', reference])
        if not isinstance(values, list) or len(values) != 1 or not isinstance(values[0], dict):
            raise ValueError('invalid image inspection')
        images.append(values[0])
    print(json.dumps(check_pair(runtime, migration, images, daemon), sort_keys=True, separators=(',', ':')))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('Registry image admission failed; replacement refused', file=sys.stderr)
        sys.exit(1)
